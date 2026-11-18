import { randomUUID } from 'node:crypto';
import { LOGIN_HINT, StockbitMcpError, TRADING_LOGIN_HINT } from './errors.js';
import { toHttpError, type Host, type TokenProvider } from './http.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import type { Logger } from './logger.js';
import type { Session, SessionStore, StoredToken } from './session-store.js';

// What the Stockbit desktop app 2.9.0 sends on every call (buildApiInstance in its main bundle;
// unchanged since 2.7.4 apart from the version).
export const APP_VERSION = '2.9.0';
export const DEFAULT_HEADERS: Record<string, string> = {
  'X-Platform': 'desktop',
  'X-AppVersion': APP_VERSION,
};

export interface AuthServiceOptions {
  store: SessionStore;
  bases: Record<Host, string>;
  logger: Logger;
  timeoutMs: number;
  fetch?: typeof fetch;
  now?: () => number;
}

// The answer of POST /login/v6/username.
export type PasswordLoginStep =
  | { kind: 'done'; session: Session }
  // A new device: Stockbit pushes an approval prompt to a device already trusted (the phone app).
  | { kind: 'trusted_device'; loginToken: string; deviceName?: string }
  // A new device without a trusted one: the verification challenges (OTP, PIN, …).
  | { kind: 'multi_factor'; loginToken: string; verificationToken: string };

export type PromptStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface SessionStatus {
  exodus: { loggedIn: boolean; username?: string; userId?: string; accessExpiresAt?: string };
  trading: { loggedIn: boolean; accessExpiresAt?: string; accountType?: string };
  path: string;
}

