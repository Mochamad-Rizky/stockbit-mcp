import { parseWatchConfig } from '../../../src/watch/config.js';
import { detectIntraday, isDistribution, type IntradayInput } from '../../../src/watch/detect/intraday.js';
import { SymbolBook } from '../../../src/watch/market/book.js';
import { SymbolTape } from '../../../src/watch/market/tape.js';
import type { BookSide, Signal } from '../../../src/watch/types.js';
import { info, T0, trade } from './tape-helpers.js';

const cfg = parseWatchConfig({});
const E = 10_000_000; // expected IDR per minute
const NOW = T0 + 30 * 60_000;

function base(t: SymbolTape, price: number, untilMs: number, lots = 20) {
  // 25 minutes of quiet two-sided trading before the action.
  for (let ms = untilMs - 25 * 60_000; ms < untilMs - 5 * 60_000; ms += 20_000) {
    t.add(trade('X', price, lots, (ms / 20_000) % 2 ? 'buy' : 'sell', ms));
  }
}
function offers(levels: [number, number][]): BookSide {
  return { symbol: 'X', side: 'offer', time: 0, total: 0, levels: levels.map(([price, shares]) => ({ price, orders: 1, shares })) };
}
function bidsBook(levels: [number, number][]): BookSide {
  return { symbol: 'X', side: 'bid', time: 0, total: 0, levels: levels.map(([price, shares]) => ({ price, orders: 1, shares })) };
}
const input = (tape: SymbolTape, extra: Partial<IntradayInput> = {}): IntradayInput => ({
  symbol: 'X', tape, info: info('X', E * 320), expectedPerMin: E, cfg, ...extra,
});
const setups = (s: Signal[]) => s.map((x) => x.setup).sort();

describe('scalp detectors', () => {
  it('haka sweep fires when three offer levels go in 10 s with 2x value', () => {
    const t = new SymbolTape();
    base(t, 270, NOW);
    const b = new SymbolBook(cfg.book);
    b.apply(offers([[280, 10_000], [282, 10_000]]), NOW);
    b.apply(bidsBook([[278, 10_000]]), NOW);
    // 8 s of buys from 274 to 278: 3 levels (274, 276, 278), 30 M ≥ 2 × 10 M.
    for (let i = 0; i < 8; i += 1) t.add(trade('X', 274 + 2 * Math.floor(i / 3), 250, 'buy', NOW - 8_000 + i * 1000));
    const sig = detectIntraday(input(t, { book: b }), NOW).find((s) => s.setup === 'haka_sweep');
    expect(sig).toMatchObject({ style: 'scalp', title: 'HAKA sapu offer', action: 'BELI' });
    expect(sig!.components.find((c) => c.label === 'sapu')?.points).toBe(20);
    expect(sig!.facts.some((f) => f.startsWith('Sapu 3 level offer 274→280'))).toBe(true);
  });

  it('no sweep when the value is below 2x', () => {
    const t = new SymbolTape();
    base(t, 270, NOW);
    const b = new SymbolBook(cfg.book);
    b.apply(offers([[280, 10_000]]), NOW);
    for (let i = 0; i < 30; i += 1) t.add(trade('X', 272, 200, 'sell', NOW - 200_000 + i * 3_000)); // passes the 5-min floor
    for (let i = 0; i < 8; i += 1) t.add(trade('X', 274 + 2 * Math.floor(i / 3), 20, 'buy', NOW - 8_000 + i * 1000));
    expect(setups(detectIntraday(input(t, { book: b }), NOW))).not.toContain('haka_sweep');
  });

  it('offer thinning fires when the top offers halve without the price falling', () => {
    const t = new SymbolTape();
    base(t, 270, NOW, 400);
    for (let i = 0; i < 6; i += 1) t.add(trade('X', 270, 400, 'buy', NOW - 50_000 + i * 8_000));
    const b = new SymbolBook(cfg.book);
    b.apply(offers([[272, 40_000], [274, 40_000], [276, 20_000]]), NOW - 50_000);
    b.apply(offers([[272, 10_000], [274, 20_000], [276, 15_000]]), NOW);
    expect(setups(detectIntraday(input(t, { book: b }), NOW))).toContain('offer_thinning');
  });

  it('big lot burst needs three big buy lots in 30 s', () => {
    const t = new SymbolTape();
    base(t, 500, NOW);
    for (let i = 0; i < 3; i += 1) t.add(trade('X', 500, 5_000, 'buy', NOW - 20_000 + i * 5_000));
    expect(setups(detectIntraday(input(t), NOW))).toContain('big_lot_burst');
    const t2 = new SymbolTape();
    base(t2, 500, NOW);
    for (let i = 0; i < 2; i += 1) t2.add(trade('X', 500, 5_000, 'buy', NOW - 20_000 + i * 5_000));
    expect(setups(detectIntraday(input(t2), NOW))).not.toContain('big_lot_burst');
  });
});

