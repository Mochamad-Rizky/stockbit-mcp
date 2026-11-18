import type { Channels, FeedEvent, LivePrice, Trade } from '../types.js';
import { parseOrderBookText } from './orderbook-text.js';

// A minimal protobuf codec for Stockbit's datafeed (securities.transactional.datafeed.v1), written
// from the message types embedded in the desktop app 2.9.0 bundle.

const te = new TextEncoder();
const td = new TextDecoder();

function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return out;
}

function lenField(no: number, bytes: ArrayLike<number>): number[] {
  return [...varint((no << 3) | 2), ...varint(bytes.length), ...Array.from(bytes)];
}

const strField = (no: number, s: string) => lenField(no, te.encode(s));

// WebsocketChannel field numbers.
const CHANNEL_FIELDS: Record<keyof Channels, number> = {
  orderBook: 2,
  runningTradeBatch: 5,
  livePrice: 12,
};

// WebsocketRequest{1 user_id, 2 channel, 5 access_token}.
export function encodeSubscribe(userId: string, token: string, ch: Channels): Uint8Array<ArrayBuffer> {
  const channel: number[] = [];
  for (const key of ['orderBook', 'runningTradeBatch', 'livePrice'] as const) {
    for (const symbol of ch[key]) channel.push(...strField(CHANNEL_FIELDS[key], symbol));
  }
  return new Uint8Array([...strField(1, userId), ...lenField(2, channel), ...strField(5, token)]);
}

// WebsocketRequest{4 ping{1 "ping"}}.
export function encodePing(): Uint8Array<ArrayBuffer> {
  return new Uint8Array(lenField(4, strField(1, 'ping')));
}

type Value = { wt: 0; v: bigint } | { wt: 1; v: number } | { wt: 2; v: Uint8Array } | { wt: 5; v: number };
type Fields = Map<number, Value[]>;

function decode(buf: Uint8Array): Fields {
  const fields: Fields = new Map();
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let i = 0;
  const readVarint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (i >= buf.length) throw new Error('truncated varint');
      const b = buf[i++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
    }
  };
  while (i < buf.length) {
    const key = Number(readVarint());
    const no = key >>> 3;
    const wt = key & 7;
    let value: Value;
    if (wt === 0) value = { wt, v: readVarint() };
    else if (wt === 1) {
      value = { wt, v: view.getFloat64(i, true) };
      i += 8;
    } else if (wt === 2) {
      const len = Number(readVarint());
      if (i + len > buf.length) throw new Error('truncated field');
      value = { wt, v: buf.subarray(i, i + len) };
      i += len;
    } else if (wt === 5) {
      value = { wt, v: view.getFloat32(i, true) };
      i += 4;
    } else throw new Error(`unsupported wire type ${wt}`);
    const list = fields.get(no);
    if (list) list.push(value);
    else fields.set(no, [value]);
  }
  return fields;
}

const first = (f: Fields, no: number) => f.get(no)?.[0];
const all = (f: Fields, no: number) => f.get(no) ?? [];

function str(f: Fields, no: number): string {
  const v = first(f, no);
  return v?.wt === 2 ? td.decode(v.v) : '';
}
function dbl(f: Fields, no: number): number {
  const v = first(f, no);
  return v?.wt === 1 || v?.wt === 5 ? v.v : v?.wt === 0 ? Number(v.v) : 0;
}
function int(f: Fields, no: number): number {
  const v = first(f, no);
  return v?.wt === 0 ? Number(v.v) : 0;
}
function msg(f: Fields, no: number): Fields | undefined {
  const v = first(f, no);
  return v?.wt === 2 ? decode(v.v) : undefined;
}
// google.protobuf.Timestamp{1 seconds, 2 nanos} → ms.
function timestamp(f: Fields | undefined): number {
  if (!f) return 0;
  return int(f, 1) * 1000 + Math.floor(int(f, 2) / 1_000_000);
}
// financial.common.v1.DecimalValue{1 raw: google.type.Decimal{1 value string}}.
function decimal(f: Fields, no: number): number {
  const raw = msg(f, no);
  const d = raw && msg(raw, 1);
  return d ? Number(str(d, 1)) || 0 : 0;
}

function trade(f: Fields): Trade {
  const action = int(f, 5);
  return {
    symbol: str(f, 2),
    price: dbl(f, 3),
    shares: dbl(f, 4),
    value: dbl(f, 11),
    side: action === 1 ? 'buy' : action === 2 ? 'sell' : 'none',
    time: timestamp(msg(f, 7)),
    tradeNo: int(f, 9),
    board: int(f, 10),
  };
}

function livePrice(f: Fields): LivePrice {
  return {
    symbol: str(f, 1),
    last: decimal(f, 2),
    prev: decimal(f, 10),
    open: decimal(f, 6),
    high: decimal(f, 4),
    low: decimal(f, 5),
    value: decimal(f, 11),
    volume: decimal(f, 3),
    changePct: decimal(f, 13),
    time: timestamp(msg(f, 16)),
  };
}

// WebsocketWrapMessageChannel is a oneof: the first field present says which message it is. A frame
// that does not parse is reported as unknown (field -1), never thrown: one bad frame must not stop
// the feed.
export function decodeFrame(buf: Uint8Array): FeedEvent {
  try {
    return decodeWrap(buf);
  } catch {
    return { kind: 'unknown', field: -1 };
  }
}

function decodeWrap(buf: Uint8Array): FeedEvent {
  const wrap = decode(buf);
  const [no] = wrap.keys();
  if (no === undefined) return { kind: 'unknown', field: 0 };
  const body = msg(wrap, no);
  if (!body) return { kind: 'unknown', field: no };
  switch (no) {
    case 8:
      return {
        kind: 'trades',
        trades: all(body, 1).flatMap((v) => (v.wt === 2 ? [trade(decode(v.v))] : [])),
      };
    case 1:
      return { kind: 'trades', trades: [trade(body)] };
    case 10: {
      const book = parseOrderBookText(str(body, 2));
      return book ? { kind: 'book', book } : { kind: 'unknown', field: no };
    }
    case 16:
      return { kind: 'price', price: livePrice(body) };
    case 2:
      return { kind: 'pong' };
    case 7:
      return { kind: 'error', code: int(body, 1), message: str(body, 2) };
    default:
      return { kind: 'unknown', field: no };
  }
}
