import type { WatchConfig } from './config.js';
import type { SymbolBook } from './market/book.js';
import type { ScoreComponent, Style } from './types.js';
import type { StockInfo } from './universe.js';

// The point values behind every alert score, in one place. Setup points come from the detectors;
// risk penalties and the total are added when the alert is built.

export const comp = (label: string, points: number): ScoreComponent[] => (points === 0 ? [] : [{ label, points }]);

export function rvolPoints(rvol: number): number {
  if (rvol >= 8) return 25;
  if (rvol >= 5) return 18;
  if (rvol >= 3) return 10;
  return 0;
}

export function hakaPoints(share: number): number {
  if (share >= 0.9) return 20;
  if (share >= 0.75) return 15;
  if (share >= 0.6) return 10;
  return 0;
}

// 10 per swept level beyond the first, at most 20.
export const sweepPoints = (levels: number) => Math.min(20, Math.max(0, 10 * (levels - 1)));

export const POINTS = {
  bidWall: 12,
  offerThin: 10,
  brokerAcc: 10,
  foreignBuy: 5,
  bigLots: 15,
  dayHigh: 10,
  accumulation: 30,
  markup: 20,
  distribution: 40,
} as const;

// ---- Risk penalties and the total ------------------------------------------------------------


// Notations (X is counted as FCA instead), UMA, distance to ARA, fake walls seen today, a wide
// spread and the special monitoring board.
export function riskComponents(info: StockInfo, toAraPct: number | undefined, book?: SymbolBook): ScoreComponent[] {
  const notations = info.notations.filter((n) => n !== 'X').length;
  const fakes = book?.fakeWalls() ?? 0;
  const ara = toAraPct === undefined ? 0 : toAraPct < 0.05 ? -10 : toAraPct >= 0.15 ? 5 : 0;
  return [
    ...comp('notasi', -Math.min(15, 5 * notations)),
    ...comp('UMA', info.uma ? -10 : 0),
    ...comp('ARA', ara),
    ...comp('palsu', -Math.min(15, 5 * fakes)),
    ...comp('spread', book && book.spreadTicks() > 3 ? -5 : 0),
    ...comp('FCA', info.fca ? -10 : 0),
  ];
}

export function scoreOf(components: ScoreComponent[]): number {
  return Math.min(100, Math.max(0, components.reduce((s, c) => s + c.points, 0)));
}

export function passes(style: Style, score: number, cfg: WatchConfig): boolean {
  return style === 'exit' || score >= cfg.thresholds[style];
}
