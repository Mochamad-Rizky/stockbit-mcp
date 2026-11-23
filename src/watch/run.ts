import { join } from 'node:path';
import type { AuthService } from '../core/auth.js';
import { StockbitMcpError } from '../core/errors.js';
import type { Logger } from '../core/logger.js';
import { marketBaseline, profileMinutes } from './baseline.js';
import { jakartaDate, phaseAt, swingTimes, type Phase } from './clock.js';
import type { WatchConfig } from './config.js';
import { detectExit, holdingPlan, type HoldingLevels } from './detect/exit.js';
import { detectIntraday } from './detect/intraday.js';
import { detectSwing, swingList } from './detect/swing.js';
import { decodeFrame } from './feed/codec.js';
import { DatafeedClient } from './feed/client.js';
import { Books, type SymbolBook } from './market/book.js';
import { Tape } from './market/tape.js';
import type { Notifier } from './notify/notifier.js';
import { makePlan } from './plan.js';
import { Recorder, readRecording } from './recorder.js';
import { getAraArb, getBandar, getDailyBars, getForeignNet, getPortfolio, getWatchlistSymbols, type Holding, type Http } from './rest.js';
import { type Focus, Scanner } from './scanner.js';
import { liquidityComponents, passes, riskComponents, scoreOf } from './score.js';
import type { Alert, Channels, FeedEvent, LivePrice, PlanRefs, Signal, Trade } from './types.js';
import { LEARN_MINUTES, type StockInfo, Universe } from './universe.js';

// Wires the feed to the tape, books, scanner, detectors, scorer, planner and notifier. Pipeline is
// the clock-free core (also used by replay); WatchRunner adds the feed, the market clock and the
// recorder.

const EVAL_EVERY_MS = 5_000;
// The running trade carries every board: 2 is the cash market and 3 the negotiated market, whose
// crosses (trillions of rupiah at any price) are not the order book's buying and selling. The
// pre-opening (08:58) and closing (16:00) auction prints are a day's worth of orders matched at once:
// counted in a 5-minute window they would make every stock look hot at 09:00.
const OFF_MARKET_BOARDS = new Set([2, 3]);
const SESSIONS: Phase[] = ['session1', 'session2'];
const onMarket = (t: Trade) => !OFF_MARKET_BOARDS.has(t.board) && SESSIONS.includes(phaseAt(t.time));
// The best ARA bonus a risk check can add, used to skip REST reads for signals that cannot pass.
const MAX_ARA_BONUS = 5;
export const AUTH_NOTICE =
  'Sesi Stockbit kedaluwarsa dan tidak bisa diperpanjang: jalankan stockbit-mcp login, lalu jalankan ulang stockbit-mcp watch.';
export const TRADING_NOTICE =
  'Sesi trading belum aktif: jalankan stockbit-mcp login --trading supaya lot dan peringatan portofolio jalan.';

const hhmm = (ms: number) => new Date(ms + 7 * 3_600_000).toISOString().slice(11, 16);
export const feedDownNotice = (since: number) =>
  `⚠️ Tidak ada transaksi dari feed realtime Stockbit sejak ${hhmm(since)} (atau hari ini libur bursa): bot tidak melihat ` +
  'pasar dan tidak bisa memberi sinyal. Kalau app atau web Stockbit sedang terbuka, coba tutup dulu; koneksinya bisa saling ' +
  'rebut dengan bot.';
export const feedBackNotice = (minutes: number) =>
  `✅ Feed realtime tersambung lagi setelah putus ${minutes} menit. Pergerakan selama putus tidak terlihat oleh bot.`;

export interface PipelineDeps {
  cfg: WatchConfig;
  http: Http;
  universe: Universe;
  logger: Logger;
  notifier: Notifier;
  holdings?: Holding[];
  cash?: number;
  watchlist?: string[];
  onChannels?: (c: Channels) => void;
  sleep?: (ms: number) => Promise<void>;
}

type Quote = { ara?: number; arb?: number; prev?: number };

// Memoizes an async read per key, but only when it succeeds: a failed read answers `fallback` and is
// tried again next time.
export function memoSuccess<K, V>(load: (k: K) => Promise<V>, fallback: V): (k: K) => Promise<V> {
  const cache = new Map<K, Promise<V>>();
  return (k) => {
    const hit = cache.get(k);
    if (hit) return hit;
    const p = load(k).catch(() => {
      cache.delete(k);
      return fallback;
    });
    cache.set(k, p);
    return p;
  };
}

