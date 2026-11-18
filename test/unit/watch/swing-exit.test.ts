import { StockbitMcpError } from '../../../src/core/errors.js';
import { parseWatchConfig } from '../../../src/watch/config.js';
import { detectExit, holdingPlan } from '../../../src/watch/detect/exit.js';
import { detectSwing, swingList, type DailyBar } from '../../../src/watch/detect/swing.js';
import { SymbolTape, Tape } from '../../../src/watch/market/tape.js';
import { getAraArb, getBandar, getDailyBars, getForeignNet, getPortfolio, getWatchlistSymbols } from '../../../src/watch/rest.js';
import { Universe } from '../../../src/watch/universe.js';
import { fakeHttp } from './fake-http.js';
import { info, T0, trade } from './tape-helpers.js';

const cfg = parseWatchConfig({});

describe('swing list', () => {
  it('mixes holdings, accumulation, watchlist and tape leaders, capped by maxSymbols', () => {
    const tape = new Tape();
    const stocks = [];
    for (let i = 0; i < 80; i += 1) {
      const s = `S${String(i).padStart(3, '0')}`;
      stocks.push(info(s, 1e9));
      tape.add([trade(s, 1000, 100 + i * 10, 'buy', T0)]);
    }
    const list = swingList(tape, Universe.of(stocks), ['HOLD'], ['WL1', 'S079'], ['ACC1'], cfg);
    expect(list).toHaveLength(33); // 3 named + the 30 biggest on the tape (S079 once)
    expect(list.slice(0, 4)).toEqual(['HOLD', 'ACC1', 'WL1', 'S079']);
    expect(list).toContain('S078'); // biggest tape names come next
    expect(list).not.toContain('S000');
    expect(new Set(list).size).toBe(33);
    const capped = swingList(tape, Universe.of(stocks), ['HOLD'], ['WL1'], ['ACC1'], { ...cfg, swing: { ...cfg.swing, maxSymbols: 5 } });
    expect(capped).toEqual(['HOLD', 'ACC1', 'WL1', 'S079', 'S078']);
  });
});

