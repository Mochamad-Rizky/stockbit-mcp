import { decodeFrame, encodePing, encodeSubscribe } from '../../../src/watch/feed/codec.js';
import { parseOrderBookText } from '../../../src/watch/feed/orderbook-text.js';
import { bytesField, errorFrame, livePriceFrame, orderbookFrame, pongFrame, strField, tradeBatchFrame } from './pb-helpers.js';

describe('datafeed codec', () => {
  it('encodes a subscription the server accepted live', () => {
    const b = encodeSubscribe('5', 'tok', { runningTradeBatch: ['*'], orderBook: [], livePrice: ['BBCA'] });
    expect([...b]).toEqual([0x0a, 1, 0x35, 0x12, 9, 0x2a, 1, 0x2a, 0x62, 4, 0x42, 0x42, 0x43, 0x41, 0x2a, 3, 0x74, 0x6f, 0x6b]);
    expect([...encodePing()]).toEqual([0x22, 6, 0x0a, 4, 0x70, 0x69, 0x6e, 0x67]);
  });

  it('decodes a running trade batch', () => {
    const ev = decodeFrame(tradeBatchFrame([{ symbol: 'BBCA', price: 5675, shares: 300, side: 2, ms: 1794968455570, no: 239839 }]));
    expect(ev).toEqual({
      kind: 'trades',
      trades: [{ symbol: 'BBCA', price: 5675, shares: 300, value: 1702500, side: 'sell', time: 1794968455570, tradeNo: 239839, board: 1 }],
    });
  });

  it('decodes an order-book frame through the text parser', () => {
    const ev = decodeFrame(orderbookFrame('GOTO', '#O|GOTO|OFFER|28;10;500|1794969627-1&500'));
    expect(ev).toEqual({ kind: 'book', book: { symbol: 'GOTO', side: 'offer', time: 1794969627000, total: 500, levels: [{ price: 28, orders: 10, shares: 500 }] } });
  });

  it('decodes a live price', () => {
    const ev = decodeFrame(livePriceFrame({ symbol: 'BBRI', last: 3140, prev: 3100, open: 3110, high: 3160, low: 3100, value: 111790823000, volume: 35701300, changePct: 1.29, ms: 1794968455000 }));
    expect(ev).toEqual({ kind: 'price', price: { symbol: 'BBRI', last: 3140, prev: 3100, open: 3110, high: 3160, low: 3100, value: 111790823000, volume: 35701300, changePct: 1.29, time: 1794968455000 } });
  });

  it('decodes pong and error frames, and reports unknown fields', () => {
    expect(decodeFrame(pongFrame())).toEqual({ kind: 'pong' });
    expect(decodeFrame(errorFrame(401, 'Unauthorized'))).toEqual({ kind: 'error', code: 401, message: 'Unauthorized' });
    expect(decodeFrame(new Uint8Array(bytesField(3, strField(1, 'x'))))).toEqual({ kind: 'unknown', field: 3 });
    expect(decodeFrame(orderbookFrame('X', 'garbage'))).toEqual({ kind: 'unknown', field: 10 });
  });

  it('reports a truncated frame as unknown instead of throwing', () => {
    const full = tradeBatchFrame([{ symbol: 'BBCA', price: 5675, shares: 300, side: 1, ms: 1, no: 1 }]);
    expect(decodeFrame(full.subarray(0, full.length - 5))).toEqual({ kind: 'unknown', field: -1 });
  });
});

describe('order-book text', () => {
  it('parses order-book text', () => {
    expect(parseOrderBookText('#O|BBRI|BID|3120;179;2245700|3110;444;3551900|1794969627-5368&49457200')).toEqual({
      symbol: 'BBRI', side: 'bid', time: 1794969627000, total: 49457200,
      levels: [{ price: 3120, orders: 179, shares: 2245700 }, { price: 3110, orders: 444, shares: 3551900 }],
    });
    expect(parseOrderBookText('#O|GOTO|OFFER|28;10;500|1794969627-1&500')?.side).toBe('offer');
    expect(parseOrderBookText('garbage')).toBeUndefined();
  });
});
