import { tickUp } from '../../core/ticks.js';
import type { BookLevel, BookSide } from '../types.js';

// Per-symbol order book from the datafeed, with what the bandar rules read from it: walls (levels
// far bigger than the side's typical level that stay put), fake walls (pulled before the price got
// there) and how fast the offers near the price are thinning.

export interface BookConfig {
  wallFactor: number;
  wallPersistSec: number;
}

export interface Wall {
  side: 'bid' | 'offer';
  price: number;
  shares: number;
  since: number;
}

const TOP = 10;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

export class SymbolBook {
  private bid: BookLevel[] = [];
  private offer: BookLevel[] = [];
  private readonly wallsBySide = { bid: new Map<number, Wall>(), offer: new Map<number, Wall>() };
  private fakes = 0;
  private offerHistory: Array<{ at: number; top: number[] }> = [];

  constructor(private readonly cfg: BookConfig) {}

  apply(b: BookSide, now: number): void {
    if (b.side === 'bid') this.bid = b.levels;
    else this.offer = b.levels;
    this.trackWalls(b.side, now);
    if (b.side === 'offer') {
      this.offerHistory.push({ at: now, top: this.offer.slice(0, TOP).map((l) => l.shares) });
      const keepFrom = now - 15 * 60_000;
      while (this.offerHistory.length > 1 && this.offerHistory[0]!.at < keepFrom) this.offerHistory.shift();
    }
  }

  private trackWalls(side: 'bid' | 'offer', now: number): void {
    const levels = side === 'bid' ? this.bid : this.offer;
    const top = levels.slice(0, TOP);
    const threshold = this.cfg.wallFactor * median(top.map((l) => l.shares));
    const walls = this.wallsBySide[side];
    const present = new Set<number>();
    for (const l of top) {
      if (threshold <= 0 || l.shares < threshold) continue;
      present.add(l.price);
      const w = walls.get(l.price);
      if (w) w.shares = l.shares;
      else walls.set(l.price, { side, price: l.price, shares: l.shares, since: now });
    }
    const best = levels[0]?.price;
    for (const [price, w] of walls) {
      if (present.has(price)) continue;
      walls.delete(price);
      const persisted = now - w.since >= this.cfg.wallPersistSec * 1000;
      // A bid wall is reached when the best bid falls to it, an offer wall when the best offer rises
      // to it; gone before that means it was pulled.
      const reached = best === undefined || (side === 'bid' ? best <= price : best >= price);
      if (persisted && !reached) this.fakes += 1;
    }
  }

  bestBid(): BookLevel | undefined {
    return this.bid[0];
  }

  bestOffer(): BookLevel | undefined {
    return this.offer[0];
  }

  walls(side: 'bid' | 'offer', minAgeSec: number, now: number): Wall[] {
    return [...this.wallsBySide[side].values()]
      .filter((w) => now - w.since >= minAgeSec * 1000)
      .map((w) => ({ ...w }));
  }

  fakeWalls(): number {
    return this.fakes;
  }

  // 1 - (shares on the top `topN` offer levels now) / (their maximum over the window), in 0..1.
  offerThinning(topN: number, windowSec: number, now: number): number {
    const sum = (top: number[]) => top.slice(0, topN).reduce((s, v) => s + v, 0);
    const current = sum(this.offer.slice(0, topN).map((l) => l.shares));
    const from = now - windowSec * 1000;
    let max = current;
    for (const h of this.offerHistory) if (h.at >= from) max = Math.max(max, sum(h.top));
    return max > 0 ? Math.max(0, 1 - current / max) : 0;
  }

  // Ticks between the best bid and the best offer.
  spreadTicks(): number {
    const bid = this.bestBid()?.price;
    const offer = this.bestOffer()?.price;
    return bid === undefined || offer === undefined ? 0 : ticksBetween(bid, offer);
  }

  // Price levels from `price` up to (not including) the best offer: the offers taken out since the
  // best offer stood at `price`.
  levelsTakenAbove(price: number): number {
    const offer = this.bestOffer()?.price;
    return offer === undefined ? 0 : ticksBetween(price, offer);
  }
}

function ticksBetween(low: number, high: number): number {
  let n = 0;
  for (let p = low; p < high && n < 1000; p = tickUp(p)) n += 1;
  return n;
}

export class Books {
  private readonly bySymbol = new Map<string, SymbolBook>();

  constructor(private readonly cfg: BookConfig) {}

  apply(b: BookSide, now: number): void {
    let s = this.bySymbol.get(b.symbol);
    if (!s) {
      s = new SymbolBook(this.cfg);
      this.bySymbol.set(b.symbol, s);
    }
    s.apply(b, now);
  }

  get(symbol: string): SymbolBook | undefined {
    return this.bySymbol.get(symbol);
  }

  drop(symbol: string): void {
    this.bySymbol.delete(symbol);
  }
}
