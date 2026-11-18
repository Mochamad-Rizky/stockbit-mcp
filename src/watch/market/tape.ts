import type { Trade } from '../types.js';

// Per-symbol running-trade statistics: 1-second buckets for the last 15 minutes (the windows the
// detectors look at) and whole-day aggregates. Lots are shares / 100.

const KEEP_SEC = 15 * 60;
// Big lots are counted only once the day's lot distribution has this many trades, and the threshold
// is refreshed every this many trades.
const BIG_LOT_MIN_TRADES = 50;
const BIG_LOT_PCT = 0.99;

export interface WindowStats {
  value: number;
  trades: number;
  buyValue: number;
  sellValue: number;
  maxLot: number;
  first: number;
  last: number;
  high: number;
  low: number;
  bigLots: number;
  bigBuys: number;
  bigSells: number;
}

interface Bucket extends WindowStats {
  sec: number;
}

const empty = (): WindowStats => ({
  value: 0, trades: 0, buyValue: 0, sellValue: 0, maxLot: 0, first: 0, last: 0, high: 0, low: 0, bigLots: 0, bigBuys: 0, bigSells: 0,
});

function addTo(s: WindowStats, t: Trade, lot: number, big: boolean): void {
  if (s.trades === 0) {
    s.first = t.price;
    s.high = t.price;
    s.low = t.price;
  }
  s.trades += 1;
  s.value += t.value;
  if (t.side === 'buy') s.buyValue += t.value;
  if (t.side === 'sell') s.sellValue += t.value;
  s.maxLot = Math.max(s.maxLot, lot);
  s.last = t.price;
  s.high = Math.max(s.high, t.price);
  s.low = Math.min(s.low, t.price);
  if (big) {
    s.bigLots += 1;
    if (t.side === 'buy') s.bigBuys += 1;
    if (t.side === 'sell') s.bigSells += 1;
  }
}

function merge(into: WindowStats, b: WindowStats): void {
  if (b.trades === 0) return;
  if (into.trades === 0) {
    into.first = b.first;
    into.high = b.high;
    into.low = b.low;
  }
  into.trades += b.trades;
  into.value += b.value;
  into.buyValue += b.buyValue;
  into.sellValue += b.sellValue;
  into.maxLot = Math.max(into.maxLot, b.maxLot);
  into.last = b.last;
  into.high = Math.max(into.high, b.high);
  into.low = Math.min(into.low, b.low);
  into.bigLots += b.bigLots;
  into.bigBuys += b.bigBuys;
  into.bigSells += b.bigSells;
}

export class SymbolTape {
  private readonly buckets: Bucket[] = [];
  private readonly dayStats = empty();
  // High of the buckets already dropped from the 15-minute window.
  private prunedHigh = 0;
  private open = 0;
  private shares = 0;
  private readonly lots: number[] = [];
  private bigThreshold = Infinity;
  lastTime = 0;
  firstTime = 0;

  add(t: Trade): void {
    const lot = t.shares / 100;
    this.lots.push(lot);
    if (this.lots.length >= BIG_LOT_MIN_TRADES && this.lots.length % BIG_LOT_MIN_TRADES === 0) {
      this.bigThreshold = this.lotPercentile(BIG_LOT_PCT);
    }
    const big = lot >= this.bigThreshold;
    if (this.dayStats.trades === 0) {
      this.open = t.price;
      this.firstTime = t.time;
    }
    addTo(this.dayStats, t, lot, big);
    this.shares += t.shares;
    const sec = Math.floor(t.time / 1000);
    let bucket = this.buckets[this.buckets.length - 1];
    if (!bucket || bucket.sec !== sec) {
      bucket = { ...empty(), sec };
      this.buckets.push(bucket);
    }
    addTo(bucket, t, lot, big);
    this.lastTime = Math.max(this.lastTime, t.time);
    while (this.buckets.length > 0 && this.buckets[0]!.sec <= sec - KEEP_SEC) {
      this.prunedHigh = Math.max(this.prunedHigh, this.buckets.shift()!.high);
    }
  }

  // Trades in the last `sec` seconds before `now` (ms).
  window(sec: number, now: number): WindowStats {
    const from = Math.floor(now / 1000) - sec;
    const out = empty();
    for (const b of this.buckets) if (b.sec > from) merge(out, b);
    return out;
  }

  // The day's high before the last `sec` seconds (0 when nothing traded before then).
  highBefore(sec: number, now: number): number {
    const until = Math.floor(now / 1000) - sec;
    let high = this.prunedHigh;
    for (const b of this.buckets) if (b.sec <= until && b.trades > 0) high = Math.max(high, b.high);
    return high;
  }

  day(): WindowStats & { open: number; vwap: number } {
    return { ...this.dayStats, open: this.open, vwap: this.shares > 0 ? this.dayStats.value / this.shares : 0 };
  }

  lotPercentile(p: number): number {
    if (this.lots.length === 0) return 0;
    const sorted = [...this.lots].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
  }

  // Buy value / (buy + sell) over the window; 0.5 when nothing traded.
  hakaShare(sec: number, now: number): number {
    const w = this.window(sec, now);
    const total = w.buyValue + w.sellValue;
    return total > 0 ? w.buyValue / total : 0.5;
  }
}

export class Tape {
  private readonly bySymbol = new Map<string, SymbolTape>();

  add(trades: Trade[]): void {
    for (const t of trades) {
      let s = this.bySymbol.get(t.symbol);
      if (!s) {
        s = new SymbolTape();
        this.bySymbol.set(t.symbol, s);
      }
      s.add(t);
    }
  }

  get(symbol: string): SymbolTape | undefined {
    return this.bySymbol.get(symbol);
  }

  symbols(): string[] {
    return [...this.bySymbol.keys()];
  }
}
