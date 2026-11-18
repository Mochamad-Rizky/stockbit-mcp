import { z } from 'zod';
import type { Host, HttpMethod, QueryValue } from '../core/http.js';
import { isJsonObject, type JsonValue } from '../core/json.js';
import type { ToolContext, ToolOutput } from './types.js';

// IDX tickers are 4 letters, warrants and rights add a suffix (BBCA, GOTO-W), indices are names
// (COMPOSITE, LQ45). Stockbit takes them upper case.
export const symbolInput = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^[A-Za-z0-9.-]+$/, 'letters, digits, dot or dash only')
  .describe('IDX ticker such as BBCA or TLKM (no exchange prefix).');

export function upper(symbol: string): string {
  return symbol.trim().toUpperCase();
}

export const dateInput = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')
  .describe('Date as YYYY-MM-DD (Jakarta time).');

export const pageInput = z.number().int().min(1).max(1000).optional().describe('Page number, from 1.');
export const limitInput = (max: number, def?: number) =>
  z
    .number()
    .int()
    .min(1)
    .max(max)
    .optional()
    .describe(`How many rows to return (max ${max}${def === undefined ? '' : `, default ${def}`}).`);

// Stockbit wraps most answers as { message, data }. Tools return `data` so the model does not wade
// through the envelope; an answer without it comes back whole.
export function unwrap(body: JsonValue): JsonValue {
  if (isJsonObject(body) && 'data' in body) {
    return body.data ?? null;
  }
  return body;
}

export interface CallSpec {
  host?: Host;
  method?: HttpMethod;
  path: string;
  query?: Record<string, QueryValue>;
  body?: unknown;
  // Keep Stockbit's envelope (message, data, …) instead of returning `data` only.
  raw?: boolean;
}

export async function call(ctx: ToolContext, spec: CallSpec): Promise<ToolOutput<JsonValue>> {
  const res = await ctx.http.request({
    path: spec.path,
    ...(spec.host ? { host: spec.host } : {}),
    ...(spec.method ? { method: spec.method } : {}),
    ...(spec.query ? { query: spec.query } : {}),
    ...(spec.body === undefined ? {} : { body: spec.body }),
  });
  return { data: spec.raw ? res.body : unwrap(res.body), source: res.source };
}

// Drops the keys whose value is undefined, for query objects built from optional inputs.
export function compact<T extends Record<string, unknown>>(obj: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}
