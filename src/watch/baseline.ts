import { volumeProfileAt } from './clock.js';
import type { WatchConfig } from './config.js';
import type { StockInfo, Universe } from './universe.js';

// What a stock normally trades over a window: the IDR an RVOL is measured against. The market
// baseline spreads the 20-day average over the day by the intraday volume profile, so the open is
// not mistaken for a spike, and eases liquid stocks by rvolScale.

// Expected IDR traded over the `sec` seconds before `now` (ms).
export type Baseline = (sec: number, now: number) => number;

export const flatBaseline =
  (perMinute: number): Baseline =>
  (sec) =>
    (perMinute * sec) / 60;

export const isLiquid = (info: StockInfo | undefined, cfg: WatchConfig): boolean =>
  (info?.valueMa20 ?? 0) >= cfg.liquidity.liquidMin;

// The profile summed over the window, in average-minute units.
export function profileMinutes(sec: number, now: number): number {
  let total = 0;
  let t = now - sec * 1000;
  while (t < now) {
    const next = Math.min(now, (Math.floor(t / 60_000) + 1) * 60_000);
    total += (volumeProfileAt(t) * (next - t)) / 60_000;
    t = next;
  }
  return total;
}

export function marketBaseline(universe: Universe, cfg: WatchConfig, symbol: string): Baseline | undefined {
  const perMinute = universe.expectedPerMinute(symbol);
  if (perMinute === undefined) return undefined;
  const scale = isLiquid(universe.get(symbol), cfg) ? cfg.liquidity.rvolScale : 1;
  return (sec, now) => (perMinute * profileMinutes(sec, now)) / scale;
}