function str(value: JsonValue | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function obj(value: JsonValue | undefined): JsonObject | undefined {
  return isJsonObject(value) ? value : undefined;
}

function tokenOf(value: JsonValue | undefined): StoredToken | undefined {
  const o = obj(value);
  const token = str(o?.token);
  if (!token) {
    return undefined;
  }
  const expiresAt = str(o?.expired_at);
  return expiresAt ? { token, expiresAt } : { token };
}

// The exodus auth object comes in two shapes: nested under login.token_data (direct login) or flat
// (new-device verify, refresh). Both carry { access: {token, expired_at}, refresh: {...} }.
export function parseExodusAuth(data: JsonValue): {
  access: StoredToken;
  refresh?: StoredToken;
  userId?: string;
  username?: string;
} | null {
  const root = obj(data);
  const login = obj(root?.login);
  const holder = obj(login?.token_data) ?? root;
  const access = tokenOf(holder?.access);
  if (!access) {
    return null;
  }
  const user = obj(login?.user) ?? obj(root?.user);
  const refresh = tokenOf(holder?.refresh);
  const id = user?.id;
  const userId = typeof id === 'number' ? String(id) : str(id);
  const username = str(user?.username);
  return {
    access,
    ...(refresh ? { refresh } : {}),
    ...(userId ? { userId } : {}),
    ...(username ? { username } : {}),
  };
}

// carina answers in snake_case: { access_token, refresh_token, account: { number, type } }. The
// account number is personal and stays out of the session file; the type tells regular from margin.
export function parseTradingAuth(data: JsonValue): {
  access: StoredToken;
  refresh?: StoredToken;
  accountType?: string;
} | null {
  const root = obj(data);
  const access = str(root?.access_token);
  if (!access) {
    return null;
  }
  const refresh = str(root?.refresh_token);
  const type = obj(root?.account)?.type;
  return {
    access: { token: access, ...jwtExpiry(access) },
    ...(refresh ? { refresh: { token: refresh, ...jwtExpiry(refresh) } } : {}),
    ...(typeof type === 'string' || typeof type === 'number' ? { accountType: String(type) } : {}),
  };
}

// carina tokens are JWTs without an expired_at beside them; their exp claim is the expiry.
export function jwtExpiry(token: string): { expiresAt?: string } {
  const part = token.split('.')[1];
  if (!part) {
    return {};
  }
  try {
    const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? { expiresAt: new Date(payload.exp * 1000).toISOString() } : {};
  } catch {
    return {};
  }
}

export class AuthService implements TokenProvider {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  // One refresh at a time per tier; callers that hit a 401 meanwhile wait for the same result.
  private readonly inflight = new Map<'exodus' | 'trading', Promise<boolean>>();

  constructor(private readonly options: AuthServiceOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async token(kind: 'exodus' | 'trading'): Promise<string | undefined> {
    const session = await this.options.store.read();
    return kind === 'exodus' ? session.exodus?.access.token : session.trading?.access.token;
  }

  async refresh(kind: 'exodus' | 'trading', rejected: string): Promise<boolean> {
    const running = this.inflight.get(kind);
    if (running) {
      return running;
    }
    const job = this.doRefresh(kind, rejected).finally(() => this.inflight.delete(kind));
    this.inflight.set(kind, job);
    return job;
  }

  private async doRefresh(kind: 'exodus' | 'trading', rejected: string): Promise<boolean> {
    const session = await this.options.store.read();
    const tier = kind === 'exodus' ? session.exodus : session.trading;
    // Another call refreshed already: retry with the token that is there now.
    if (tier && tier.access.token !== rejected) {
      return true;
    }
    const refreshToken = tier?.refresh?.token;
    if (!refreshToken) {
      return false;
    }
    try {
      const host: Host = kind === 'exodus' ? 'exodus' : 'carina';
      const path = kind === 'exodus' ? '/login/refresh' : '/auth/refresh';
      const data = await this.post(host, path, undefined, refreshToken);
      const latest = await this.options.store.read();
      const savedAt = new Date(this.now()).toISOString();
      if (kind === 'exodus') {
        const auth = parseExodusAuth(data);
        if (!auth || !latest.exodus) {
          return false;
        }
        await this.options.store.write({
          ...latest,
          exodus: {
            ...latest.exodus,
            access: auth.access,
            ...(auth.refresh ? { refresh: auth.refresh } : {}),
            savedAt,
          },
        });
      } else {
        const auth = parseTradingAuth(data);
        if (!auth) {
          return false;
        }
        await this.options.store.write({
          ...latest,
          trading: {
            access: auth.access,
            ...(auth.refresh ? { refresh: auth.refresh } : {}),
            ...(auth.accountType ? { accountType: auth.accountType } : {}),
            savedAt,
          },
        });
      }
      this.options.logger.info('session refreshed', { tier: kind });
      return true;
    } catch (error) {
      this.options.logger.warn('session refresh failed', { tier: kind, error: (error as Error).message });
      return false;
    }
  }

  async status(): Promise<SessionStatus> {
    const s = await this.options.store.read();
    return {
      exodus: {
        loggedIn: Boolean(s.exodus),
        ...(s.exodus?.username ? { username: s.exodus.username } : {}),
        ...(s.exodus?.userId ? { userId: s.exodus.userId } : {}),
        ...(s.exodus?.access.expiresAt ? { accessExpiresAt: s.exodus.access.expiresAt } : {}),
      },
      trading: {
        loggedIn: Boolean(s.trading),
        ...(s.trading?.access.expiresAt ? { accessExpiresAt: s.trading.access.expiresAt } : {}),
        ...(s.trading?.accountType ? { accountType: s.trading.accountType } : {}),
      },
      path: this.options.store.path,
    };
  }

  // ---- Login (used by the CLI) ------------------------------------------------------------------

  async deviceId(): Promise<string> {
    const session = await this.options.store.read();
    if (session.deviceId) {
      return session.deviceId;
    }
    const deviceId = randomUUID();
    await this.options.store.write({ ...session, deviceId });
    return deviceId;
  }

  async passwordLogin(user: string, password: string): Promise<PasswordLoginStep> {
    const playerId = await this.deviceId();
    const data = await this.post('exodus', '/login/v6/username', { user, password, player_id: playerId });
    const auth = parseExodusAuth(data);
    if (auth) {
      return { kind: 'done', session: await this.saveExodus(auth) };
    }
    const newDevice = obj(obj(data)?.new_device);
    const trusted = obj(newDevice?.trusted_device);
    const loginToken = str(trusted?.login_token);
    if (loginToken) {
      const deviceName = str(trusted?.device_name);
      return { kind: 'trusted_device', loginToken, ...(deviceName ? { deviceName } : {}) };
    }
    const mfa = obj(newDevice?.multi_factor);
    const mfaLogin = str(mfa?.login_token);
    const verificationToken = str(mfa?.verification_token);
    if (mfaLogin && verificationToken) {
      return { kind: 'multi_factor', loginToken: mfaLogin, verificationToken };
    }
    throw new StockbitMcpError('LOGIN_FAILED', 'Stockbit answered the login in a way this version does not know.');
  }

  async sendPrompt(loginToken: string): Promise<string> {
    const data = await this.post('exodus', '/login/v4/new-device/prompt/send', { token: loginToken });
    const promptToken = str(obj(data)?.prompt_token);
    if (!promptToken) {
      throw new StockbitMcpError('LOGIN_FAILED', 'Stockbit did not start the device approval.');
    }
    return promptToken;
  }

  async pollPrompt(promptToken: string): Promise<{ status: PromptStatus; acknowledgeToken?: string }> {
    const data = obj(
      await this.get('exodus', '/mfa/v1/prompt/verified/result', { token: promptToken }),
    );
    const raw = str(data?.status) ?? 'PROMPT_STATUS_UNSPECIFIED';
    const ack = str(data?.acknowledge_token);
    const status: PromptStatus = raw.endsWith('APPROVED')
      ? 'approved'
      : raw.endsWith('REJECTED')
        ? 'rejected'
        : raw.endsWith('EXPIRED')
          ? 'expired'
          : 'pending';
    return { status, ...(ack ? { acknowledgeToken: ack } : {}) };
  }

  async verifyPrompt(loginToken: string, acknowledgeToken: string): Promise<Session> {
    const data = await this.post('exodus', '/login/v4/new-device/prompt/verify', {
      token: loginToken,
      acknowledge_token: acknowledgeToken,
    });
    return this.finishExodus(data);
  }

  async requestOtp(loginToken: string, channel: 'CHANNEL_SMS' | 'CHANNEL_WHATSAPP' | 'CHANNEL_EMAIL') {
    await this.post('exodus', '/login/v3/new-device/otp', { token: loginToken, channel });
  }

  async verifyOtp(loginToken: string, otp: string): Promise<Session> {
    const data = await this.post('exodus', '/login/v3/new-device/otp/verify', { otp, token: loginToken });
    return this.finishExodus(data);
  }

  // The verification engine for multi_factor logins. Each step answers the next challenge.
  async startChallenge(verificationToken: string): Promise<{ next: string; channels: string[] }> {
    const data = await this.post(
      'exodus',
      '/mfa/verification/v1/challenge/start',
      {
        verification_token: verificationToken,
        supported_challenges: ['PIN', 'PASSWORD', 'OTP', 'FINISHED'],
      },
      undefined,
      { 'Accept-Language': 'EN' },
    );
    return challengeOf(data);
  }

  async challengeSendOtp(verificationToken: string, channel: string) {
    const data = await this.post(
      'exodus',
      '/mfa/verification/v1/challenge/otp/send',
      { verification_token: verificationToken, channel },
      undefined,
      { 'Accept-Language': 'EN' },
    );
    return challengeOf(data);
  }

  async challengeVerify(verificationToken: string, kind: 'otp' | 'pin', value: string) {
    const data = await this.post(
      'exodus',
      `/mfa/verification/v1/challenge/${kind}/verify`,
      { verification_token: verificationToken, [kind]: value },
      undefined,
      { 'Accept-Language': 'EN' },
    );
    return challengeOf(data);
  }

  async finishMultiFactor(loginToken: string): Promise<Session> {
    const data = await this.post('exodus', '/login/v6/new-device/verify', {
      multi_factor: { login_token: loginToken },
    });
    return this.finishExodus(data);
  }

  // A token pasted by the user (from a logged-in browser or the desktop app).
  async saveManualTokens(access: string, refresh?: string): Promise<Session> {
    return this.saveExodus({
      access: { token: access, ...jwtExpiry(access) },
      ...(refresh ? { refresh: { token: refresh, ...jwtExpiry(refresh) } } : {}),
    });
  }

  async tradingLogin(pin: string): Promise<Session> {
    const tokenData = obj(await this.get('exodus', '/sekuritas/auth/token'));
    const loginToken = str(tokenData?.token);
    if (!loginToken) {
      throw new StockbitMcpError('LOGIN_FAILED', 'Stockbit did not hand out a trading login token.');
    }
    const data = await this.post('carina', '/auth/v2/login', { login_token: loginToken, pin }, undefined);
    const saved = await this.saveTradingLogin(data);
    if (!saved) {
      throw new StockbitMcpError('LOGIN_FAILED', 'Stockbit did not return a trading session.');
    }
    return saved;
  }

  // Saves the session carina's /auth/v2/login answered with; null when the answer holds none.
  private async saveTradingLogin(data: JsonValue): Promise<Session | null> {
    const auth = parseTradingAuth(data);
    if (!auth) {
      return null;
    }
    const session = await this.options.store.read();
    const next: Session = {
      ...session,
      trading: {
        access: auth.access,
        ...(auth.refresh ? { refresh: auth.refresh } : {}),
        ...(auth.accountType ? { accountType: auth.accountType } : {}),
        savedAt: new Date(this.now()).toISOString(),
      },
    };
    await this.options.store.write(next);
    return next;
  }

  async logout(scope: 'all' | 'trading'): Promise<void> {
    if (scope === 'all') {
      const { deviceId } = await this.options.store.read();
      await this.options.store.write({ version: 1, ...(deviceId ? { deviceId } : {}) });
      return;
    }
    const session = await this.options.store.read();
    delete session.trading;
    await this.options.store.write(session);
  }

  private async finishExodus(data: JsonValue): Promise<Session> {
    const auth = parseExodusAuth(data);
    if (!auth) {
      throw new StockbitMcpError('LOGIN_FAILED', 'Stockbit did not return a session.');
    }
    return this.saveExodus(auth);
  }

  private async saveExodus(auth: NonNullable<ReturnType<typeof parseExodusAuth>>): Promise<Session> {
    const session = await this.options.store.read();
    const next: Session = {
      ...session,
      exodus: {
        access: auth.access,
        ...(auth.refresh ? { refresh: auth.refresh } : {}),
        ...(auth.userId ? { userId: auth.userId } : {}),
        ...(auth.username ? { username: auth.username } : {}),
        savedAt: new Date(this.now()).toISOString(),
      },
    };
    // A new exodus login invalidates the trading session derived from the old one.
    delete next.trading;
    await this.options.store.write(next);
    return next;
  }

  // ---- Plain requests for the auth flow (outside StockbitHttp, which depends on this class) -----

  private async get(host: Host, path: string, query?: Record<string, string>): Promise<JsonValue> {
    const qs = query ? `?${new URLSearchParams(query).toString()}` : '';
    const bearer = await this.token('exodus');
    if (!bearer) {
      throw new StockbitMcpError('AUTH_REQUIRED', 'No saved Stockbit session.', { hint: LOGIN_HINT });
    }
    return this.send(host, 'GET', `${path}${qs}`, undefined, bearer, {});
  }

  private async post(
    host: Host,
    path: string,
    body: unknown,
    bearer?: string,
    extraHeaders: Record<string, string> = {},
  ): Promise<JsonValue> {
    // Login calls before a session exists go without a bearer; carina /auth/v2/login takes none.
    return this.send(host, 'POST', path, body, bearer, extraHeaders);
  }

  private async send(
    host: Host,
    method: 'GET' | 'POST',
    pathAndQuery: string,
    body: unknown,
    bearer: string | undefined,
    extraHeaders: Record<string, string>,
  ): Promise<JsonValue> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...DEFAULT_HEADERS,
      ...extraHeaders,
    };
    if (bearer) {
      headers.Authorization = `Bearer ${bearer}`;
    }
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.options.timeoutMs) };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await this.fetchImpl(`${this.options.bases[host]}${pathAndQuery}`, init);
    const text = await res.text();
    let parsed: JsonValue = text;
    try {
      parsed = text ? (JSON.parse(text) as JsonValue) : null;
    } catch {
      // Not JSON: a Cloudflare page or a proxy error; toHttpError reads it as text.
    }
    if (!res.ok) {
      const error = toHttpError(res, parsed, host === 'carina' ? 'trading' : 'exodus', pathAndQuery);
      // Login paths sit behind a Cloudflare challenge that only a browser can pass; waiting does
      // not help there, logging in on the web does.
      if (res.headers.get('cf-mitigated')?.includes('challenge') || error.code === 'BLOCKED') {
        throw new StockbitMcpError('BLOCKED', 'Cloudflare asked for a browser challenge on this login.', {
          hint:
            'Log in on stockbit.com in a browser, then run `stockbit-mcp login --token` and paste the ' +
            'tokens (see the README).',
          details: error.details ?? {},
        });
      }
      if (host === 'carina' && error.code === 'TRADING_AUTH_REQUIRED') {
        throw new StockbitMcpError('LOGIN_FAILED', error.message, { hint: TRADING_LOGIN_HINT });
      }
      throw error;
    }
    return isJsonObject(parsed) && 'data' in parsed ? (parsed.data ?? null) : parsed;
  }
}

function challengeOf(data: JsonValue): { next: string; channels: string[] } {
  const o = obj(data);
  const otp = obj(obj(o?.supporting_data)?.otp);
  const channels = Array.isArray(otp?.channels)
    ? otp.channels.filter((c): c is string => typeof c === 'string')
    : [];
  return { next: str(o?.next_challenge) ?? 'CHALLENGE_UNSPECIFIED', channels };
}
