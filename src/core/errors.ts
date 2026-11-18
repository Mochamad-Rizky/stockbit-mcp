// Every failure a tool reports carries one of these codes, so that a client (or the model) can tell
// "log in again" from "Stockbit said no" from "the input was wrong" without reading prose.
export type ErrorCode =
  // No saved session, or Stockbit rejected it and refreshing did not help: run `stockbit-mcp login`.
  | 'AUTH_REQUIRED'
  // The brokerage (trading) session is missing or expired: run `stockbit-mcp login --trading`.
  | 'TRADING_AUTH_REQUIRED'
  | 'LOGIN_FAILED'
  | 'INVALID_INPUT'
  | 'NOT_FOUND'
  // The feature needs Stockbit Pro, or the free quota of it is used up.
  | 'PAYWALLED'
  | 'RATE_LIMITED'
  // Cloudflare answered instead of Stockbit (a challenge page).
  | 'BLOCKED'
  // The Chromium that sends the requests could not start (not installed, or a wrong path).
  | 'BROWSER_UNAVAILABLE'
  | 'TIMEOUT'
  // Stockbit answered with an error that has no more specific code.
  | 'UPSTREAM'
  // A deletion or an order was not done: the user declined, or the confirmation token is unknown or
  // stale.
  | 'CONFIRMATION_DECLINED'
  | 'CONFIRMATION_EXPIRED'
  // An order was not sent because the client cannot show the confirmation popups it needs.
  | 'CONFIRMATION_UNAVAILABLE'
  // An order request failed in a way that leaves open whether Stockbit took it.
  | 'ORDER_UNCERTAIN'
  | 'INTERNAL';

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  // What to do about it, for the model to pass on.
  hint?: string;
  details?: Record<string, unknown>;
}

export class StockbitMcpError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { hint?: string; details?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StockbitMcpError';
    this.code = code;
    this.hint = options.hint;
    this.details = options.details;
  }
}

export function isStockbitMcpError(error: unknown): error is StockbitMcpError {
  return error instanceof StockbitMcpError;
}

export function toErrorPayload(error: unknown): ErrorPayload {
  if (isStockbitMcpError(error)) {
    return {
      code: error.code,
      message: error.message,
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      ...(error.details === undefined ? {} : { details: error.details }),
    };
  }
  return {
    code: 'INTERNAL',
    message: error instanceof Error ? error.message : String(error),
  };
}

export const LOGIN_HINT = 'Run `stockbit-mcp login` in a terminal, then call the tool again.';
export const TRADING_LOGIN_HINT =
  'Run `stockbit-mcp login --trading` in a terminal (it asks for the trading PIN), then call the tool again.';
