import { isStockbitMcpError } from '../core/errors.js';
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

// ---- Reads for the trade plan, swing scan and holdings --------------------------------------


// Missing sessions are expected (the trading session expires daily): those reads answer
// `undefined` instead of throwing.
async function maybe<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch (error) {
    if (isStockbitMcpError(error) && /AUTH_REQUIRED$/.test(error.code)) return undefined;
    throw error;
  }
}

// Today's ARA/ARB band and the previous close, from the order-book REST.
export async function getAraArb(http: Http, symbol: string): Promise<{ ara?: number; arb?: number; prev?: number }> {
  const data = await maybe(() => getJson(http, `/company-price-feed/v2/orderbook/companies/${encodeURIComponent(symbol)}`));
  const ara = num(field(data, 'ara', 'value'));
  const arb = num(field(data, 'arb', 'value'));
  const prev = num(field(data, 'previous'));
  return { ...(ara === undefined ? {} : { ara }), ...(arb === undefined ? {} : { arb }), ...(prev === undefined ? {} : { prev }) };
}

export interface Bandar {
  accdist?: string;
  topBuyers: { code: string; value: number }[];
}

export async function getBandar(http: Http, symbol: string): Promise<Bandar | undefined> {
  const data = await maybe(() =>
    getJson(http, `/marketdetectors/${encodeURIComponent(symbol)}`, { period: 'BROKER_SUMMARY_PERIOD_LAST_7_DAYS' }),
  );
  if (data === undefined) return undefined;
  const accdist = field(data, 'bandar_detector', 'avg', 'accdist');
  const topBuyers = list(field(data, 'broker_summary', 'brokers_buy'))
    .map((b) => ({ code: field(b, 'netbs_broker_code'), value: num(field(b, 'bval')) }))
    .filter((b): b is { code: string; value: number } => typeof b.code === 'string' && b.value !== undefined);
  return { ...(typeof accdist === 'string' ? { accdist } : {}), topBuyers };
}

// Net foreign value over the last 7 days (IDR, negative = net sell).
export async function getForeignNet(http: Http, symbol: string): Promise<number | undefined> {
  const data = await maybe(() =>
    getJson(http, '/order-trade/foreign-domestic/summary', { symbols: [symbol], period: 'TB_PERIOD_LAST_7_DAYS' }),
  );
  return num(field(data, 'net', 'all', 'raw'));
}

export interface DailyBarData {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const JAKARTA_MS = 7 * 3_600_000;
const jakartaDate = (ms: number) => new Date(ms + JAKARTA_MS).toISOString().slice(0, 10);

// The last `days` trading days, oldest first. volume is in lots.
export async function getDailyBars(http: Http, symbol: string, days: number, now = Date.now()): Promise<DailyBarData[]> {
  const span = Math.ceil(days * 1.6) + 7;
  const data = await maybe(() =>
    getJson(http, `/chartbit/${encodeURIComponent(symbol)}/price/daily`, {
      from: jakartaDate(now),
      to: jakartaDate(now - span * 86_400_000),
    }),
  );
  const rows = list(field(data, 'chartbit'))
    .map((r) => ({
      t: num(field(r, 'unixdate')) ?? 0,
      open: num(field(r, 'open')) ?? 0,
      high: num(field(r, 'high')) ?? 0,
      low: num(field(r, 'low')) ?? 0,
      close: num(field(r, 'close')) ?? 0,
      volume: num(field(r, 'lot')) ?? 0,
    }))
    .sort((a, b) => a.t - b.t);
  return rows.slice(-days).map(({ t, ...r }) => ({ date: jakartaDate(t * 1000), ...r }));
}

export interface Holding {
  symbol: string;
  lots: number;
  avgPrice: number;
}

// Holdings and the cash trading balance, from one carina read; undefined without a trading session.
export async function getPortfolio(http: Http): Promise<{ holdings: Holding[]; cash?: number } | undefined> {
  const data = await maybe(() => getJson(http, '/portfolio/v2/list', undefined, 'carina'));
  if (data === undefined) return undefined;
  const holdings = list(field(data, 'results'))
    .map((r) => ({ symbol: field(r, 'symbol'), lots: num(field(r, 'qty', 'balance', 'lot')) ?? 0, avgPrice: num(field(r, 'price', 'average', 'price')) ?? 0 }))
    .filter((h): h is Holding => typeof h.symbol === 'string' && h.lots > 0);
  const cash = num(field(data, 'summary', 'trading', 'balance'));
  return { holdings, ...(cash === undefined ? {} : { cash }) };
}

// Every symbol in the user's Stockbit watchlists.
export async function getWatchlistSymbols(http: Http): Promise<string[]> {
  const lists = list(await maybe(() => getJson(http, '/watchlist')));
  const out = new Set<string>();
  for (const w of lists) {
    const id = num(field(w, 'watchlist_id'));
    if (id === undefined) continue;
    const symbols = list(field(await maybe(() => getJson(http, `/watchlist/${id}/symbols`)), 'symbols'));
    for (const s of symbols) if (typeof s === 'string') out.add(s);
  }
  return [...out];
}
