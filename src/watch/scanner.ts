import { tickDistance } from '../core/ticks.js';
import type { WatchConfig } from './config.js';
import type { SymbolTape, Tape } from './market/tape.js';
import type { Universe } from './universe.js';

// Picks the stocks worth a close look from the whole-market tape: a momentum shortlist (buyers
// pushing now) and an accumulation shortlist (heavy trading held in a narrow range, the quiet
// collecting a momentum score never sees). Both get the order book subscribed.

export interface Focus {
  momentum: string[];
  accumulation: string[];
}

type Scorer = (symbol: string, tape: SymbolTape, expectedPerMin: number, now: number) => number;

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

// 0-100. Terms, each capped at its weight: HAKA-value RVOL over 5 min (35), HAKA share (25), price
// change in ticks (20), trades against the stock's own pace today (10), big buy lots (10). RVOL is
// taken on buyer-initiated value: momentum here means buyers lifting offers.
export function momentumScore(s: SymbolTape, expectedPerMin: number, now: number): number {
  const w = s.window(300, now);
  if (w.trades === 0 || expectedPerMin <= 0) return 0;
  const rvolBuy = w.buyValue / (5 * expectedPerMin);
  const haka = s.hakaShare(300, now);
  const ticks = tickDistance(w.first, w.last);
  const day = s.day();
  const firstMs = s.firstTime;
  const elapsedMin = Math.max(5, (now - firstMs) / 60_000);
  const pace = day.trades / (elapsedMin / 5);
  const tradeRatio = pace > 0 ? w.trades / pace : 0;
  const score =
    35 * clamp01(rvolBuy / 8) +
    25 * clamp01((haka - 0.5) / 0.4) +
    20 * clamp01(ticks / 5) +
    10 * clamp01((tradeRatio - 1) / 3) +
    10 * clamp01(w.bigBuys / 3);
  return Math.round(score);
}

// 0-100, and 0 unless all hold over 15 min: RVOL ≥ accumRvolMin, range ≤ accumRangeTicks ticks,
// HAKI share ≥ accumHakiMin, and the price not below where the window started.
export function accumulationScore(s: SymbolTape, expectedPerMin: number, now: number, cfg: WatchConfig): number {
  const w = s.window(900, now);
  if (w.trades === 0 || expectedPerMin <= 0) return 0;
  const rvol = w.value / (15 * expectedPerMin);
  const haki = 1 - s.hakaShare(900, now);
  const ok =
    rvol >= cfg.day.accumRvolMin &&
    tickDistance(w.low, w.high) <= cfg.day.accumRangeTicks &&
    haki >= cfg.day.accumHakiMin &&
    w.last >= w.first;
  if (!ok) return 0;
  return Math.round(50 + 50 * clamp01((rvol / cfg.day.accumRvolMin - 1) / 2));
}

class Shortlist {
  private readonly members = new Map<string, number>(); // symbol → since

  constructor(
    private readonly size: number,
    private readonly margin: number,
    private readonly minStayMs: number,
  ) {}

  update(scores: Map<string, number>, now: number, exclude: Set<string>): string[] {
    for (const s of exclude) this.members.delete(s);
    const ranked = [...scores].filter(([s, v]) => v > 0 && !exclude.has(s)).sort((a, b) => b[1] - a[1]);
    for (const [s] of ranked) {
      if (this.members.size >= this.size) break;
      if (!this.members.has(s)) this.members.set(s, now);
    }
    for (const [challenger, score] of ranked) {
      if (this.members.has(challenger)) continue;
      let weakest: string | undefined;
      let weakestScore = Infinity;
      for (const [m, since] of this.members) {
        const v = scores.get(m) ?? 0;
        if (now - since >= this.minStayMs && v < weakestScore) {
          weakest = m;
          weakestScore = v;
        }
      }
      if (weakest === undefined) break;
      if (score > weakestScore * (1 + this.margin)) {
        this.members.delete(weakest);
        this.members.set(challenger, now);
      }
    }
    return [...this.members.keys()];
  }
}

export class Scanner {
  private readonly momentumList: Shortlist;
  private readonly accumulationList: Shortlist;
  private readonly scorers: { momentum: Scorer; accumulation: Scorer };

  constructor(
    private readonly tape: Tape,
    private readonly universe: Universe,
    private readonly cfg: WatchConfig,
    scorers?: Partial<{ momentum: Scorer; accumulation: Scorer }>,
  ) {
    const { size, enterMargin, minStaySec } = cfg.scanner;
    this.momentumList = new Shortlist(size, enterMargin, minStaySec * 1000);
    this.accumulationList = new Shortlist(size, enterMargin, minStaySec * 1000);
    this.scorers = {
      momentum: scorers?.momentum ?? ((_, s, e, now) => momentumScore(s, e, now)),
      accumulation: scorers?.accumulation ?? ((_, s, e, now) => accumulationScore(s, e, now, cfg)),
    };
  }

  recompute(now: number): Focus {
    const mom = new Map<string, number>();
    const acc = new Map<string, number>();
    for (const symbol of this.tape.symbols()) {
      const s = this.tape.get(symbol)!;
      const expected = this.universe.expectedPerMinute(symbol);
      if (expected === undefined || s.window(300, now).value < this.cfg.alerts.minValue5m) continue;
      mom.set(symbol, this.scorers.momentum(symbol, s, expected, now));
      acc.set(symbol, this.scorers.accumulation(symbol, s, expected, now));
    }
    const momentum = this.momentumList.update(mom, now, new Set());
    const accumulation = this.accumulationList.update(acc, now, new Set(momentum));
    return { momentum, accumulation };
  }
}
