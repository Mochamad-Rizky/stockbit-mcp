import type { Host, QueryValue, StockbitHttp } from '../core/http.js';
import { isJsonObject, type JsonValue } from '../core/json.js';
import { unwrap } from '../tools/common.js';

// The REST reads the watch bot makes, through the same client (and Chromium transport) as the MCP
// tools. Each answers Stockbit's `data` field.

export type Http = Pick<StockbitHttp, 'request'>;

export async function getJson(
  http: Http,
  path: string,
  query?: Record<string, QueryValue>,
  host?: Host,
): Promise<JsonValue> {
  const res = await http.request({ path, ...(query ? { query } : {}), ...(host ? { host } : {}) });
  return unwrap(res.body);
}

// Stockbit sends numbers as numbers or as strings ("3200000000.00", "10,150").
export function num(value: JsonValue | undefined): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const n = Number(value.replace(/,/g, ''));
    return value.trim() !== '' && Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

export function field(value: JsonValue | undefined, ...keys: (string | number)[]): JsonValue | undefined {
  let v = value;
  for (const k of keys) {
    if (typeof k === 'number') v = Array.isArray(v) ? v[k] : undefined;
    else v = isJsonObject(v) ? v[k] : undefined;
  }
  return v;
}

export const list = (value: JsonValue | undefined): JsonValue[] => (Array.isArray(value) ? value : []);
