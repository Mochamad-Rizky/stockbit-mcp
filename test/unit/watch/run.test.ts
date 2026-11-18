import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StockbitMcpError } from '../../../src/core/errors.js';
import { createLogger } from '../../../src/core/logger.js';
import { phaseAt, swingTimes } from '../../../src/watch/clock.js';
import { parseWatchConfig } from '../../../src/watch/config.js';
import { Notifier, type Sender } from '../../../src/watch/notify/notifier.js';
import { Recorder } from '../../../src/watch/recorder.js';
import { AUTH_NOTICE, memoSuccess, Pipeline, replay, WatchRunner } from '../../../src/watch/run.js';
import type { Alert, Channels } from '../../../src/watch/types.js';
import { Universe } from '../../../src/watch/universe.js';
import { fakeHttp } from './fake-http.js';
import { bookBody, orderbookFrame, tradeBatchFrame } from './pb-helpers.js';
import { info } from './tape-helpers.js';

const cfg = parseWatchConfig({});
const J = (s: string) => Date.parse(`${s}+07:00`);

describe('market clock', () => {
  it('phases for a Friday', () => {
    expect(phaseAt(J('2026-11-20T08:50:00'))).toBe('preopen');
    expect(phaseAt(J('2026-11-20T11:29:00'))).toBe('session1');
    expect(phaseAt(J('2026-11-20T11:31:00'))).toBe('break');
    expect(phaseAt(J('2026-11-20T13:45:00'))).toBe('break');
    expect(phaseAt(J('2026-11-20T14:01:00'))).toBe('session2');
    expect(phaseAt(J('2026-11-20T15:55:00'))).toBe('preclose');
    expect(phaseAt(J('2026-11-20T16:05:00'))).toBe('after');
    expect(phaseAt(J('2026-11-21T10:00:00'))).toBe('closed'); // Saturday
    expect(phaseAt(J('2026-11-19T12:30:00'))).toBe('break'); // Thursday
    expect(phaseAt(J('2026-11-19T13:31:00'))).toBe('session2');
  });

  it('swing times: after the break starts, 15:00 and 16:10', () => {
    expect(swingTimes(J('2026-11-20T10:00:00'))).toEqual([J('2026-11-20T11:35:00'), J('2026-11-20T15:00:00'), J('2026-11-20T16:10:00')]);
    expect(swingTimes(J('2026-11-19T10:00:00'))[0]).toBe(J('2026-11-19T12:05:00'));
  });

  it('has no swing times on weekends', () => {
    expect(swingTimes(J('2026-11-21T10:00:00'))).toEqual([]);
    expect(swingTimes(J('2026-11-22T10:00:00'))).toEqual([]);
  });
});

const T = J('2026-11-18T10:00:00');
const universeRoutes = {
  '/emitten/classification/list': { data: [{ id: 1, level: 1 }] },
  '/emitten/classification/company': { data: [{ id: 1, companies: [{ symbol: 'SWEP', name: 'Sweep Tbk.', valuema20: '3200000000', notations: [], uma: false, company_status: 'STATUS_ACTIVE' }] }] },
  '/company-price-feed/v2/orderbook/companies/SWEP': { data: { ara: { value: '334' }, arb: { value: '234' }, previous: 270 } },
};

// A sweep: offers 274-284 thick a minute before, thin now with the best offer at 280; a bid wall at
// 272 that has stood for a minute; ten 3 000-lot buys from 274 to 278 over the last ten seconds.
async function sweepRecording(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'replay-'));
  const rec = new Recorder(dir, '2026-11-18');
  const sec = (ms: number) => Math.floor(ms / 1000);
  const bids: [number, number, number][] = [[272, 50, 5_000_000], [270, 5, 10_000], [268, 5, 10_000], [266, 5, 10_000], [264, 5, 10_000]];
  rec.write(orderbookFrame('SWEP', bookBody('SWEP', 'BID', bids, sec(T - 60_000))), T - 60_000);
  rec.write(orderbookFrame('SWEP', bookBody('SWEP', 'OFFER', [[274, 40, 400_000], [276, 40, 400_000], [278, 40, 400_000], [280, 9, 90_000]], sec(T - 60_000))), T - 60_000);
  rec.write(orderbookFrame('SWEP', bookBody('SWEP', 'BID', bids, sec(T - 11_000))), T - 11_000);
  rec.write(orderbookFrame('SWEP', bookBody('SWEP', 'OFFER', [[280, 9, 90_000], [282, 9, 90_000], [284, 9, 90_000]], sec(T - 11_000))), T - 11_000);
  const prices = [274, 274, 276, 276, 278, 278, 278, 278, 278, 278];
  prices.forEach((p, i) => {
    const ms = T - 10_000 + i * 1000;
    rec.write(tradeBatchFrame([{ symbol: 'SWEP', price: p, shares: 300_000, side: 1, ms, no: i + 1 }]), ms);
  });
  await rec.close();
  return join(dir, '2026-11-18.bin.gz');
}

