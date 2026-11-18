import { SymbolTape, Tape } from '../../../src/watch/market/tape.js';
import { T0, trade } from './tape-helpers.js';

describe('SymbolTape', () => {
  it('window sums only the last N seconds', () => {
    const t = new SymbolTape();
    t.add(trade('A', 100, 10, 'buy', T0));
    t.add(trade('A', 101, 20, 'sell', T0 + 30_000));
    t.add(trade('A', 102, 30, 'buy', T0 + 59_000));
    const w = t.window(30, T0 + 59_500);
    expect(w).toMatchObject({ trades: 2, value: 101 * 2000 + 102 * 3000, buyValue: 102 * 3000, sellValue: 101 * 2000, maxLot: 30, first: 101, last: 102, high: 102, low: 101 });
    expect(t.window(120, T0 + 59_500).trades).toBe(3);
    expect(t.window(10, T0 + 120_000).trades).toBe(0);
  });

  it('HAKA share is buy value over buy+sell', () => {
    const t = new SymbolTape();
    t.add(trade('A', 100, 30, 'buy', T0));
    t.add(trade('A', 100, 10, 'sell', T0 + 1000));
    expect(t.hakaShare(60, T0 + 2000)).toBeCloseTo(0.75);
    expect(t.hakaShare(60, T0 + 500_000)).toBe(0.5);
  });

  it('vwap is value over shares and open is the first price', () => {
    const t = new SymbolTape();
    t.add(trade('A', 100, 10, 'buy', T0));
    t.add(trade('A', 110, 30, 'buy', T0 + 1000));
    expect(t.day()).toMatchObject({ open: 100, last: 110, high: 110, low: 100, trades: 2, vwap: 107.5 });
  });

  it('drops buckets older than 15 minutes but keeps the day', () => {
    const t = new SymbolTape();
    t.add(trade('A', 100, 10, 'buy', T0));
    t.add(trade('A', 100, 10, 'buy', T0 + 16 * 60_000));
    expect(t.window(3600, T0 + 16 * 60_000).trades).toBe(1);
    expect(t.day().trades).toBe(2);
  });

  it('lot percentile over the day and big lots by side', () => {
    const t = new SymbolTape();
    for (let i = 1; i <= 100; i += 1) t.add(trade('A', 100, i, 'buy', T0 - 60_000 + i));
    expect(t.lotPercentile(0.99)).toBe(99);
    expect(t.lotPercentile(0.5)).toBe(50);
    t.add(trade('A', 100, 500, 'buy', T0 + 2000));
    t.add(trade('A', 100, 400, 'sell', T0 + 2001));
    const w = t.window(5, T0 + 2002);
    expect(w.bigBuys).toBe(1);
    expect(w.bigSells).toBe(1);
    expect(w.bigLots).toBe(2);
  });

  it('counts no big lots before 50 trades', () => {
    const t = new SymbolTape();
    t.add(trade('A', 100, 1, 'buy', T0));
    t.add(trade('A', 100, 9999, 'buy', T0 + 1));
    expect(t.window(5, T0 + 2).bigLots).toBe(0);
  });
});

describe('Tape', () => {
  it('keeps one tape per symbol', () => {
    const tape = new Tape();
    tape.add([trade('A', 100, 1, 'buy', T0), trade('B', 200, 1, 'sell', T0)]);
    expect(tape.symbols().sort()).toEqual(['A', 'B']);
    expect(tape.get('B')?.day().trades).toBe(1);
    expect(tape.get('C')).toBeUndefined();
  });
});
