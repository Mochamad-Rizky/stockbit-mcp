import { isStockbitMcpError, LOGIN_HINT, StockbitMcpError, TRADING_LOGIN_HINT } from './errors.js';
import type { JsonValue } from './json.js';
import type { Logger } from './logger.js';

// exodus serves market data, social and the account; carina (sekuritas trading v2) serves the
// brokerage account and orders; sekuritas serves smart orders.
export type Host = 'exodus' | 'carina' | 'sekuritas';
export type AuthKind = 'exodus' | 'trading' | 'none';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type QueryScalar = string | number | boolean;
export type QueryValue = QueryScalar | QueryScalar[] | null | undefined;

export interface RequestOptions {
  host?: Host;
  method?: HttpMethod;
  // With or without the leading slash; may hold a query string of its own.
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  // Defaults: 'trading' for carina, 'exodus' otherwise.
  auth?: AuthKind;
  headers?: Record<string, string>;
}

export interface HttpResponse {
  status: number;
  body: JsonValue;
  // The path and query that were sent, without the host, for meta.source.
  source: string;
}

// Hands out the bearer tokens and renews one that Stockbit rejected. `refresh` resolves true when
// a new token is ready to retry with.
export interface TokenProvider {
  token(kind: Exclude<AuthKind, 'none'>): Promise<string | undefined>;
  refresh(kind: Exclude<AuthKind, 'none'>, rejected: string): Promise<boolean>;
}

export interface HttpClientOptions {
  bases: Record<Host, string>;
  tokens: TokenProvider;
  logger: Logger;
  timeoutMs: number;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof fetch;
  // Waits between retries; replaced in tests.
  sleep?: (ms: number) => Promise<void>;
}

const RETRY_DELAYS_MS = [300, 900];

export function buildQuery(query: Record<string, QueryValue> | undefined): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    // Stockbit takes repeated keys for lists (filter_stocks=A&filter_stocks=B).
    for (const item of Array.isArray(value) ? value : [value]) {
      params.append(key, String(item));
    }
  }
  return params.toString();
}

function messageOf(body: JsonValue): string | undefined {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    for (const key of ['message', 'error', 'error_message', 'msg']) {
      const v = body[key];
      if (typeof v === 'string' && v.length > 0) {
        return v;
      }
    }
  }
  return undefined;
}

export class StockbitHttp {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: HttpClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async request(req: RequestOptions): Promise<HttpResponse> {
    const host = req.host ?? 'exodus';
    const method = req.method ?? 'GET';
    const auth = req.auth ?? (host === 'carina' ? 'trading' : 'exodus');
    const path = `/${req.path.replace(/^\/+/, '')}`;
    const qs = buildQuery(req.query);
    const source = qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path;
    const url = `${this.options.bases[host]}${source}`;

    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const token = auth === 'none' ? undefined : await this.options.tokens.token(auth);
      if (auth !== 'none' && !token) {
        throw authError(auth, 'No saved Stockbit session.');
      }
      const res = await this.send(url, method, req, token);
      const body = await readBody(res);

      if (res.status === 401 && auth !== 'none' && token && !refreshed) {
        refreshed = true;
        if (await this.options.tokens.refresh(auth, token)) {
          continue;
        }
      }
      // GETs are safe to repeat; anything that may have changed state is never sent twice.
      const retryable = method === 'GET' && (res.status === 429 || res.status >= 500);
      if (retryable && attempt < RETRY_DELAYS_MS.length) {
        const delay = RETRY_DELAYS_MS[attempt] ?? 1000;
        this.options.logger.debug('retrying', { status: res.status, path, delay });
        await this.sleep(delay);
        continue;
      }
      if (res.ok) {
        return { status: res.status, body, source };
      }
      throw toHttpError(res, body, auth, source);
    }
  }

  private async send(
    url: string,
    method: HttpMethod,
    req: RequestOptions,
    token: string | undefined,
  ): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...this.options.defaultHeaders,
      ...req.headers,
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    const init: RequestInit = { method, headers, signal: AbortSignal.timeout(this.options.timeoutMs) };
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }
    try {
      return await this.fetchImpl(url, init);
    } catch (error) {
      // The browser fetch says itself when Chromium cannot start.
      if (isStockbitMcpError(error)) {
        throw error;
      }
      const name = (error as Error).name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new StockbitMcpError('TIMEOUT', `Stockbit did not answer within ${this.options.timeoutMs} ms.`, {
          details: { path: new URL(url).pathname },
        });
      }
      throw new StockbitMcpError('UPSTREAM', `Could not reach Stockbit: ${(error as Error).message}`, {
        cause: error,
      });
    }
  }
}

async function readBody(res: Response): Promise<JsonValue> {
  const text = await res.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return text;
  }
}

function authError(auth: Exclude<AuthKind, 'none'>, message: string): StockbitMcpError {
  return auth === 'trading'
    ? new StockbitMcpError('TRADING_AUTH_REQUIRED', message, { hint: TRADING_LOGIN_HINT })
    : new StockbitMcpError('AUTH_REQUIRED', message, { hint: LOGIN_HINT });
}

export function toHttpError(
  res: Response,
  body: JsonValue,
  auth: AuthKind,
  source: string,
): StockbitMcpError {
  const upstream = messageOf(body);
  const details = { status: res.status, path: source.split('?')[0], ...(upstream ? { upstream } : {}) };
  if (typeof body === 'string' && /cloudflare|cf-ray|attention required/i.test(body)) {
    return new StockbitMcpError('BLOCKED', 'Cloudflare blocked the request to Stockbit.', {
      details,
      hint:
        "Stockbit's Cloudflare rejects Node's fetch and headless Chromium (seen 2026-10-28), so retrying " +
        'will not help. Leave STOCKBIT_MCP_HTTP at browser and STOCKBIT_MCP_BROWSER_HEADLESS off, so ' +
        'requests go through a visible Chromium window.',
    });
  }
  if (res.status === 401) {
    return authError(
      auth === 'trading' ? 'trading' : 'exodus',
      upstream ?? 'Stockbit rejected the saved session.',
    );
  }
  if (res.status === 402 || /paywall|upgrade|pro member|langganan/i.test(upstream ?? '')) {
    return new StockbitMcpError('PAYWALLED', upstream ?? 'This feature needs Stockbit Pro.', {
      details,
    });
  }
  if (res.status === 404) {
    return new StockbitMcpError('NOT_FOUND', upstream ?? 'Stockbit has nothing at that path.', {
      details,
    });
  }
  if (res.status === 429) {
    return new StockbitMcpError('RATE_LIMITED', upstream ?? 'Stockbit is rate limiting requests.', {
      details,
      hint: 'Wait a minute before calling again.',
    });
  }
  if (res.status === 400 || res.status === 422) {
    return new StockbitMcpError('INVALID_INPUT', upstream ?? 'Stockbit rejected the request.', {
      details,
    });
  }
  return new StockbitMcpError('UPSTREAM', upstream ?? `Stockbit answered HTTP ${res.status}.`, {
    details,
  });
}