const collect = () => {
  const alerts: Alert[] = [];
  const sender: Sender = { name: 'collect', send: async (a) => { alerts.push(a); } };
  return { alerts, sender };
};

describe('replay and pipeline', () => {
  it('replay of a synthetic recording produces the haka sweep alert', async () => {
    const { sender } = collect();
    const notifier = new Notifier({ cfg, senders: [sender], logger: createLogger('silent'), now: () => T });
    const alerts = await replay(await sweepRecording(), { http: fakeHttp(universeRoutes), cfg, logger: createLogger('silent'), notifier });
    const sweep = alerts.find((a) => a.signal.setup === 'haka_sweep');
    expect(sweep).toBeDefined();
    expect(sweep!.score).toBeGreaterThanOrEqual(70);
    // evaluated at the sixth trade (5 s after the first), last price 278
    expect(sweep!.plan).toMatchObject({ action: 'BELI', entryHigh: 278, entryLow: 276 });
    expect(sweep!.price.changePct).toBeCloseTo((278 - 270) / 270);
    expect(sweep!.risk.toAraPct).toBeCloseTo((334 - 278) / 278);
  });

  it('focus changes resubscribe the feed with the wildcard trade channel', async () => {
    const seen: Channels[] = [];
    const p = new Pipeline({
      cfg, http: fakeHttp(universeRoutes), universe: Universe.of([info('SWEP', 3_200_000_000)]), logger: createLogger('silent'),
      notifier: new Notifier({ cfg, senders: [], logger: createLogger('silent') }), onChannels: (c) => seen.push(c),
    });
    for (let i = 0; i < 20; i += 1) {
      p.onEvent({ kind: 'trades', trades: [{ symbol: 'SWEP', price: 274 + 2 * Math.floor(i / 5), shares: 300_000, value: 300_000 * 274, side: 'buy', time: T + i * 1000, tradeNo: i, board: 1 }] }, T + i * 1000);
    }
    p.tick(T + 20_000);
    await p.idle();
    expect(seen.at(-1)).toEqual({ runningTradeBatch: ['*'], orderBook: ['SWEP'], livePrice: ['SWEP'] });
  });
});

describe('memoSuccess', () => {
  it('caches successful reads only', async () => {
    let calls = 0;
    const get = memoSuccess(async (k: string) => {
      calls += 1;
      if (calls === 1) throw new Error('timeout');
      return `${k}!`;
    }, 'fallback');
    expect(await get('A')).toBe('fallback');
    expect(await get('A')).toBe('A!');
    expect(await get('A')).toBe('A!');
    expect(calls).toBe(2);
  });
});

describe('holding exits on the live path', () => {
  it('a holding falling through avg −5% alerts exit_stop once', async () => {
    const { alerts, sender } = collect();
    const p = new Pipeline({
      cfg, http: fakeHttp(universeRoutes), universe: Universe.of([info('SWEP', 3_200_000_000)]), logger: createLogger('silent'),
      notifier: new Notifier({ cfg, senders: [sender], logger: createLogger('silent') }),
      holdings: [{ symbol: 'SWEP', lots: 10, avgPrice: 300 }],
    });
    // 300 → 270 in 2-rupiah steps, one trade every 6 s
    for (let i = 0, price = 300; price >= 270; i += 1, price -= 2) {
      p.onEvent({ kind: 'trades', trades: [{ symbol: 'SWEP', price, shares: 1000, value: price * 1000, side: 'sell', time: T + i * 6000, tradeNo: i, board: 1 }] }, T + i * 6000);
      await p.idle();
    }
    const stops = alerts.filter((a) => a.signal.setup === 'exit_stop');
    expect(stops).toHaveLength(1);
    expect(stops[0]!.signal.facts).toEqual(['Harga 284 ≤ stop 284']); // avg 300 −5% = 285 → floorTick 284
  });
});

