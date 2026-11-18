import { onTick } from '../../../src/core/ticks.js';
import { parseWatchConfig } from '../../../src/watch/config.js';
import { SymbolBook } from '../../../src/watch/market/book.js';
import { makePlan } from '../../../src/watch/plan.js';
import { passes, riskComponents, scoreOf } from '../../../src/watch/score.js';
import type { Signal } from '../../../src/watch/types.js';
import { info } from './tape-helpers.js';

const defaults = parseWatchConfig({});
function sig(over: Partial<Signal> & { refs: Signal['refs'] }): Signal {
  return { style: 'scalp', symbol: 'SMRA', setup: 'haka_sweep', title: 'HAKA sapu offer', action: 'BELI', facts: [], components: [], at: 0, ...over };
}

describe('makePlan', () => {
  it('builds the SMRA example plan', () => {
    // stop = bid wall 268 − 1 tick = 266 (≤ 272 − 2 ticks = 268); R = 8; tp1 = 274 + 12; tp2 = 274 + 20;
    // lots = min(120 000 / 800 = 150, cash 12 000 000 / 27 400 = 437, 5% × 2.1 M / 27 400 = 3 832) = 150
    const p = makePlan(sig({ setup: 'haka_sweep', refs: { last: 274, bidWall: 268, dayLow: 262 } }),
      { ara: 334, arb: 234, cash: 12_000_000, value5m: 2_100_000_000, cfg: defaults });
    expect(p).toMatchObject({ action: 'BELI', entryHigh: 274, entryLow: 272, stop: 266, tp1: 286, tp2: 294, rr: 1.5, lots: 150, riskIdr: 120_000, lotBasis: 'balance' });
  });

  it('picks the highest structural level that leaves room', () => {
    // vwap 270 − 1 tick = 268 is allowed (≤ 268) and beats the wall: stop 268, R 6, tp1 ceilTick(283) = 284
    expect(makePlan(sig({ setup: 'haka_sweep', refs: { last: 274, bidWall: 268, dayLow: 262, vwap: 270 } }),
      { cash: 12_000_000, value5m: 2_100_000_000, cfg: defaults })).toMatchObject({ stop: 268, tp1: 284, tp2: 290 });
  });

  it('caps the first target at a persisting offer wall', () => {
    expect(makePlan(sig({ refs: { last: 274, bidWall: 268, offerWall: 280 } }), { value5m: 2e9, cfg: defaults })).toMatchObject({ tp1: 278 });
  });

  it('falls back to 3% under the entry without structure, and to a fixed amount without cash', () => {
    const p = makePlan(sig({ refs: { last: 1000 } }), { value5m: 5e9, cfg: defaults });
    expect(p).toMatchObject({ entryHigh: 1000, entryLow: 995, stop: 965, lotBasis: 'fixed', riskIdr: 100_000 });
    expect(p.lots).toBe(Math.floor(100_000 / (35 * 100)));
  });

  it('clamps to ARA and stays on tick', () => {
    const p = makePlan(sig({ refs: { last: 197, dayLow: 190 } }), { ara: 200, arb: 150, cash: 12_000_000, value5m: 1e9, cfg: defaults });
    for (const v of [p.entryLow, p.entryHigh, p.stop, p.tp1, p.tp2]) {
      expect(onTick(v)).toBe(true);
      expect(v).toBeLessThanOrEqual(200);
    }
    expect(p.tp1).toBe(200);
  });

  it('zero risk gives zero lots', () => {
    const p = makePlan(sig({ refs: { last: 274, dayLow: 262 } }), { arb: 274, cash: 12_000_000, value5m: 1e9, cfg: defaults });
    expect(p.lots).toBe(0);
    expect(p.note).toBe('Stop terlalu dekat; tentukan sendiri');
    expect(Number.isFinite(p.rr)).toBe(true);
  });

  it('caps lots by liquidity on thin stocks', () => {
    const p = makePlan(sig({ refs: { last: 100, dayLow: 95 } }), { cash: 12_000_000, value5m: 20_000_000, cfg: defaults });
    expect(p.lots).toBe(100);
  });

  it('TUNGGU waits at the bid wall', () => {
    const p = makePlan(sig({ style: 'day', setup: 'accumulation', action: 'TUNGGU', refs: { last: 498, bidWall: 496, dayLow: 480 } }), { value5m: 1e9, cfg: defaults });
    expect(p).toMatchObject({ action: 'TUNGGU', waitPrice: 496, entryHigh: 496, entryLow: 494 });
  });

  it('swing plans use the swing low or the 20-day average', () => {
    const p = makePlan(sig({ style: 'swing', setup: 'swing_accumulation', refs: { last: 1040, swingLow: 990, ma20: 1002.4, nDayHigh: 1060 } }), { cfg: defaults });
    // candidates below 1035: swing low − 1 tick = 985, floorTick(ma20) = 1000 → 1000; R = 40 → tp1 1100 capped by the 20-day high → 1055
    expect(p).toMatchObject({ stop: 1000, tp1: 1055, tp2: 1140 });
  });
});

describe('score', () => {
  it('scores with penalties and clamps to 0..100', () => {
    const c = [{ label: 'RVOL', points: 25 }, { label: 'HAKA', points: 20 }, { label: 'sapu', points: 20 }, { label: 'bid', points: 12 }, { label: 'notasi', points: -5 }];
    expect(scoreOf(c)).toBe(72);
    expect(scoreOf([...c, { label: 'x', points: 50 }])).toBe(100);
    expect(scoreOf([{ label: 'x', points: -30 }])).toBe(0);
  });

  it('lists the risk components', () => {
    const book = new SymbolBook(defaults.book);
    book.apply({ symbol: 'A', side: 'bid', time: 0, total: 0, levels: [{ price: 100, orders: 1, shares: 1 }] }, 0);
    book.apply({ symbol: 'A', side: 'offer', time: 0, total: 0, levels: [{ price: 105, orders: 1, shares: 1 }] }, 0);
    expect(riskComponents(info('A', 1, { notations: ['E', 'X'], fca: true, uma: true }), 0.03, book)).toEqual([
      { label: 'notasi', points: -5 }, { label: 'UMA', points: -10 }, { label: 'ARA', points: -10 }, { label: 'spread', points: -5 }, { label: 'FCA', points: -10 },
    ]);
    expect(riskComponents(info('A', 1, { notations: ['E', 'L', 'M', 'D'] }), 0.2)).toEqual([{ label: 'notasi', points: -15 }, { label: 'ARA', points: 5 }]);
  });

  it('passes the style threshold; exits always pass', () => {
    expect(passes('scalp', 70, defaults)).toBe(true);
    expect(passes('scalp', 69, defaults)).toBe(false);
    expect(passes('swing', 60, defaults)).toBe(true);
    expect(passes('exit', 0, defaults)).toBe(true);
  });
});