function bars(n: number, f: (i: number) => Partial<DailyBar>): DailyBar[] {
  return Array.from({ length: n }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, '0')}`, open: 1000, high: 1010, low: 990, close: 1000, volume: 1000, ...f(i) }));
}

describe('swing accumulation', () => {
  const ok = bars(25, (i) => (i >= 22 ? { volume: 2000, close: 1040, high: 1050 } : { high: 1060 - (i === 10 ? 0 : 10) }));
  const ctx = { bars: ok, bandar: { accdist: 'Acc', topBuyers: [{ code: 'AK', value: 5e9 }, { code: 'YP', value: 3e9 }] }, foreign: 2e9, info: info('X', 1e10) };

  it('needs Acc, a close near the 20-day high and rising volume', () => {
    const sig = detectSwing('X', ctx, T0)!;
    expect(sig).toMatchObject({ style: 'swing', setup: 'swing_accumulation', title: 'Akumulasi bandar (swing)', action: 'BELI' });
    expect(sig.refs).toMatchObject({ last: 1040, nDayHigh: 1060, swingLow: 990 });
    expect(sig.facts).toContain('Top buyer: AK, YP');
    expect(sig.components.map((c) => c.label)).toEqual(expect.arrayContaining(['akumulasi swing', 'broker', 'asing']));
    expect(detectSwing('X', { ...ctx, bandar: { accdist: 'Dist', topBuyers: [] } }, T0)).toBeUndefined();
    expect(detectSwing('X', { ...ctx, bars: bars(25, () => ({ high: 1200 })) }, T0)).toBeUndefined();
    expect(detectSwing('X', { ...ctx, bars: bars(25, (i) => ({ close: 1040, high: 1050, volume: i >= 22 ? 1100 : 1000 })) }, T0)).toBeUndefined();
  });
});

describe('exit warnings', () => {
  const h = { symbol: 'X', lots: 10, avgPrice: 1000 };

  it('holding stop is the nearer of avg −5% and a holding bid wall; the day low is ignored', () => {
    // avg −5% = 950; bid wall 960 − 1 tick = 955 → nearer below 1010 is 955; R = 45 → tp1 1070, tp2 1115
    expect(holdingPlan(h, { last: 1010, dayLow: 1005, bidWall: 960 }, cfg)).toEqual({ stop: 955, tp1: 1070, tp2: 1115 });
    // no structure → 950; R = 50 → tp1 1075, tp2 1125
    expect(holdingPlan(h, { last: 1010 }, cfg)).toEqual({ stop: 950, tp1: 1075, tp2: 1125 });
  });

  it('exit warnings fire when the price crosses a level, not for a level already passed', () => {
    const t = new SymbolTape();
    t.add(trade('X', 1000, 10, 'buy', T0));
    t.add(trade('X', 950, 10, 'sell', T0 + 1000));
    const plan = { stop: 950, tp1: 1075, tp2: 1125 };
    // first look after start: nothing, whatever the level
    expect(detectExit(h, t, plan, T0 + 2000, cfg, undefined)).toEqual([]);
    // from 960 down to 950: stop crossed
    expect(detectExit(h, t, plan, T0 + 2000, cfg, 960).map((s) => [s.setup, s.action])).toEqual([['exit_stop', 'JUAL']]);
    // already under the stop on the previous look: no repeat
    expect(detectExit(h, t, plan, T0 + 2000, cfg, 945)).toEqual([]);
    t.add(trade('X', 1080, 10, 'buy', T0 + 3000));
    const target = detectExit(h, t, plan, T0 + 4000, cfg, 1070);
    expect(target.map((s) => [s.setup, s.action])).toEqual([['exit_target', 'AMANKAN']]);
    // no holding size or average price in the alert
    expect(target[0]!.facts.join(' ')).not.toMatch(/pegang|rata-rata|lot/);
    expect(detectExit(h, t, plan, T0 + 4000, cfg, 1078)).toEqual([]);
  });
});

describe('REST context', () => {
  it('reads ARA/ARB, bandar, foreign net, daily bars, portfolio and watchlists', async () => {
    const http = fakeHttp({
      '/company-price-feed/v2/orderbook/companies/BBCA': { data: { ara: { value: '10,150' }, arb: { value: '8,825' } } },
      '/marketdetectors/BBCA': { data: { bandar_detector: { avg: { accdist: 'Big Acc' } }, broker_summary: { brokers_buy: [{ netbs_broker_code: 'AK', bval: '3.71e+11' }] } } },
      '/order-trade/foreign-domestic/summary': { data: { net: { all: { raw: -1500000000 } } } },
      '/chartbit/BBCA/price/daily': { data: { chartbit: [{ unixdate: 1794873600, open: 2, high: 3, low: 1, close: 2, lot: 50 }, { unixdate: 1794787200, open: 1, high: 2, low: 1, close: 1, lot: 40 }] } },
      '/portfolio/v2/list': { data: { summary: { trading: { balance: 12000000 } }, results: [{ symbol: 'BBCA', qty: { balance: { lot: 10 } }, price: { average: { price: 9000 } } }] } },
      '/watchlist': { data: [{ watchlist_id: 7 }] },
      '/watchlist/7/symbols': { data: { symbols: ['TLKM', 'GOTO'] } },
    });
    expect(await getAraArb(http, 'BBCA')).toEqual({ ara: 10150, arb: 8825 });
    expect(await getBandar(http, 'BBCA')).toEqual({ accdist: 'Big Acc', topBuyers: [{ code: 'AK', value: 3.71e11 }] });
    expect(await getForeignNet(http, 'BBCA')).toBe(-1_500_000_000);
    const b = await getDailyBars(http, 'BBCA', 30);
    expect(b.map((x) => x.close)).toEqual([1, 2]); // oldest first
    expect(b[1]!.volume).toBe(50);
    expect(await getPortfolio(http)).toEqual({ cash: 12_000_000, holdings: [{ symbol: 'BBCA', lots: 10, avgPrice: 9000 }] });
    expect(await getWatchlistSymbols(http)).toEqual(['TLKM', 'GOTO']);
    expect(http.calls.find((c) => c.path === '/portfolio/v2/list')?.host).toBe('carina');
    expect(http.calls.find((c) => c.path === '/marketdetectors/BBCA')?.query).toMatchObject({ period: 'BROKER_SUMMARY_PERIOD_LAST_7_DAYS' });
  });

  it('rest helpers return undefined without a trading session', async () => {
    const http = {
      async request(): Promise<never> {
        throw new StockbitMcpError('TRADING_AUTH_REQUIRED', 'no trading session');
      },
    };
    expect(await getPortfolio(http)).toBeUndefined();
    expect(await getAraArb(http, 'BBCA')).toEqual({});
  });
});