describe('day detectors', () => {
  it('rvol spike with HAKA dominance and a rising price', () => {
    const t = new SymbolTape();
    base(t, 1000, NOW);
    for (let i = 0; i < 50; i += 1) t.add(trade('X', 1000 + 5 * Math.floor(i / 10), 400, i % 5 ? 'buy' : 'sell', NOW - 290_000 + i * 5_000));
    const sig = detectIntraday(input(t), NOW).find((s) => s.setup === 'rvol_spike');
    expect(sig).toMatchObject({ style: 'day', title: 'Volume meledak' });
    expect(sig!.components.find((c) => c.label === 'RVOL')?.points).toBe(25);
  });

  it('no rvol spike when sellers dominate', () => {
    const t = new SymbolTape();
    base(t, 1000, NOW);
    for (let i = 0; i < 50; i += 1) t.add(trade('X', 1000 + 5 * Math.floor(i / 10), 400, i % 5 ? 'sell' : 'buy', NOW - 290_000 + i * 5_000));
    expect(setups(detectIntraday(input(t), NOW))).not.toContain('rvol_spike');
  });

  it('day high break needs a new high on volume', () => {
    const t = new SymbolTape();
    base(t, 1000, NOW);
    t.add(trade('X', 1010, 20, 'buy', NOW - 10 * 60_000));
    for (let i = 0; i < 20; i += 1) t.add(trade('X', 1005, 200, 'buy', NOW - 280_000 + i * 12_000));
    t.add(trade('X', 1015, 200, 'buy', NOW - 5_000));
    expect(setups(detectIntraday(input(t), NOW))).toContain('day_high_break');
  });

  it('accumulation needs the bid wall to persist 60 s and says TUNGGU', () => {
    const t = new SymbolTape();
    for (let i = 0; i < 180; i += 1) t.add(trade('X', i % 3 === 0 ? 498 : 496, 150, i % 4 === 0 ? 'buy' : 'sell', NOW - 895_000 + i * 5_000));
    t.add(trade('X', 498, 10, 'buy', NOW - 1000));
    const young = new SymbolBook(cfg.book);
    const wall: [number, number][] = [[496, 900_000], [494, 10_000], [492, 10_000], [490, 10_000], [488, 10_000], [486, 10_000]];
    young.apply(bidsBook(wall), NOW - 30_000);
    expect(setups(detectIntraday(input(t, { book: young }), NOW))).not.toContain('accumulation');
    const old = new SymbolBook(cfg.book);
    old.apply(bidsBook(wall), NOW - 90_000);
    const sig = detectIntraday(input(t, { book: old }), NOW).find((s) => s.setup === 'accumulation');
    expect(sig).toMatchObject({ action: 'TUNGGU', title: 'Akumulasi' });
    expect(sig!.refs.bidWall).toBe(496);
    expect(setups(detectIntraday(input(t, { book: old }), NOW))).not.toContain('distribution');
  });

  it('markup follows a recent accumulation', () => {
    const t = new SymbolTape();
    base(t, 400, NOW);
    for (let i = 0; i < 30; i += 1) t.add(trade('X', 402 + 2 * Math.floor(i / 10), 300, 'buy', NOW - 290_000 + i * 9_000));
    t.add(trade('X', 406, 300, 'buy', NOW - 1000));
    expect(setups(detectIntraday(input(t, { accumulatedAt: NOW - 20 * 60_000, accumulationTop: 402 }), NOW))).toContain('markup');
    expect(setups(detectIntraday(input(t, { accumulatedAt: NOW - 40 * 60_000, accumulationTop: 402 }), NOW))).not.toContain('markup');
  });

  it('distribution: price held while big HAKI lots dominate says HINDARI', () => {
    const t = new SymbolTape();
    base(t, 800, NOW, 50);
    for (let i = 0; i < 40; i += 1) t.add(trade('X', 815 + (i % 2) * 5, i % 10 === 0 ? 30 : 4_000, i % 10 === 0 ? 'buy' : 'sell', NOW - 850_000 + i * 20_000));
    t.add(trade('X', 820, 10, 'buy', NOW - 500));
    expect(isDistribution(t, NOW, cfg)).toBe(true);
    expect(detectIntraday(input(t), NOW).find((s) => s.setup === 'distribution')?.action).toBe('HINDARI');
  });

  it('FCA stock never gets haka sweep and carries the board fact', () => {
    const t = new SymbolTape();
    base(t, 270, NOW);
    const b = new SymbolBook(cfg.book);
    b.apply(offers([[280, 10_000]]), NOW);
    for (let i = 0; i < 8; i += 1) t.add(trade('X', 274 + 2 * Math.floor(i / 3), 250, 'buy', NOW - 8_000 + i * 1000));
    for (let i = 0; i < 50; i += 1) t.add(trade('X', 280, 300, 'buy', NOW - 290_000 + i * 5_000));
    const out = detectIntraday(input(t, { book: b, info: info('X', E * 320, { fca: true, notations: ['X'] }) }), NOW);
    expect(out.length).toBeGreaterThan(0);
    expect(setups(out).every((s) => s === 'rvol_spike' || s === 'distribution')).toBe(true);
    expect(out.every((s) => s.facts.includes('Papan pemantauan khusus (lelang berkala)'))).toBe(true);
  });

  it('extended price turns BELI into TUNGGU', () => {
    const t = new SymbolTape();
    base(t, 1000, NOW);
    for (let i = 0; i < 50; i += 1) t.add(trade('X', 1000 + 10 * Math.floor(i / 5), 400, 'buy', NOW - 290_000 + i * 5_000));
    const sig = detectIntraday(input(t), NOW).find((s) => s.setup === 'rvol_spike');
    expect(sig?.action).toBe('TUNGGU');
  });

  it('stays quiet below the 5-minute value floor', () => {
    const t = new SymbolTape();
    for (let i = 0; i < 20; i += 1) t.add(trade('X', 100, 10, 'buy', NOW - 100_000 + i * 5_000));
    expect(detectIntraday(input(t, { expectedPerMin: 1000 }), NOW)).toEqual([]);
  });
});
