import type { ScoreComponent } from './types.js';

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
