import type { BookLevel, BookSide } from '../types.js';

// The datafeed's order book comes as text: "#O|BBRI|BID|3120;179;2245700|…|1794969627-5368&49457200",
// one side per message, levels as price;orders;shares, then <epoch seconds>-<n>&<total shares>.
export function parseOrderBookText(body: string): BookSide | undefined {
  const parts = body.split('|');
  if (parts.length < 4 || parts[0] !== '#O') return undefined;
  const symbol = parts[1];
  const sideText = parts[2];
  if (!symbol || !sideText) return undefined;
  const tail = parts[parts.length - 1] ?? '';
  const m = /^(\d+)-\d+&(\d+)$/.exec(tail);
  const levelParts = m ? parts.slice(3, -1) : parts.slice(3);
  const levels: BookLevel[] = [];
  for (const lp of levelParts) {
    const [p, o, s] = lp.split(';').map(Number);
    if (p === undefined || o === undefined || s === undefined || [p, o, s].some((n) => !Number.isFinite(n))) {
      return undefined;
    }
    levels.push({ price: p, orders: o, shares: s });
  }
  return {
    symbol,
    side: sideText === 'BID' ? 'bid' : 'offer',
    levels,
    time: m ? Number(m[1]) * 1000 : 0,
    total: m ? Number(m[2]) : levels.reduce((sum, l) => sum + l.shares, 0),
  };
}