const day = (i: number) => 1_790_000_000 + i * 86_400;
const swingBars = Array.from({ length: 25 }, (_, i) => ({
  unixdate: day(i), open: 100, low: 95, lot: i >= 22 ? 2000 : 1000,
  close: i >= 22 ? 104 : 100, high: i === 10 ? 106 : 105,
}));
const swingRoutes = (symbol: string) => ({
  [`/chartbit/${symbol}/price/daily`]: { data: { chartbit: swingBars } },
  [`/marketdetectors/${symbol}`]: { data: { bandar_detector: { avg: { accdist: 'Acc' } }, broker_summary: { brokers_buy: [] } } },
  '/order-trade/foreign-domestic/summary': { data: { net: { all: { raw: 1e9 } } } },
  [`/company-price-feed/v2/orderbook/companies/${symbol}`]: { data: { previous: 100 } },
});

describe('swing scan on the pipeline', () => {
  it('caps swing lots by the expected 5-minute value', async () => {
    const { alerts, sender } = collect();
    const p = new Pipeline({
      cfg, http: fakeHttp(swingRoutes('THIN')), universe: Universe.of([info('THIN', 128_000_000)]), logger: createLogger('silent'),
      notifier: new Notifier({ cfg, senders: [sender], logger: createLogger('silent') }),
      holdings: [{ symbol: 'THIN', lots: 1, avgPrice: 90 }], cash: 1e9, sleep: async () => {},
    });
    await p.swingScan(J('2026-11-18T15:00:00'));
    const swing = alerts.find((a) => a.signal.setup === 'swing_accumulation');
    expect(swing).toBeDefined();
    // valuema20 128 M → 400 k per minute → 2 M per 5 min; 5% / (104 × 100) → 9 lots
    expect(swing!.plan!.lots).toBe(9);
  });
});

describe('WatchRunner', () => {
  it('missing trading session sends the notice once', async () => {
    const texts: string[] = [];
    const sender: Sender = { name: 'collect', send: async () => {}, text: async (t) => { texts.push(t); } };
    const http = fakeHttp({
      ...universeRoutes,
      '/portfolio/v2/list': () => { throw new StockbitMcpError('TRADING_AUTH_REQUIRED', 'no trading session'); },
      '/watchlist': { data: [] },
    });
    const feed = { start: vi.fn(), stop: vi.fn(), setChannels: vi.fn(), connected: false };
    const runner = new WatchRunner({
      http, cfg, home: mkdtempSync(join(tmpdir(), 'home-')), logger: createLogger('silent'),
      notifier: new Notifier({ cfg, senders: [sender], logger: createLogger('silent') }),
      userId: '5', feed, now: () => J('2026-11-18T08:50:00'), timers: false,
    });
    await runner.start();
    await runner.preopen();
    await runner.stop();
    expect(texts).toEqual(['Sesi trading belum aktif: jalankan stockbit-mcp login --trading supaya lot dan peringatan portofolio jalan.']);
    expect(feed.setChannels).toHaveBeenCalledWith({ runningTradeBatch: ['*'], orderBook: [], livePrice: [] });
    expect(feed.start).toHaveBeenCalled();
  });
});

import { launchAgentPlist } from '../../../src/cli/watch.js';

