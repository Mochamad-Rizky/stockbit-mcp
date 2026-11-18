import { createHash, randomBytes } from 'node:crypto';
import type { ElicitRequestFormParams, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { Config } from './config.js';
import { StockbitMcpError } from './errors.js';
import type { JsonValue } from './json.js';
import type { Logger } from './logger.js';

// Nothing that deletes what the user owns reaches Stockbit unless the user said yes to that exact
// request. Two ways to ask:
//  - elicitation: the server asks the client to show a confirmation form (a popup in Claude) and
//    waits for the answer;
//  - token: for clients without elicitation, the first call returns a preview and a one-time token
//    bound to the exact request; only a second call that brings the token back goes ahead. The tool
//    is annotated destructive, so the client asks for permission before that second call.
// Orders move money, so they only take the first way: see confirmByPopups.

export interface ConfirmRequest {
  // The tool name, so that a token from one tool cannot confirm another.
  action: string;
  title: string;
  // One line per fact the user must see.
  lines: string[];
  // Exactly what will be sent; the token is bound to its hash.
  payload: JsonValue;
}

export type ConfirmOutcome =
  | { status: 'confirmed'; via: 'elicitation' | 'token' }
  | {
      status: 'pending';
      preview: { title: string; lines: string[] };
      confirmation_token: string;
      expires_at: string;
      instruction: string;
    };

// One popup of a confirmation that takes several.
export interface PopupStep {
  title: string;
  lines: string[];
  // The label of the checkbox the user ticks to go on.
  check: string;
}

export interface ElicitationPort {
  supported(): boolean;
  elicit(params: ElicitRequestFormParams): Promise<ElicitResult>;
}

const TOKEN_TTL_MS = 120_000;

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k] as JsonValue)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashOf(action: string, payload: JsonValue): string {
  return createHash('sha256').update(action).update('\0').update(stableStringify(payload)).digest('hex');
}

export class Confirmer {
  private readonly pending = new Map<string, { hash: string; expiresAt: number }>();

  constructor(
    private readonly config: Pick<Config, 'confirm'>,
    private readonly port: ElicitationPort,
    private readonly logger: Logger,
    private readonly now: () => number = Date.now,
  ) {}

  async confirm(req: ConfirmRequest, token: string | undefined): Promise<ConfirmOutcome> {
    if (token !== undefined) {
      return this.redeem(req, token);
    }
    const mode = this.config.confirm;
    if (mode === 'elicit' || (mode === 'auto' && this.port.supported())) {
      try {
        return await this.elicit(req);
      } catch (error) {
        // A decline is final. Only a client that failed to show the form falls back to a token.
        if (error instanceof StockbitMcpError || mode === 'elicit') {
          throw error;
        }
        this.logger.warn('elicitation failed, falling back to a confirmation token', {
          error: (error as Error).message,
        });
      }
    }
    return this.issue(req);
  }

  // Throws unless the client can show popups. Orders call it before anything else, so that a client
  // without them learns at once, before any request is made.
  requirePopups(): void {
    if (!this.port.supported()) {
      throw new StockbitMcpError(
        'CONFIRMATION_UNAVAILABLE',
        'This client cannot show confirmation popups, and orders are only sent after the user confirms in one.',
        {
          hint:
            'Use a client with MCP elicitation (form popups), such as Claude Code. A preview and token is ' +
            'not accepted for orders, whatever STOCKBIT_MCP_CONFIRM says.',
        },
      );
    }
  }

  // Shows every step as its own popup, in order, and resolves only when the user ticked all of them.
  // There is no token fallback: a client without popups, a popup that fails or times out, and a
  // refusal at any step all throw, and nothing is sent.
  async confirmByPopups(steps: PopupStep[]): Promise<void> {
    this.requirePopups();
    for (const [index, step] of steps.entries()) {
      let answer: { accepted: boolean; action: string };
      try {
        answer = await this.ask(step.title, step.lines, step.check);
      } catch (error) {
        throw new StockbitMcpError(
          'CONFIRMATION_UNAVAILABLE',
          `Confirmation popup ${index + 1} of ${steps.length} failed: ${(error as Error).message}. Nothing was sent.`,
          { cause: error },
        );
      }
      if (!answer.accepted) {
        throw new StockbitMcpError(
          'CONFIRMATION_DECLINED',
          `The user did not confirm popup ${index + 1} of ${steps.length}; nothing was sent.`,
          { details: { action: answer.action, step: index + 1, steps: steps.length } },
        );
      }
    }
  }

  private async elicit(req: ConfirmRequest): Promise<ConfirmOutcome> {
    const answer = await this.ask(req.title, req.lines, 'Ya, lanjutkan');
    if (answer.accepted) {
      return { status: 'confirmed', via: 'elicitation' };
    }
    throw new StockbitMcpError('CONFIRMATION_DECLINED', 'The user did not confirm; nothing was changed.', {
      details: { action: answer.action },
    });
  }

  // One popup with one checkbox; accepted only when the user accepted with the box ticked.
  private async ask(title: string, lines: string[], check: string): Promise<{ accepted: boolean; action: string }> {
    const result = await this.port.elicit({
      mode: 'form',
      message: [title, '', ...lines, '', 'Lanjutkan?'].join('\n'),
      requestedSchema: {
        type: 'object',
        properties: {
          confirm: {
            type: 'boolean',
            title: check,
            description: 'Centang untuk melanjutkan. Tanpa centang, tidak ada yang diubah.',
            default: false,
          },
        },
        required: ['confirm'],
      },
    });
    return { accepted: result.action === 'accept' && result.content?.confirm === true, action: result.action };
  }

  private issue(req: ConfirmRequest): ConfirmOutcome {
    this.sweep();
    const token = randomBytes(18).toString('base64url');
    const expiresAt = this.now() + TOKEN_TTL_MS;
    this.pending.set(token, { hash: hashOf(req.action, req.payload), expiresAt });
    return {
      status: 'pending',
      preview: { title: req.title, lines: req.lines },
      confirmation_token: token,
      expires_at: new Date(expiresAt).toISOString(),
      instruction:
        'Nothing was changed. Show this preview to the user and ask them to confirm. Only after they ' +
        'say yes, call the same tool again with the same arguments plus confirmation_token.',
    };
  }

  private redeem(req: ConfirmRequest, token: string): ConfirmOutcome {
    const entry = this.pending.get(token);
    // One use only, whatever the outcome.
    this.pending.delete(token);
    if (!entry || entry.expiresAt < this.now()) {
      throw new StockbitMcpError('CONFIRMATION_EXPIRED', 'The confirmation token is unknown or expired.', {
        hint: 'Call the tool again without confirmation_token to get a fresh preview.',
      });
    }
    if (entry.hash !== hashOf(req.action, req.payload)) {
      throw new StockbitMcpError(
        'CONFIRMATION_EXPIRED',
        'The arguments differ from the ones the token was issued for; nothing was changed.',
        { hint: 'Call the tool again without confirmation_token to get a new preview.' },
      );
    }
    return { status: 'confirmed', via: 'token' };
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt < now) {
        this.pending.delete(token);
      }
    }
  }
}
