import { createLogger } from '../../../src/core/logger.js';
import { encodePing, encodeSubscribe } from '../../../src/watch/feed/codec.js';
import { DatafeedClient } from '../../../src/watch/feed/client.js';
import type { Channels, FeedEvent } from '../../../src/watch/types.js';
import { errorFrame, pongFrame, tradeBatchFrame } from './pb-helpers.js';

class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  binaryType = 'blob';
  readyState = 0;
  sent: Uint8Array[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: ArrayBuffer }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(
    public url: string,
    public protocols: string[],
  ) {
    FakeWebSocket.all.push(this);
  }
  send(b: Uint8Array) {
    this.sent.push(b);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
  // test drivers
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(frame: Uint8Array) {
    this.onmessage?.({ data: frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength) as ArrayBuffer });
  }
  drop() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.({ code: 1006, reason: 'gone' });
  }
}

const channels: Channels = { runningTradeBatch: ['*'], orderBook: [], livePrice: [] };
const last = () => FakeWebSocket.all[FakeWebSocket.all.length - 1]!;

function makeClient(tokens = { token: vi.fn(async () => 'tok'), refresh: vi.fn(async () => true) }) {
  const events: Array<{ ev: FeedEvent; raw: Uint8Array }> = [];
  const client = new DatafeedClient({
    userId: '5',
    tokens,
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    logger: createLogger('silent'),
    onEvent: (ev, raw) => events.push({ ev, raw }),
  });
  client.setChannels(channels);
  return { client, events, tokens };
}

describe('DatafeedClient', () => {
  beforeEach(() => {
    FakeWebSocket.all = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('subscribes with the session token on open', async () => {
    const { client } = makeClient();
    client.start();
    const ws = last();
    expect(ws.url).toBe('wss://wss-jkt.trading.stockbit.com/ws?_s=dfctx_v2_0');
    expect(ws.protocols).toEqual(['desktop']);
    expect(ws.binaryType).toBe('arraybuffer');
    ws.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent[0]).toEqual(encodeSubscribe('5', 'tok', channels));
    expect(client.connected).toBe(true);
    client.stop();
  });

  it('sends the whole channel set again when it changes', async () => {
    const { client } = makeClient();
    client.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    const next: Channels = { runningTradeBatch: ['*'], orderBook: ['BBCA'], livePrice: ['BBCA'] };
    client.setChannels(next);
    await vi.advanceTimersByTimeAsync(0);
    expect(last().sent[1]).toEqual(encodeSubscribe('5', 'tok', next));
    client.stop();
  });

  it('pings every 15 s and reconnects when no pong comes', async () => {
    const { client } = makeClient();
    client.start();
    const ws = last();
    ws.open();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.sent[1]).toEqual(encodePing());
    ws.receive(pongFrame());
    await vi.advanceTimersByTimeAsync(15_000);
    expect(ws.sent[2]).toEqual(encodePing());
    expect(ws.closed).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ws.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeWebSocket.all).toHaveLength(2);
    expect(last().url).toBe('wss://wss-jkt.trading.stockbit.com/ws?_s=dfctx_v2_1');
    client.stop();
  });

  it('reconnects and resubscribes after close', async () => {
    const { client } = makeClient();
    client.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    const delays: number[] = [];
    for (let i = 0; i < 7; i += 1) {
      const before = FakeWebSocket.all.length;
      last().drop();
      let waited = 0;
      while (FakeWebSocket.all.length === before) {
        await vi.advanceTimersByTimeAsync(500);
        waited += 500;
      }
      delays.push(waited);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().sent[0]).toEqual(encodeSubscribe('5', 'tok', channels));
    client.stop();
  });

  it('refreshes the token on an unauthorized error', async () => {
    let current = 'tok';
    const tokens = {
      token: vi.fn(async () => current),
      refresh: vi.fn(async () => {
        current = 'tok2';
        return true;
      }),
    };
    const { client } = makeClient(tokens);
    client.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    last().receive(errorFrame(401, 'Unauthorized Connection'));
    await vi.advanceTimersByTimeAsync(0);
    expect(tokens.refresh).toHaveBeenCalledWith('exodus', 'tok');
    await vi.advanceTimersByTimeAsync(1_000);
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    expect(last().sent[0]).toEqual(encodeSubscribe('5', 'tok2', channels));
    client.stop();
  });

  it('forwards events with the raw frame', async () => {
    const { client, events } = makeClient();
    client.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    const frame = tradeBatchFrame([{ symbol: 'BBCA', price: 5675, shares: 300, side: 1, ms: 1000, no: 7 }]);
    last().receive(frame);
    expect(events).toHaveLength(1);
    expect(events[0]!.ev.kind).toBe('trades');
    expect([...events[0]!.raw]).toEqual([...frame]);
    client.stop();
  });

  it('does not reconnect after stop', async () => {
    const { client } = makeClient();
    client.start();
    last().open();
    await vi.advanceTimersByTimeAsync(0);
    client.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.all).toHaveLength(1);
  });
});
