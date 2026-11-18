// Test-only protobuf builders for datafeed frames.
const te = new TextEncoder();

export function varint(n: number | bigint): number[] {
  let v = BigInt(n);
  const out: number[] = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}
export const tag = (no: number, wt: number) => varint((no << 3) | wt);
export const bytesField = (no: number, b: number[] | Uint8Array) => [...tag(no, 2), ...varint(b.length), ...b];
export const strField = (no: number, s: string) => bytesField(no, [...te.encode(s)]);
export const intField = (no: number, n: number | bigint) => [...tag(no, 0), ...varint(n)];
export function dblField(no: number, d: number): number[] {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setFloat64(0, d, true);
  return [...tag(no, 1), ...b];
}
export const ts = (ms: number) => [...intField(1, Math.floor(ms / 1000)), ...intField(2, (ms % 1000) * 1_000_000)];

export interface TradeSpec { symbol: string; price: number; shares: number; side: 1 | 2; ms: number; no: number; board?: number }
export function tradeMsg(t: TradeSpec): number[] {
  return [
    ...strField(2, t.symbol),
    ...dblField(3, t.price),
    ...dblField(4, t.shares),
    ...intField(5, t.side),
    ...bytesField(7, ts(t.ms)),
    ...intField(9, t.no),
    ...intField(10, t.board ?? 1),
    ...dblField(11, t.price * t.shares),
  ];
}
export function tradeBatchFrame(trades: TradeSpec[]): Uint8Array {
  const batch = trades.flatMap((t) => bytesField(1, tradeMsg(t)));
  return new Uint8Array(bytesField(8, batch));
}
export function orderbookFrame(symbol: string, body: string): Uint8Array {
  return new Uint8Array(bytesField(10, [...strField(1, symbol), ...strField(2, body)]));
}
export function bookBody(symbol: string, side: 'BID' | 'OFFER', levels: [number, number, number][], epochSec: number): string {
  const total = levels.reduce((s, l) => s + l[2], 0);
  return `#O|${symbol}|${side}|${levels.map((l) => l.join(';')).join('|')}|${epochSec}-1&${total}`;
}
const dec = (no: number, v: number) => bytesField(no, bytesField(1, strField(1, String(v))));
export function livePriceFrame(p: { symbol: string; last: number; prev: number; open: number; high: number; low: number; value: number; volume: number; changePct: number; ms: number }): Uint8Array {
  const body = [
    ...strField(1, p.symbol), ...dec(2, p.last), ...dec(3, p.volume), ...dec(4, p.high), ...dec(5, p.low),
    ...dec(6, p.open), ...dec(10, p.prev), ...dec(11, p.value), ...dec(13, p.changePct), ...bytesField(16, ts(p.ms)),
  ];
  return new Uint8Array(bytesField(16, body));
}
export const pongFrame = () => new Uint8Array(bytesField(2, strField(1, 'pong')));
export const errorFrame = (code: number, message: string) => new Uint8Array(bytesField(7, [...intField(1, code), ...strField(2, message)]));