export class Pipeline {
  readonly tape = new Tape();
  readonly books: Books;
  readonly sent: Alert[] = [];
  focus: Focus = { momentum: [], accumulation: [], liquid: [] };
  holdings: Holding[];
  cash: number | undefined;
  watchlist: string[];
  private readonly scanner: Scanner;
  private readonly lastEval = new Map<string, number>();
  private readonly accumulated = new Map<string, { at: number; top: number }>();

  private readonly prices = new Map<string, LivePrice>();
  private readonly pending = new Set<Promise<void>>();
  // Last price seen per holding, so exit levels alert on crossing, and each holding's levels for the
  // day (fixed at the first look, replaced by the plan of an alert on that stock).
  private readonly holdingLast = new Map<string, number>();
  private readonly holdingLevels = new Map<string, HoldingLevels>();
  private channelsKey = '';
  private lastTick = 0;

  constructor(private readonly d: PipelineDeps) {
    this.books = new Books(d.cfg.book);
    this.scanner = new Scanner(this.tape, d.universe, d.cfg);
    this.holdings = d.holdings ?? [];
    this.cash = d.cash;
    this.watchlist = d.watchlist ?? [];
  }

  onEvent(ev: FeedEvent, at: number): void {
    if (at - this.lastTick >= this.d.cfg.scanner.recomputeSec * 1000) this.tick(at);
    if (ev.kind === 'trades') {
      const trades = ev.trades.filter(onMarket);
      this.tape.add(trades);
      for (const symbol of new Set(trades.map((t) => t.symbol))) {
        this.learn(symbol, at);
        this.evaluateSoon(symbol, at);
      }
    } else if (ev.kind === 'book') {
      this.books.apply(ev.book, at);
      this.evaluateSoon(ev.book.symbol, at);
    } else if (ev.kind === 'price') {
      this.prices.set(ev.price.symbol, ev.price);
    }
  }

