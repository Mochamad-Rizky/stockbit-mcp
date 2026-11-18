import type { Trade } from '../../../src/watch/types.js';

export const T0 = Date.parse('2026-11-18T09:30:00+07:00');
export function trade(symbol: string, price: number, lots: number, side: 'buy' | 'sell', ms: number, no = 0): Trade {
  return { symbol, price, shares: lots * 100, value: price * lots * 100, side, time: ms, tradeNo: no, board: 1 };
}
