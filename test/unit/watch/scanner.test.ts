import { tickDistance } from '../../../src/core/ticks.js';
import { parseWatchConfig } from '../../../src/watch/config.js';
import { Tape } from '../../../src/watch/market/tape.js';
import { accumulationScore, momentumScore, Scanner } from '../../../src/watch/scanner.js';
import { Universe } from '../../../src/watch/universe.js';
import { info, T0, trade } from './tape-helpers.js';

const cfg = parseWatchConfig({});
// valuema20 3.2 B → 10 M IDR per minute expected.
const BASE = 3_200_000_000;

function spike(tape: Tape, symbol: string, startPrice: number, now: number) {
  // 5 minutes: steady baseline trades, then a HAKA burst stepping the price up.
  for (let i = 0; i < 30; i += 1) tape.add([trade(symbol, startPrice, 10, i % 2 ? 'buy' : 'sell', now - 600_000 + i * 10_000)]);
  for (let i = 0; i < 60; i += 1) tape.add([trade(symbol, startPrice + 2 * Math.floor(i / 12), 500, 'buy', now - 290_000 + i * 4_000)]);
}

describe('scanner scores', () => {
  it('ranks a HAKA-heavy RVOL spike above a mild mover', () => {
    const tape = new Tape();
    const now = T0 + 600_000;
    spike(tape, 'AAAA', 270, now);
    for (let i = 0; i < 60; i += 1) tape.add([trade('BBBB', 270, 120, i % 3 ? 'buy' : 'sell', now - 290_000 + i * 4_000)]);
    const a = momentumScore(tape.get('AAAA')!, BASE / 320, now);
    const b = momentumScore(tape.get('BBBB')!, BASE / 320, now);
    expect(a).toBeGreaterThan(70);
    expect(b).toBeLessThan(a);
    expect(a).toBeLessThanOrEqual(100);
  });

  it('a quiet narrow-range high-value stock scores as accumulation, not momentum', () => {
    const tape = new Tape();
    const now = T0 + 900_000;
    // 15 min of heavy HAKI absorbed at 500-502, price not falling.
    for (let i = 0; i < 180; i += 1) tape.add([trade('ACCU', i % 3 === 0 ? 502 : 500, 150, i % 4 === 0 ? 'buy' : 'sell', now - 895_000 + i * 5_000)]);
    tape.add([trade('ACCU', 502, 10, 'buy', now - 1000)]);
    const s = tape.get('ACCU')!;
    expect(accumulationScore(s, BASE / 320, now, cfg)).toBeGreaterThanOrEqual(50);
    expect(momentumScore(s, BASE / 320, now)).toBeLessThan(40);
  });

  it('tick distance is signed and crosses bands', () => {
    expect(tickDistance(196, 204)).toBe(6);
    expect(tickDistance(204, 196)).toBe(-6);
  });
});

describe('Scanner hysteresis', () => {
  function scannerWith(scores: Map<string, number>) {
    const tape = new Tape();
    const universe = Universe.of([...scores.keys()].map((s) => info(s, BASE)));
    for (const s of scores.keys()) tape.add([trade(s, 1000, 1000, 'buy', T0)]); // 100 M in 5 min, above the floor
    const sc = new Scanner(tape, universe, { ...cfg, scanner: { ...cfg.scanner, size: 2 } }, {
      momentum: (sym) => scores.get(sym) ?? 0,
      accumulation: () => 0,
    });
    return { sc, tape };
  }

  it('a challenger 5% better does not replace a member, 15% better does after min stay', () => {
    const scores = new Map([['A', 80], ['B', 60], ['C', 10]]);
    const { sc } = scannerWith(scores);
    expect(sc.recompute(T0 + 1000).momentum.sort()).toEqual(['A', 'B']);
    scores.set('C', 70);
    expect(sc.recompute(T0 + 60_000).momentum.sort()).toEqual(['A', 'B']); // B has not stayed 120 s
    scores.set('C', 63);
    expect(sc.recompute(T0 + 200_000).momentum.sort()).toEqual(['A', 'B']); // 5% better is not enough
    scores.set('C', 70);
    expect(sc.recompute(T0 + 210_000).momentum.sort()).toEqual(['A', 'C']);
  });

  it('ignores stocks below the 5-minute value floor or without a baseline', () => {
    const tape = new Tape();
    tape.add([trade('THIN', 100, 10, 'buy', T0)]); // 100 k
    tape.add([trade('NOBASE', 1000, 1000, 'buy', T0)]);
    const universe = Universe.of([info('THIN', BASE), info('NOBASE', 0)]);
    const sc = new Scanner(tape, universe, cfg, { momentum: () => 99, accumulation: () => 99 });
    expect(sc.recompute(T0 + 1000)).toEqual({ momentum: [], accumulation: [] });
  });

  it('keeps a stock out of accumulation when it is already a momentum member', () => {
    const { sc } = scannerWith(new Map([['A', 80]]));
    expect(sc.recompute(T0 + 1000)).toEqual({ momentum: ['A'], accumulation: [] });
  });
});