  // Recompute the focus lists and resubscribe when they changed.
  tick(now: number): void {
    this.lastTick = now;
    this.focus = this.scanner.recompute(now);
    const symbols = [
      ...new Set([...this.focus.momentum, ...this.focus.accumulation, ...this.focus.liquid, ...this.holdings.map((h) => h.symbol)]),
    ];
    const channels: Channels = { runningTradeBatch: ['*'], orderBook: symbols, livePrice: symbols };
    const key = JSON.stringify(channels);
    if (key !== this.channelsKey) {
      this.channelsKey = key;
      this.d.onChannels?.(channels);
    }
    for (const s of this.tape.symbols()) if (!symbols.includes(s)) this.books.drop(s);
  }

  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.all([...this.pending]);
  }

  // The scheduled swing scan over the short list.
  async swingScan(now: number): Promise<void> {
    if (!this.d.cfg.styles.swing) return;
    const list = swingList(this.tape, this.d.universe, this.holdings.map((h) => h.symbol), this.watchlist, this.focus.accumulation, this.d.cfg);
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (const [i, symbol] of list.entries()) {
      if (i > 0) await sleep(this.d.cfg.swing.minGapMs);
      const info = this.d.universe.get(symbol);
      if (!info) continue;
      try {
        const bars = await getDailyBars(this.d.http, symbol, 30, now);
        const bandar = await getBandar(this.d.http, symbol);
        const foreign = await getForeignNet(this.d.http, symbol);
        const sig = detectSwing(symbol, { bars, ...(bandar ? { bandar } : {}), ...(foreign === undefined ? {} : { foreign }), info }, now);
        const expected = this.d.universe.expectedPerMinute(symbol);
        if (sig) await this.emit(sig, info, this.books.get(symbol), expected === undefined ? undefined : expected * 5);
      } catch (error) {
        this.d.logger.warn('swing scan failed', { symbol, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  private learn(symbol: string, at: number): void {
    if (this.d.universe.expectedPerMinute(symbol) !== undefined) return;
    const s = this.tape.get(symbol);
    if (s && at - s.firstTime >= LEARN_MINUTES * 60_000) {
      this.d.universe.learnBaseline(symbol, s.window(LEARN_MINUTES * 60, at).value, profileMinutes(LEARN_MINUTES * 60, at));
    }
  }

  private evaluateSoon(symbol: string, at: number): void {
    if (at - (this.lastEval.get(symbol) ?? -Infinity) < EVAL_EVERY_MS) return;
    this.lastEval.set(symbol, at);
    const p = this.evaluate(symbol, at)
      .catch((error: unknown) => {
        this.d.logger.warn('evaluation failed', { symbol, error: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => this.pending.delete(p));
    this.pending.add(p);
  }

  private async evaluate(symbol: string, at: number): Promise<void> {
    const info = this.d.universe.get(symbol);
    const baseline = marketBaseline(this.d.universe, this.d.cfg, symbol);
    const tape = this.tape.get(symbol);
    if (!info || baseline === undefined || !tape) return;
    const book = this.books.get(symbol);
    const acc = this.accumulated.get(symbol);
    let signals = detectIntraday(
      {
        symbol, tape, info, baseline, cfg: this.d.cfg,
        ...(book ? { book } : {}),
        ...(acc ? { accumulatedAt: acc.at, accumulationTop: acc.top } : {}),
      },
      at,
    );
    // Scalp setups need the order book, which only focus stocks have.
    if (!book) signals = signals.filter((s) => s.style !== 'scalp');
    if (this.d.cfg.alerts.distributionScope === 'relevant' && !this.hasStake(symbol)) {
      signals = signals.filter((s) => s.setup !== 'distribution');
    }
    if (signals.some((s) => s.setup === 'accumulation')) this.accumulated.set(symbol, { at, top: tape.window(900, at).high });
    const holding = this.holdings.find((h) => h.symbol === symbol);
    if (holding && this.d.cfg.styles.exit) {
      const day = tape.day();
      const refs: PlanRefs = { last: day.last, dayLow: day.low };
      const wall = book?.walls('bid', this.d.cfg.book.wallPersistSec, at).filter((w) => w.price <= day.last).sort((a, b) => b.price - a.price)[0];
      if (wall) refs.bidWall = wall.price;
      let levels = this.holdingLevels.get(symbol);
      if (!levels) {
        levels = holdingPlan(holding, refs, this.d.cfg);
        this.holdingLevels.set(symbol, levels);
      }
      signals.push(...detectExit(holding, tape, levels, at, this.d.cfg, this.holdingLast.get(symbol)));
      this.holdingLast.set(symbol, day.last);
    }
    const value5m = tape.window(300, at).value;
    for (const s of signals) await this.emit(s, info, book, value5m);
  }

  // "Avoid this stock" helps only on a stock the user may buy or hold: a watchlist stock, one the bot
  // flagged as a buy today, or a holding when exit alerts (which cover distribution) are off.
  private hasStake(symbol: string): boolean {
    if (this.watchlist.includes(symbol)) return true;
    if (!this.d.cfg.styles.exit && this.holdings.some((h) => h.symbol === symbol)) return true;
    return this.sent.some((a) => a.signal.symbol === symbol && (a.signal.action === 'BELI' || a.signal.action === 'TUNGGU'));
  }

  private readonly quote = memoSuccess<string, Quote>((symbol) => getAraArb(this.d.http, symbol), {});

  private async emit(sig: Signal, info: StockInfo, book: SymbolBook | undefined, value5m: number | undefined): Promise<void> {
    const cfg = this.d.cfg;
    const liquidity = liquidityComponents(info, cfg, sig.setup);
    if (!passes(sig.style, scoreOf([...sig.components, ...liquidity, ...riskComponents(info, undefined, book)]) + MAX_ARA_BONUS, cfg)) return;
    const q = await this.quote(sig.symbol);
    const last = sig.refs.last;
    const toAraPct = q.ara !== undefined && last > 0 ? (q.ara - last) / last : undefined;
    const components = [...sig.components, ...liquidity, ...riskComponents(info, toAraPct, book)];
    const score = scoreOf(components);
    if (!passes(sig.style, score, cfg)) return;
    const prev = q.prev ?? this.prices.get(sig.symbol)?.prev;
    const plan =
      sig.style === 'exit' || sig.action === 'HINDARI'
        ? undefined
        : makePlan(sig, {
            cfg,
            ...(q.ara === undefined ? {} : { ara: q.ara }),
            ...(q.arb === undefined ? {} : { arb: q.arb }),
            ...(this.cash === undefined ? {} : { cash: this.cash }),
            ...(value5m === undefined ? {} : { value5m }),
          });
    const alert: Alert = {
      signal: { ...sig, components, ...(plan ? { action: plan.action } : {}) },
      score,
      ...(plan ? { plan } : {}),
      risk: { notations: info.notations, uma: info.uma, fca: info.fca, ...(toAraPct === undefined ? {} : { toAraPct }) },
      price: { last, changePct: prev ? (last - prev) / prev : 0 },
    };
    if (await this.d.notifier.send(alert)) {
      this.sent.push(alert);
      if (plan && plan.action === 'BELI' && this.holdings.some((h) => h.symbol === sig.symbol)) {
        this.holdingLevels.set(sig.symbol, { stop: plan.stop, tp1: plan.tp1, tp2: plan.tp2 });
      }
    }
  }
}

export interface ReplayDeps {
  http: Http;
  cfg: WatchConfig;
  logger: Logger;
  notifier: Notifier;
  holdings?: Holding[];
}

// Runs a recording through the same pipeline; returns the alerts the notifier let through.
export async function replay(file: string, deps: ReplayDeps): Promise<Alert[]> {
  const universe = await Universe.load(deps.http);
  const p = new Pipeline({ ...deps, universe, sleep: async () => {} });
  for await (const { raw, at } of readRecording(file)) p.onEvent(decodeFrame(raw), at);
  await p.idle();
  return p.sent;
}

export interface FeedLike {
  start(): void;
  stop(): void;
  setChannels(c: Channels): void;
  readonly connected: boolean;
}

export interface RunnerDeps {
  http: Http;
  cfg: WatchConfig;
  home: string;
  logger: Logger;
  notifier: Notifier;
  userId: string;
  auth?: Pick<AuthService, 'token' | 'refresh'>;
  feed?: FeedLike;
  now?: () => number;
  // false in tests: no intervals, the caller drives preopen()/stop().
  timers?: boolean;
  // Called once a trading day is over (after the last swing scan).
  onDayEnd?: () => void;
  sleep?: (ms: number) => Promise<void>;
}

const STARTUP_RETRY_MS = [5_000, 15_000, 45_000];

const ACTIVE: Phase[] = ['preopen', 'session1', 'break', 'session2', 'preclose'];

export class WatchRunner {
  private pipeline: Pipeline | undefined;
  private feed: FeedLike | undefined;
  private recorder: Recorder | undefined;
  private intervals: ReturnType<typeof setInterval>[] = [];
  private noticeDay = '';
  private swingDone = new Set<number>();
  private phase: Phase | undefined;
  private trades = 0;
  private dayEnded = '';
  private authNoticeDay = '';
  private swingRun: Promise<void> | undefined;
  // Feed watchdog: when the last trade arrived (or the session began), and since when the feed has
  // been silent after the user was told.
  private lastTradeAt = 0;
  private outageSince: number | undefined;
  private readonly now: () => number;

  constructor(private readonly d: RunnerDeps) {
    this.now = d.now ?? Date.now;
  }

  // A read that fails at 08:40 (a timeout, a 5xx) is tried again before giving up.
  private async retry<T>(what: string, read: () => Promise<T>): Promise<T> {
    const sleep = this.d.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let i = 0; ; i += 1) {
      try {
        return await read();
      } catch (error) {
        if (i >= STARTUP_RETRY_MS.length) throw error;
        this.d.logger.warn(`${what} failed, retrying`, { error: error instanceof Error ? error.message : String(error) });
        await sleep(STARTUP_RETRY_MS[i]!);
      }
    }
  }

  async start(): Promise<void> {
    const now = this.now();
    const universe = await this.retry('company list', () => Universe.load(this.d.http));
    this.d.logger.info('universe loaded', { stocks: universe.size, fca: universe.symbols().filter((s) => universe.get(s)?.fca).length });
    const portfolio = await this.retry('portfolio', () => getPortfolio(this.d.http));
    const watchlist = await getWatchlistSymbols(this.d.http).catch(() => []);
    this.recorder = new Recorder(join(this.d.home, 'tape'), jakartaDate(now), (e) =>
      this.d.logger.error('recording stopped', { error: e.message }),
    );
    this.d.notifier.setRecorder(this.recorder);
    this.pipeline = new Pipeline({
      cfg: this.d.cfg, http: this.d.http, universe, logger: this.d.logger, notifier: this.d.notifier, watchlist,
      holdings: portfolio?.holdings ?? [],
      ...(portfolio?.cash === undefined ? {} : { cash: portfolio.cash }),
      onChannels: (c) => this.feed?.setChannels(c),
    });
    if (this.d.feed) this.feed = this.d.feed;
    else {
      if (!this.d.auth) throw new StockbitMcpError('INTERNAL', 'WatchRunner needs auth to open the datafeed.');
      this.feed = new DatafeedClient({
        userId: this.d.userId, tokens: this.d.auth, logger: this.d.logger,
        onEvent: (ev, raw, at) => this.onFeed(ev, raw, at),
        onAuthFailed: () => void this.authFailed(),
      });
    }
    const held = this.pipeline.holdings.map((h) => h.symbol);
    this.feed.setChannels({ runningTradeBatch: ['*'], orderBook: held, livePrice: held });
    await this.checkTradingSession(portfolio !== undefined);
    this.applyPhase(now);
    if (this.d.timers !== false) {
      this.intervals.push(setInterval(() => this.applyPhase(this.now()), 30_000));
      this.intervals.push(setInterval(() => this.status(), 60_000));
    }
  }

  // Reload holdings and cash before the open, and remind about the trading session once a day.
  async preopen(): Promise<void> {
    try {
      const portfolio = await getPortfolio(this.d.http);
      if (this.pipeline && portfolio) {
        this.pipeline.holdings = portfolio.holdings;
        this.pipeline.cash = portfolio.cash;
      }
      await this.checkTradingSession(portfolio !== undefined);
    } catch (error) {
      this.d.logger.warn('pre-open refresh failed', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  // The datafeed's session was rejected and could not be refreshed: tell the user once a day.
  async authFailed(): Promise<void> {
    const today = jakartaDate(this.now());
    if (this.authNoticeDay === today) return;
    this.authNoticeDay = today;
    await this.d.notifier.notice(AUTH_NOTICE);
  }

  async stop(): Promise<void> {
    for (const i of this.intervals) clearInterval(i);
    this.intervals = [];
    this.feed?.stop();
    await this.swingRun;
    await this.pipeline?.idle();
    this.d.notifier.setRecorder(undefined);
    await this.recorder?.close();
    this.recorder = undefined;
  }

  onFeed(ev: FeedEvent, raw: Uint8Array, at: number): void {
    this.recorder?.write(raw, at);
    if (ev.kind === 'trades') {
      this.trades += ev.trades.length;
      this.lastTradeAt = at;
      if (this.outageSince !== undefined) {
        const minutes = Math.max(1, Math.round((at - this.outageSince) / 60_000));
        this.outageSince = undefined;
        void this.d.notifier.notice(feedBackNotice(minutes));
      }
    }
    this.pipeline?.onEvent(ev, at);
  }

  // In a session the whole market trades every second: a silent feed means the bot is blind.
  private checkFeed(now: number, phase: Phase, was: Phase | undefined): void {
    if (!SESSIONS.includes(phase)) return;
    if (phase !== was) this.lastTradeAt = Math.max(this.lastTradeAt, now);
    if (this.outageSince !== undefined || now - this.lastTradeAt < this.d.cfg.feed.staleSec * 1000) return;
    this.outageSince = this.lastTradeAt;
    this.d.logger.warn('datafeed silent', { since: new Date(this.lastTradeAt).toISOString() });
    void this.d.notifier.notice(feedDownNotice(this.lastTradeAt));
  }

  private async checkTradingSession(ok: boolean): Promise<void> {
    const today = jakartaDate(this.now());
    if (ok || this.noticeDay === today) return;
    this.noticeDay = today;
    await this.d.notifier.notice(TRADING_NOTICE);
  }

  applyPhase(now: number): void {
    const phase = phaseAt(now);
    const was = this.phase;
    this.phase = phase;
    if (ACTIVE.includes(phase)) this.feed?.start();
    else this.feed?.stop();
    if (phase === 'preopen' && was !== undefined && was !== 'preopen') void this.preopen();
    this.checkFeed(now, phase, was);
    const times = swingTimes(now);
    for (const t of times) {
      if (now >= t && now - t < 10 * 60_000 && !this.swingDone.has(t) && this.pipeline) {
        this.swingDone.add(t);
        const pipeline = this.pipeline;
        this.swingRun = Promise.resolve(this.swingRun)
          .then(() => pipeline.swingScan(now))
          .catch((error: unknown) => {
            this.d.logger.warn('swing scan failed', { error: error instanceof Error ? error.message : String(error) });
          });
      }
    }
    const today = jakartaDate(now);
    const lastSwing = times[times.length - 1];
    if (phase === 'after' && lastSwing !== undefined && now >= lastSwing + 5 * 60_000 && this.dayEnded !== today) {
      this.dayEnded = today;
      // Let a running scan finish first.
      void Promise.resolve(this.swingRun).finally(() => this.d.onDayEnd?.());
    }
  }

  private status(): void {
    const p = this.pipeline;
    this.d.logger.info('watch status', {
      phase: this.phase, connected: this.feed?.connected ?? false, tradesPerSec: Math.round(this.trades / 60),
      momentum: p?.focus.momentum ?? [], accumulation: p?.focus.accumulation ?? [], liquid: p?.focus.liquid ?? [],
    });
    this.trades = 0;
  }
}
