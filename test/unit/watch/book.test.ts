import { Books, SymbolBook } from '../../../src/watch/market/book.js';
import type { BookSide } from '../../../src/watch/types.js';

const cfg = { wallFactor: 5, wallPersistSec: 20, accumWallPersistSec: 60 };
const T = 1_000_000_000_000;
function side(s: 'bid' | 'offer', levels: [number, number][]): BookSide {
  return { symbol: 'A', side: s, time: 0, total: 0, levels: levels.map(([price, shares]) => ({ price, orders: 1, shares })) };
}
// 10 bid levels 270..252 of 1 000 shares, with an optional big level.
function bids(big?: [number, number], top = 270): BookSide {
  const levels: [number, number][] = [];
  for (let p = top; p > top - 20; p -= 2) levels.push([p, big && big[0] === p ? big[1] : 1000]);
  return side('bid', levels);
}

describe('SymbolBook', () => {
  it('finds a bid wall only after it persists', () => {
    const b = new SymbolBook(cfg);
    b.apply(bids([266, 50_000]), T);
    expect(b.walls('bid', 20, T + 10_000)).toEqual([]);
    b.apply(bids([266, 50_000]), T + 21_000);
    expect(b.walls('bid', 20, T + 21_000)).toEqual([{ side: 'bid', price: 266, shares: 50_000, since: T }]);
    expect(b.walls('bid', 0, T + 21_000)).toHaveLength(1);
  });

  it('counts a wall pulled before being hit as fake', () => {
    const b = new SymbolBook(cfg);
    b.apply(bids([266, 50_000]), T);
    b.apply(bids([266, 50_000]), T + 25_000);
    b.apply(bids(), T + 26_000); // gone while the best bid is still 270
    expect(b.fakeWalls()).toBe(1);
  });

  it('a wall eaten by trades is not fake', () => {
    const b = new SymbolBook(cfg);
    b.apply(bids([270, 50_000]), T);
    b.apply(bids([270, 50_000]), T + 25_000);
    b.apply(bids(undefined, 268), T + 26_000); // best bid fell through 270
    expect(b.fakeWalls()).toBe(0);
  });

  it('a wall that never persisted is not fake', () => {
    const b = new SymbolBook(cfg);
    b.apply(bids([266, 50_000]), T);
    b.apply(bids(), T + 5_000);
    expect(b.fakeWalls()).toBe(0);
  });

  it('offer thinning compares to the window max', () => {
    const b = new SymbolBook(cfg);
    b.apply(side('offer', [[276, 4000], [278, 4000], [280, 2000], [282, 9000]]), T);
    b.apply(side('offer', [[276, 1000], [278, 2000], [280, 2000], [282, 9000]]), T + 30_000);
    expect(b.offerThinning(3, 60, T + 30_000)).toBeCloseTo(0.5);
    expect(b.offerThinning(3, 10, T + 30_000)).toBe(0);
  });

  it('levelsTakenAbove counts tick levels between a price and the best offer', () => {
    const b = new SymbolBook(cfg);
    b.apply(side('offer', [[278, 100]]), T);
    b.apply(side('bid', [[276, 100]]), T);
    expect(b.levelsTakenAbove(274)).toBe(2);
    expect(b.levelsTakenAbove(278)).toBe(0);
    expect(b.spreadTicks()).toBe(1);
    expect(b.bestBid()?.price).toBe(276);
    expect(b.bestOffer()?.price).toBe(278);
  });
});

describe('Books', () => {
  it('keeps and drops books by symbol', () => {
    const books = new Books(cfg);
    books.apply(side('bid', [[100, 1]]), T);
    expect(books.get('A')?.bestBid()?.price).toBe(100);
    books.drop('A');
    expect(books.get('A')).toBeUndefined();
  });
});