describe('WatchRunner resilience', () => {
  const base = { ...universeRoutes, '/portfolio/v2/list': { data: { results: [] } }, '/watchlist': { data: [] } };
  const mk = (http: ReturnType<typeof fakeHttp>, extra: Partial<ConstructorParameters<typeof WatchRunner>[0]> = {}) =>
    new WatchRunner({
      http, cfg, home: mkdtempSync(join(tmpdir(), 'home-')), logger: createLogger('silent'),
      notifier: new Notifier({ cfg, senders: [], logger: createLogger('silent') }),
      userId: '5', feed: { start: vi.fn(), stop: vi.fn(), setChannels: vi.fn(), connected: false },
      now: () => J('2026-11-18T08:50:00'), timers: false, sleep: async () => {}, ...extra,
    });

  it('retries the startup reads instead of failing on one error', async () => {
    let n = 0;
    const http = fakeHttp({ ...base, '/emitten/classification/list': () => {
      n += 1;
      if (n === 1) throw new StockbitMcpError('UPSTREAM', 'Stockbit 502');
      return { data: [{ id: 1 }] };
    } });
    const runner = mk(http);
    await expect(runner.start()).resolves.toBeUndefined();
    expect(n).toBe(2);
    await runner.stop();
  });

  it('a failed read at pre-open is logged, not fatal', async () => {
    let fail = false;
    const lines: string[] = [];
    const http = fakeHttp({ ...base, '/portfolio/v2/list': () => {
      if (fail) throw new StockbitMcpError('UPSTREAM', 'Stockbit 503');
      return { data: { results: [] } };
    } });
    const runner = mk(http, { logger: createLogger('warn', (l) => lines.push(l)) });
    await runner.start();
    fail = true;
    await expect(runner.preopen()).resolves.toBeUndefined();
    expect(lines.some((l) => l.includes('pre-open refresh failed'))).toBe(true);
    await runner.stop();
  });

  it('writes sent alerts to the day file', async () => {
    const home = mkdtempSync(join(tmpdir(), 'home-'));
    const notifier = new Notifier({ cfg, senders: [], logger: createLogger('silent') });
    const runner = mk(fakeHttp(base), { home, notifier });
    await runner.start();
    await notifier.send({
      signal: { style: 'day', symbol: 'SWEP', setup: 'rvol_spike', title: 'Volume meledak', action: 'BELI', facts: [], components: [], at: J('2026-11-18T09:10:00'), refs: { last: 274 } },
      score: 70, risk: { notations: [], uma: false, fca: false }, price: { last: 274, changePct: 0 },
    });
    await runner.stop();
    const file = join(home, 'tape', '2026-11-18.alerts.ndjson');
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('tells the user once when the session cannot be refreshed', async () => {
    const texts: string[] = [];
    const notifier = new Notifier({ cfg, senders: [{ name: 'c', send: async () => {}, text: async (t) => { texts.push(t); } }], logger: createLogger('silent') });
    const runner = mk(fakeHttp(base), { notifier });
    await runner.authFailed();
    expect(texts).toEqual([AUTH_NOTICE]);
  });

  it('waits for the 16:10 swing scan before ending the day', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let now = J('2026-11-18T16:11:00');
    const onDayEnd = vi.fn();
    const http = fakeHttp({
      ...base, ...swingRoutes('SWEP'),
      '/portfolio/v2/list': { data: { results: [{ symbol: 'SWEP', qty: { balance: { lot: 1 } }, price: { average: { price: 260 } } }] } },
      '/chartbit/SWEP/price/daily': async () => { await gate; return { data: { chartbit: [] } }; },
    });
    const runner = mk(http, { now: () => now, onDayEnd });
    await runner.start(); // 16:11: the 16:10 scan starts and waits on the gate
    now = J('2026-11-18T16:16:00');
    runner.applyPhase(now);
    await new Promise((r) => setTimeout(r, 10));
    expect(onDayEnd).not.toHaveBeenCalled();
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(onDayEnd).toHaveBeenCalledTimes(1);
    await runner.stop();
  });
});

describe('watch command helpers', () => {
  it('writes a weekday 08:40 LaunchAgent', () => {
    const xml = launchAgentPlist('/usr/local/bin/node', '/repo/dist/cli.js', '/Users/x/.stockbit-mcp');
    expect(xml).toContain('<string>com.stockbit-mcp.watch</string>');
    expect(xml).toContain('<string>/usr/local/bin/node</string><string>/repo/dist/cli.js</string><string>watch</string>');
    expect(xml.match(/<key>Weekday<\/key><integer>(\d)<\/integer>/g)).toHaveLength(5);
    expect(xml).toContain('<key>Hour</key><integer>8</integer><key>Minute</key><integer>40</integer>');
    expect(xml).toContain('<string>/Users/x/.stockbit-mcp/watch.log</string>');
  });

  it('ends the day after the last swing scan, not at the close', async () => {
    let now = J('2026-11-18T15:59:00');
    const onDayEnd = vi.fn();
    const runner = new WatchRunner({
      http: fakeHttp({ ...universeRoutes, '/portfolio/v2/list': { data: { results: [] } }, '/watchlist': { data: [] } }),
      cfg, home: mkdtempSync(join(tmpdir(), 'home-')), logger: createLogger('silent'),
      notifier: new Notifier({ cfg, senders: [], logger: createLogger('silent') }),
      userId: '5', feed: { start: vi.fn(), stop: vi.fn(), setChannels: vi.fn(), connected: false }, now: () => now, timers: false, onDayEnd,
    });
    await runner.start();
    now = J('2026-11-18T16:05:00');
    runner.applyPhase(now);
    expect(onDayEnd).not.toHaveBeenCalled();
    now = J('2026-11-18T16:16:00');
    runner.applyPhase(now);
    await new Promise((r) => setTimeout(r, 0)); // day end waits for any running swing scan
    expect(onDayEnd).toHaveBeenCalledTimes(1);
    runner.applyPhase(now + 60_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(onDayEnd).toHaveBeenCalledTimes(1);
    await runner.stop();
  });
});
