# stockbit-mcp watch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-running `stockbit-mcp watch` command that reads Stockbit's realtime datafeed for the whole IDX market, detects scalp/day/swing setups and exit warnings with explicit rules, and sends actionable Indonesian alerts (action, levels, lots, score breakdown) to macOS and Telegram.

**Architecture:** A protobuf WebSocket client (plain Node, no Chromium) feeds a per-symbol tape and order-book state; a scanner keeps a momentum top 5 and an accumulation top 5 in focus; detectors emit signals, a scorer and planner turn them into alerts, and a notifier gates and delivers them. REST context (universe, ARA/ARB, broker, foreign, daily bars, portfolio) goes through the existing `src/core` Chromium client. Every datafeed frame is recorded so a day can be replayed through the same pipeline.

**Tech Stack:** TypeScript (NodeNext, strict, `exactOptionalPropertyTypes`), Node ≥ 20.19 global `WebSocket` and `fetch`, `node:zlib` gzip, zod for config, vitest. No new runtime dependency.

**Spec:** `docs/superpowers/specs/2026-11-18-stockbit-watch-bot-design.md`

## Global Constraints

- The bot never places, amends or cancels orders; it imports nothing from `src/tools/orders.ts` except the tick helpers moved to `src/core/ticks.ts`.
- Datafeed: `wss://wss-jkt.trading.stockbit.com/ws?_s=dfctx_v2_<reconnectCount>`, subprotocol `desktop`, binary frames; heartbeat every 15 s.
- Subscribe frame: `WebsocketRequest{1 user_id (session.exodus.userId), 2 channel, 5 access_token (exodus)}`; ping frame `WebsocketRequest{4 ping{1 "ping"}}`.
- Notification text is Indonesian; every alert ends with `Sinyal aturan, bukan saran.`
- Lots use the cash trading balance, never margin buying power.
- Config and recordings live under `config.home` (`~/.stockbit-mcp`): `watch.json` (mode 600), `tape/YYYY-MM-DD.bin.gz`, `tape/YYYY-MM-DD.alerts.ndjson`.
- All Jakarta-time logic uses UTC+7 without DST (as `src/tools/market.ts` does).
- Every price the bot prints is on the IDX tick grid and inside ARB–ARA.
- Follow the repo's style: ESM `.js` import suffixes, `noUncheckedIndexedAccess`, no default exports, tests in `test/unit/watch/*.test.ts`.

## Review Focus

1. Laptop sleep / Wi-Fi drop mid-session → the client reconnects with backoff, resubscribes the current focus, and the tape keeps going (Task 3 test `reconnects and resubscribes after close`).
2. Exodus access token expires during the day → the feed's `error{401}` frame triggers `auth.refresh('exodus', token)` and a reconnect, not a crash loop (Task 3 test `refreshes the token on an unauthorized error`).
3. A stock with no `valuema20` (new listing, IPO day) → no division by zero or `Infinity` RVOL; its baseline comes from its own first 15 minutes (Task 6 test `new listing gets a baseline from its first 15 minutes`).
4. Prices under 200 (tick 1), at ARA/ARB, or a stop equal to the entry → plan prices on tick and clamped, lots never `Infinity`/`NaN` (Task 12 tests `clamps to ARA and stays on tick`, `zero risk gives zero lots`).
5. Telegram down or a bad token → the error is logged once per minute, macOS still notifies, the bot keeps running (Task 13 test `telegram failure does not stop delivery`).

---

## File Structure

```
src/core/ticks.ts                 IDX tick grid (moved from orders.ts) + tickUp/tickDown/floorTick/ceilTick
src/watch/types.ts                Trade, BookSide, LivePrice, FeedEvent, Signal, Alert, TradePlan, …
src/watch/feed/codec.ts           protobuf wire encode/decode for the datafeed
src/watch/feed/orderbook-text.ts  parse "#O|SYM|BID|p;n;v|…|tail"
src/watch/feed/client.ts          DatafeedClient: connect, subscribe, ping, reconnect, token refresh
src/watch/recorder.ts             gzip frame recorder + reader for replay
src/watch/config.ts               watch.json schema, defaults, load/save
src/watch/universe.ts             companies, baselines, notations/FCA from REST
src/watch/market/tape.ts          per-symbol rolling windows and day stats
src/watch/market/book.ts          per-symbol order book, walls, fake walls, offer thinning
src/watch/scanner.ts              momentum + accumulation shortlists with hysteresis
src/watch/detect/intraday.ts      scalp and day detectors
src/watch/rest.ts                 REST reads the bot needs (thin wrappers over ctx.http)
src/watch/detect/swing.ts         scheduled swing scan
src/watch/detect/exit.ts          exit warnings for holdings
src/watch/score.ts                score components and thresholds
src/watch/plan.ts                 trade plan: entry, stop, targets, lots
src/watch/notify/format.ts        Indonesian alert text (Telegram) and short macOS text
src/watch/notify/notifier.ts      anti-spam gate + fan-out
src/watch/notify/telegram.ts      Telegram Bot API sendMessage / setup
src/watch/notify/macos.ts         osascript notification
src/watch/clock.ts                market phases for the day
src/watch/run.ts                  orchestrator (live and replay)
src/cli.ts                        `watch`, `watch --replay <file>`, `watch --setup-telegram`, `watch --dry-run`
```

---

### Task 1: Shared IDX tick helpers

**Files:**
- Create: `src/core/ticks.ts`
- Modify: `src/tools/orders.ts:26-56` (import from `../core/ticks.js` instead of defining)
- Test: `test/unit/watch/ticks.test.ts`

**Interfaces:**
- Produces: `onTick(price: number): boolean`, `nearestTicks(price: number): [number, number]` (unchanged behavior), plus `tickUp(price: number, n = 1): number`, `tickDown(price: number, n = 1): number`, `floorTick(price: number): number`, `ceilTick(price: number): number`, `tickSize(price: number): number` (the step above).

- [ ] **Step 1: Write the failing test**

```ts
import { ceilTick, floorTick, onTick, tickDown, tickUp } from '../../../src/core/ticks.js';
it('moves along the IDX grid across band edges', () => {
  expect(tickUp(199)).toBe(200); expect(tickUp(200)).toBe(202); expect(tickDown(200)).toBe(199);
  expect(tickUp(498, 2)).toBe(505); expect(tickDown(5000)).toBe(4990); expect(tickUp(5000)).toBe(5025);
  expect(floorTick(1003)).toBe(1000); expect(ceilTick(1003)).toBe(1005); expect(floorTick(201)).toBe(200);
  expect(onTick(201)).toBe(false); expect(onTick(tickUp(4975, 3))).toBe(true);
});
```

- [ ] **Step 2: Run** `npx vitest run test/unit/watch/ticks.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement** the helpers in `src/core/ticks.ts` (move `TICKS`, `stepAbove`, `stepBelow`, `onTick`, `nearestTicks` verbatim; `tickUp`/`tickDown` step one tick at a time from an on-grid price, snapping an off-grid input with `floorTick`/`ceilTick` first); make `orders.ts` import them.
- [ ] **Step 4: Run** `npx vitest run --project unit` — Expected: all pass (orders tests unchanged).
- [ ] **Step 5: Commit** `git commit -m "refactor: share IDX tick helpers in src/core/ticks"`

---

### Task 2: Datafeed codec and order-book text

**Files:**
- Create: `src/watch/types.ts`, `src/watch/feed/codec.ts`, `src/watch/feed/orderbook-text.ts`
- Test: `test/unit/watch/codec.test.ts`

**Interfaces:**
- Produces (`types.ts`):
  - `Trade { symbol: string; price: number; shares: number; value: number; side: 'buy' | 'sell' | 'none'; time: number /* ms */; tradeNo: number; board: number }`
  - `BookLevel { price: number; orders: number; shares: number }`, `BookSide { symbol: string; side: 'bid' | 'offer'; levels: BookLevel[]; time: number; total: number }`
  - `LivePrice { symbol: string; last: number; prev: number; open: number; high: number; low: number; value: number; volume: number; changePct: number; time: number }`
  - `FeedEvent = { kind: 'trades'; trades: Trade[] } | { kind: 'book'; book: BookSide } | { kind: 'price'; price: LivePrice } | { kind: 'pong' } | { kind: 'error'; code: number; message: string } | { kind: 'unknown'; field: number }`
  - `Channels { runningTradeBatch: string[]; orderBook: string[]; livePrice: string[] }`
- Produces (`codec.ts`): `encodeSubscribe(userId: string, token: string, ch: Channels): Uint8Array`, `encodePing(): Uint8Array`, `decodeFrame(buf: Uint8Array): FeedEvent`.
- Produces (`orderbook-text.ts`): `parseOrderBookText(body: string): BookSide | undefined`.

Field numbers (from the spec): channel `running_trade_batch` 5, `order_book` 2, `liveprice_v3` 12; wrap oneof `running_trade_batch` 8 (`batch` 1 → RunningTrade), `orderbook` 10 (`stock_code` 1, `body` 2), `liveprice_v3` 16, `ping` 2, `error` 7 (`code` 1, `message` 2). RunningTrade: `stock` 2, `price` 3 (double), `volume` 4 (double, shares), `action` 5 (1 buy, 2 sell), `time` 7 (Timestamp `seconds` 1, `nanos` 2), `trade_number` 9, `market_board` 10, `value` 11 (double). LivePrice v3 numbers are `DecimalValue{1 raw{1 value string}}`: `symbol` 1, `lastprice` 2, `volume` 3, `high` 4, `low` 5, `open` 6, `previous` 10, `value` 11, `change_percentage` 13, `timestamp` 16.

- [ ] **Step 1: Write the failing tests**

```ts
it('encodes a subscription the server accepted live', () => {
  const b = encodeSubscribe('5', 'tok', { runningTradeBatch: ['*'], orderBook: [], livePrice: ['BBCA'] });
  expect([...b]).toEqual([0x0a,1,0x35, 0x12,9, 0x2a,1,0x2a, 0x62,4,0x42,0x42,0x43,0x41, 0x2a,3,0x74,0x6f,0x6b]);
  expect([...encodePing()]).toEqual([0x22,6,0x0a,4,0x70,0x69,0x6e,0x67]);
});
it('decodes a running trade batch', () => {
  const ev = decodeFrame(fixtureTradeBatch()); // test helper builds field 8 with one trade: BBCA 5675 x300 sell value 1702500 time 1794968455.570
  expect(ev).toEqual({ kind: 'trades', trades: [{ symbol: 'BBCA', price: 5675, shares: 300, value: 1702500, side: 'sell', time: 1794968455570, tradeNo: 239839, board: 1 }] });
});
it('parses order-book text', () => {
  expect(parseOrderBookText('#O|BBRI|BID|3120;179;2245700|3110;444;3551900|1794969627-5368&49457200')).toEqual({
    symbol: 'BBRI', side: 'bid', time: 1794969627000, total: 49457200,
    levels: [{ price: 3120, orders: 179, shares: 2245700 }, { price: 3110, orders: 444, shares: 3551900 }] });
  expect(parseOrderBookText('#O|GOTO|OFFER|28;10;500|1794969627-1&500')?.side).toBe('offer');
  expect(parseOrderBookText('garbage')).toBeUndefined();
});
it('decodes pong and error frames, and reports unknown fields', () => { /* ping{1 "pong"} → {kind:'pong'}; error{1 401, 2 "Unauthorized"} → {kind:'error', code:401, …}; field 3 → {kind:'unknown', field:3} */ });
```

- [ ] **Step 2: Run** `npx vitest run test/unit/watch/codec.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** a minimal wire codec (varint, length-delimited, fixed64 double, fixed32) and the mappings above. `decodeFrame` maps `orderbook` through `parseOrderBookText` and returns `unknown` when the body does not parse. Unknown trade `action` → `'none'`.
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(watch): datafeed protobuf codec and order-book parser"`

---

### Task 3: Datafeed client

**Files:**
- Create: `src/watch/feed/client.ts`
- Test: `test/unit/watch/client.test.ts`

**Interfaces:**
- Consumes: `encodeSubscribe`, `encodePing`, `decodeFrame`, `Channels`, `FeedEvent` (Task 2); `AuthService.token('exodus')`, `AuthService.refresh('exodus', rejected)`.
- Produces:
  ```ts
  interface DatafeedOptions { url?: string; userId: string; tokens: Pick<AuthService, 'token' | 'refresh'>;
    WebSocketImpl?: typeof WebSocket; logger: Logger; onEvent(ev: FeedEvent, raw: Uint8Array, at: number): void;
    now?: () => number }
  class DatafeedClient { constructor(o: DatafeedOptions); start(): void; stop(): void;
    setChannels(ch: Channels): void; readonly connected: boolean }
  ```
  Constants: `PING_MS = 15_000`, `PONG_TIMEOUT_MS = 5_000`, backoff `min(30_000, 1_000 * 2 ** attempt)`; attempt resets after 60 s connected.

- [ ] **Step 1: Write the failing tests** with a `FakeWebSocket` (records `url`, `protocols`, sent frames; test drives `onopen`/`onmessage`/`onclose`) and `vi.useFakeTimers()`:
  - `subscribes with the session token on open`: after open, first sent frame equals `encodeSubscribe('5','tok', channels)`; URL ends `?_s=dfctx_v2_0`; protocols `['desktop']`.
  - `sends the whole channel set again when it changes`: `setChannels` while open sends a new subscribe frame with the full new set.
  - `pings every 15 s and reconnects when no pong comes`: after 15 s a ping is sent; with no pong for 5 s the socket is closed and a new one opens after 1 s with `?_s=dfctx_v2_1`.
  - `reconnects and resubscribes after close`: close → reconnect after 1 s, then 2 s, … capped at 30 s; the new socket gets the current channels.
  - `refreshes the token on an unauthorized error`: an `error{401}` frame calls `tokens.refresh('exodus','tok')`, and the next connection subscribes with the refreshed token.
  - `forwards events with the raw frame`: a trade frame reaches `onEvent` with the decoded event and the same bytes.
- [ ] **Step 2: Run** `npx vitest run test/unit/watch/client.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement** `DatafeedClient` (binaryType `arraybuffer`; `stop()` closes without reconnecting; a missing token logs `AUTH_REQUIRED` and retries with backoff).
- [ ] **Step 4: Run** the test file — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(watch): datafeed websocket client with heartbeat and reconnect"`

---

### Task 4: Recorder and replay reader

**Files:**
- Create: `src/watch/recorder.ts`
- Test: `test/unit/watch/recorder.test.ts`

**Interfaces:**
- Produces: `class Recorder { constructor(dir: string, date: string); write(raw: Uint8Array, at: number): void; alert(record: object): void; close(): Promise<void> }` and `readRecording(file: string): AsyncIterable<{ raw: Uint8Array; at: number }>`.
- Format: gzip stream of records `[u32 BE length][f64 BE receive ms][bytes]`; alerts as one JSON per line in `<date>.alerts.ndjson`.

- [ ] **Step 1: Write the failing test** `round-trips frames in order`: write three frames (lengths 0, 3, 70 000) with times, close, read back the same bytes and times in order; `survives a truncated tail`: a file cut mid-record yields the complete records and stops without throwing.
- [ ] **Step 2: Run** — Expected: FAIL. **Step 3: Implement** with `zlib.createGzip()` piped to `fs.createWriteStream(…, { flags: 'a' })` (one gzip member per run is fine; the reader uses `createGunzip()` which reads concatenated members). **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(watch): record datafeed frames and read them back"`

---

### Task 5: Watch config

**Files:**
- Create: `src/watch/config.ts`
- Test: `test/unit/watch/config.test.ts`

**Interfaces:**
- Produces: `WatchConfigSchema` (zod), `type WatchConfig`, `loadWatchConfig(home: string): Promise<WatchConfig>` (missing file → defaults), `saveWatchConfig(home: string, cfg: WatchConfig): Promise<void>` (writes mode `0o600`).
- Defaults (every later task reads its thresholds from here):

| key | default |
|---|---|
| `telegram` | `{ token?: string, chatId?: string }` (both optional) |
| `macos` | `true` |
| `styles` | `{ scalp: true, day: true, swing: true, exit: true }` |
| `risk` | `{ pct: { scalp: 0.01, day: 0.01, swing: 0.01 }, fixedIdr: 10_000_000, holdingStopPct: 0.05, liquidityShare: 0.05 }` |
| `alerts` | `{ cooldownSec: 600, rescoreJump: 15, dailyCap: 30, minValue5m: 50_000_000 }` |
| `thresholds` | `{ scalp: 70, day: 65, swing: 60 }` |
| `scanner` | `{ size: 5, recomputeSec: 30, enterMargin: 0.10, minStaySec: 120 }` |
| `scalp` | `{ sweepWindowSec: 10, sweepMinLevels: 2, sweepMinValueX: 2, thinWindowSec: 60, thinDrop: 0.5, bigLotPct: 0.99, bigLotCount: 3, bigLotWindowSec: 30 }` |
| `day` | `{ rvolMin: 3, hakaMin: 0.6, breakoutMinRvol: 2, accumRangeTicks: 3, accumRvolMin: 2, accumHakiMin: 0.55, distHakiMin: 0.65, extendedPct: 0.04 }` |
| `book` | `{ wallFactor: 5, wallPersistSec: 20, accumWallPersistSec: 60 }` |
| `swing` | `{ maxSymbols: 60, topByTape: 30, minGapMs: 1500 }` |

- [ ] **Step 1: Write the failing tests** `fills defaults for a missing file`; `keeps user values and fills the rest` (a file with only `{ "alerts": { "dailyCap": 10 } }` → `dailyCap` 10, `cooldownSec` 600); `writes the file private` (`statSync(path).mode & 0o777` is `0o600`); `rejects a negative risk pct` with a message naming the key.
- [ ] **Step 2–4:** run (FAIL) → implement with deep defaults → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): watch.json config with defaults"`

---

### Task 6: Universe and baselines

**Files:**
- Create: `src/watch/universe.ts`, `src/watch/rest.ts` (first functions)
- Test: `test/unit/watch/universe.test.ts`

**Interfaces:**
- Consumes: `ToolContext['http']` (`StockbitHttp.request`).
- Produces:
  - `rest.ts`: `getJson(http: StockbitHttp, path: string, query?: Record<string, QueryValue>, host?: Host): Promise<JsonValue>` (returns `data` like `unwrap`).
  - `StockInfo { symbol: string; name: string; valueMa20: number; avgVolume: number; marketCap: number; notations: string[]; uma: boolean; fca: boolean; active: boolean }`
  - `class Universe { static async load(http: StockbitHttp): Promise<Universe>; get(symbol: string): StockInfo | undefined; expectedPerMinute(symbol: string): number | undefined; learnBaseline(symbol: string, valueFirst15m: number): void; readonly size: number }`
  - `TRADING_MINUTES = 320` (Mon–Thu: 180 + 140).
- Load: `GET /emitten/classification/list` → level-1 ids → one `GET /emitten/classification/company` with all ids (`ids` repeated) → companies (dedupe by symbol). `fca` = notations contain `X` (IDX notation for the special-monitoring board); log the count found so this rule can be checked live.

- [ ] **Step 1: Write the failing tests** using a fake `http` whose `request` answers the two paths with small fixtures:
  - `loads companies from all sectors without duplicates` (a symbol present in two groups appears once; `size` matches).
  - `expected value per minute is valuema20 / 320` (`valuema20` 3_200_000_000 → 10_000_000).
  - `new listing gets a baseline from its first 15 minutes` (`valuema20` 0 → `expectedPerMinute` undefined; after `learnBaseline('NEWX', 150_000_000)` → 10_000_000).
  - `marks FCA from notation X`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): universe and RVOL baselines from classification"`

---

### Task 7: Tape windows

**Files:**
- Create: `src/watch/market/tape.ts`
- Test: `test/unit/watch/tape.test.ts`

**Interfaces:**
- Consumes: `Trade` (Task 2).
- Produces:
  ```ts
  interface WindowStats { value: number; trades: number; buyValue: number; sellValue: number; maxLot: number;
    first: number; last: number; high: number; low: number; bigLots: number }
  class SymbolTape { add(t: Trade): void; window(sec: number, now: number): WindowStats;
    day(): WindowStats & { open: number; vwap: number }; lotPercentile(p: number): number;
    hakaShare(sec: number, now: number): number /* buyValue/(buy+sell), 0.5 when none */ }
  class Tape { add(trades: Trade[]): void; get(symbol: string): SymbolTape | undefined; symbols(): string[] }
  ```
  1-second buckets kept for 15 minutes; day aggregates kept all day; lot sizes in lots (`shares / 100`); `bigLots` counts trades at or above the day's 99th-percentile lot computed so far.
- [ ] **Step 1: Write the failing tests** `window sums only the last N seconds`; `HAKA share is buy value over buy+sell`; `vwap is value over shares`; `drops buckets older than 15 minutes`; `lot percentile over the day`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): per-symbol tape windows"`

---

### Task 8: Order-book state

**Files:**
- Create: `src/watch/market/book.ts`
- Test: `test/unit/watch/book.test.ts`

**Interfaces:**
- Consumes: `BookSide` (Task 2), `WatchConfig['book']`, `WatchConfig['scalp']`.
- Produces:
  ```ts
  interface Wall { side: 'bid' | 'offer'; price: number; shares: number; since: number }
  class SymbolBook { apply(b: BookSide, now: number): void; bestBid(): BookLevel | undefined; bestOffer(): BookLevel | undefined;
    walls(side: 'bid' | 'offer', minAgeSec: number, now: number): Wall[]; fakeWalls(): number;
    offerThinning(topN: number, windowSec: number, now: number): number /* 1 - now/max over window, 0..1 */;
    spreadTicks(): number; levelsTakenAbove(price: number): number }
  class Books { apply(b: BookSide, now: number): void; get(symbol: string): SymbolBook | undefined; drop(symbol: string): void }
  ```
  A wall is a level whose shares are ≥ `wallFactor` × the median shares of the top 10 levels on its side, continuously present since `since`. A wall that had reached `wallPersistSec` and then disappears while the best price on its side never reached it counts as fake (`fakeWalls()` per day).
- [ ] **Step 1: Write the failing tests** `finds a bid wall only after it persists`; `counts a wall pulled before being hit as fake`; `a wall eaten by trades is not fake` (best offer moved through it); `offer thinning compares to the window max`; `levelsTakenAbove counts offer levels now below the best offer`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): order-book state, walls and fake walls"`

---

### Task 9: Scanner (momentum and accumulation shortlists)

**Files:**
- Create: `src/watch/scanner.ts`
- Test: `test/unit/watch/scanner.test.ts`

**Interfaces:**
- Consumes: `Tape`, `Universe`, `WatchConfig['scanner' | 'day']`.
- Produces: `class Scanner { constructor(tape, universe, cfg); recompute(now: number): Focus }`, `Focus { momentum: string[]; accumulation: string[] }`, and the pure scorers `momentumScore(s: SymbolTape, expectedPerMin: number, now: number): number` and `accumulationScore(…): number` (0–100).
- Momentum score: 5-min RVOL (value / (5 × expected per minute)), HAKA share 5 min, price change 5 min in ticks, trades vs its own day average per 5 min, big lots — weighted 35/25/20/10/10, each term capped at its weight. Accumulation score: 15-min RVOL ≥ `accumRvolMin`, range ≤ `accumRangeTicks` ticks, HAKI share ≥ `accumHakiMin`, price not below the 15-min first price.
- Hysteresis: a candidate enters only if its score beats the current last member by `enterMargin` (relative); a member leaves only after `minStaySec` and only when replaced. Stocks under `minValue5m` are never candidates.
- [ ] **Step 1: Write the failing tests** `ranks a HAKA-heavy RVOL spike first`; `quiet narrow-range high-value stock goes to accumulation, not momentum`; `a challenger 5% better does not replace a member, 15% better does after min stay`; `ignores stocks below the 5-minute value floor`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): momentum and accumulation shortlists"`

---

### Task 10: Intraday detectors (scalp and day)

**Files:**
- Create: `src/watch/detect/intraday.ts`
- Test: `test/unit/watch/intraday.test.ts`

**Interfaces:**
- Consumes: `SymbolTape`, `SymbolBook | undefined`, `StockInfo`, `expectedPerMinute`, `WatchConfig`.
- Produces: `detectIntraday(input: IntradayInput, now: number): Signal[]` where
  ```ts
  interface IntradayInput { symbol: string; tape: SymbolTape; book?: SymbolBook; info: StockInfo; expectedPerMin: number; cfg: WatchConfig; accumulatedAt?: number }
  interface Signal { style: 'scalp' | 'day' | 'swing' | 'exit'; symbol: string; setup: Setup; title: string; action: Action;
    facts: string[]; components: ScoreComponent[]; at: number; refs: PlanRefs }
  type Setup = 'haka_sweep' | 'offer_thinning' | 'big_lot_burst' | 'rvol_spike' | 'day_high_break' | 'accumulation' | 'markup' | 'distribution' | 'swing_accumulation' | 'exit_distribution' | 'exit_stop' | 'exit_target'
  type Action = 'BELI' | 'TUNGGU' | 'HINDARI' | 'JUAL' | 'AMANKAN'
  interface ScoreComponent { label: string; points: number }
  interface PlanRefs { last: number; vwap?: number; dayLow?: number; bidWall?: number; offerWall?: number; swingLow?: number; ma20?: number; nDayHigh?: number }
  ```
  (`Signal`, `Setup`, `Action`, `ScoreComponent`, `PlanRefs` go in `src/watch/types.ts`.)
- Rules (thresholds from config; titles are the Indonesian strings shown):
  - `haka_sweep` (scalp, "HAKA sapu offer"): in `sweepWindowSec`, buy value ≥ `sweepMinValueX` × expected per minute and `book.levelsTakenAbove(windowFirstPrice) ≥ sweepMinLevels` (tape-only fallback: price rose ≥ `sweepMinLevels` ticks on buy trades).
  - `offer_thinning` (scalp, "Offer menipis"): `offerThinning(3, thinWindowSec) ≥ thinDrop` while best bid unchanged or higher.
  - `big_lot_burst` (scalp, "Lot besar beruntun"): ≥ `bigLotCount` buy trades at ≥ `lotPercentile(bigLotPct)` within `bigLotWindowSec`.
  - `rvol_spike` (day, "Volume meledak"): 5-min RVOL ≥ `rvolMin`, HAKA share 15 min ≥ `hakaMin`, price above the 15-min first price.
  - `day_high_break` (day, "Tembus high harian"): last > previous day high of the session and 5-min RVOL ≥ `breakoutMinRvol`.
  - `accumulation` (day, "Akumulasi"): accumulation score conditions plus a bid wall with age ≥ `accumWallPersistSec`; action `TUNGGU` with the wall as the wait price.
  - `markup` (day, "Markup mulai"): `accumulatedAt` within 30 min, HAKA share 5 min ≥ 0.7, price ≥ 2 ticks above the accumulation range top.
  - `distribution` (day, "Distribusi"): 15-min price change ≥ 0, HAKI share 15 min ≥ `distHakiMin`, ≥ 3 big sell lots; action `HINDARI`.
  - FCA stocks: only `rvol_spike` and `distribution` (computed between auction prints), every FCA signal gets the fact `Papan pemantauan khusus (lelang berkala)`.
  - Action for buy setups: `BELI`, or `TUNGGU` when last > VWAP × (1 + `extendedPct`).
- [ ] **Step 1: Write the failing tests**, one per rule (positive and one negative case each), built from synthetic trades and book sides, e.g. `haka sweep fires when three offer levels go in 10 s with 2x value`, `no sweep when the value is below 2x`, `accumulation needs the bid wall to persist 60 s`, `FCA stock never gets haka sweep`, `extended price turns BELI into TUNGGU`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): scalp and day detectors"`

---

### Task 11: REST context, swing scan and exit warnings

**Files:**
- Modify: `src/watch/rest.ts`
- Create: `src/watch/detect/swing.ts`, `src/watch/detect/exit.ts`
- Test: `test/unit/watch/swing-exit.test.ts`

**Interfaces:**
- Produces (`rest.ts`): `getAraArb(http, symbol): Promise<{ ara?: number; arb?: number }>` (orderbook REST `/company-price-feed/v2/orderbook/companies/{symbol}`, values may be strings with "," thousands), `getBandar(http, symbol)` (`/marketdetectors/{symbol}` period `BROKER_SUMMARY_PERIOD_LAST_10_DAYS` → `{ accdist?: string; topBuyers: { code: string; value: number }[] }`), `getForeignNet(http, symbol)` (last 5 daily nets), `getDailyBars(http, symbol, days: number)` (chartbit daily: `{ date, open, high, low, close, volume }[]`), `getHoldings(http)` (carina portfolio → `{ symbol, lots, avgPrice }[]`; `undefined` when the trading session is missing), `getCashBalance(http)` (carina cash trading balance; `undefined` when missing), `getWatchlistSymbols(http)`. Each returns `undefined` on `AUTH_REQUIRED`/`TRADING_AUTH_REQUIRED` instead of throwing. The exact response field paths come from `src/catalog/endpoints.json` responses of these ids and the existing tools in `src/tools/account.ts`/`market.ts`.
- Produces (`swing.ts`): `swingList(tape, universe, holdings, watchlist, cfg): string[]` (top `topByTape` by day value × RVOL + accumulation shortlist + watchlist + holdings, deduped, capped `maxSymbols`); `detectSwing(symbol, ctx: { bars, bandar, foreign, info }, now): Signal | undefined` — `swing_accumulation` ("Akumulasi bandar (swing)") when `accdist` is `Acc`/`Big Acc`, last close within 3% of the 20-day high, and the last 3 days' volume ≥ 1.5 × the 10 days before; facts list top buyer codes and foreign 5-day net. `PlanRefs`: `swingLow` = lowest low of 10 days, `ma20`, `nDayHigh` = 20-day high.
- Produces (`exit.ts`): `holdingPlan(h: Holding, refs: PlanRefs, cfg): { stop: number; tp1: number; tp2: number }` (stop = the nearer below last of `floorTick(avg × (1 − holdingStopPct))` and the structural level `max(dayLow, bidWall) − 1 tick`; TP = avg + 1.5R/2.5R); `detectExit(h, tape, book, plan, now): Signal[]` — `exit_stop` ("Tembus stop", `JUAL`) when last ≤ stop; `exit_target` ("Target tercapai", `AMANKAN`) when last ≥ tp1; `exit_distribution` ("Distribusi di saham kamu", `AMANKAN`) under the distribution rule of Task 10.
- [ ] **Step 1: Write the failing tests** `swing list mixes tape leaders, accumulation, watchlist and holdings, capped at 60`; `swing accumulation needs Acc, near 20-day high and rising volume`; `holding stop is the nearer of avg −5% and structure`; `exit stop fires once the price trades at or under the stop`; `rest helpers return undefined without a trading session` (fake http throwing `TRADING_AUTH_REQUIRED`).
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): swing scan, exit warnings and REST context"`

---

### Task 12: Score and trade plan

**Files:**
- Create: `src/watch/score.ts`, `src/watch/plan.ts`
- Test: `test/unit/watch/score-plan.test.ts`

**Interfaces:**
- Produces (`score.ts`): `riskComponents(info: StockInfo, toAraPct: number | undefined, book?: SymbolBook): ScoreComponent[]` and `scoreOf(components: ScoreComponent[]): number` (sum clamped 0–100), `passes(style, score, cfg): boolean` (exit always passes).
  - Setup components (added by the detectors through `facts`→`components`, values fixed here): RVOL 5 min ≥3 → `RVOL +10`, ≥5 → `+18`, ≥8 → `+25`; HAKA share ≥0.6 → `HAKA +10`, ≥0.75 → `+15`, ≥0.9 → `+20`; swept levels → `sapu +10` per level beyond the first, max 20; persisting bid wall within 3 ticks below → `bid +12`; offer thinning → `offer tipis +10`; bandar Acc → `broker +10`; foreign 5-day net buy → `asing +5`.
  - Risk components: each notation `notasi −5` (max −15), UMA `UMA −10`, `toAraPct < 5%` → `ARA −10` (≥ 15% → `ARA +5`), fake walls today `palsu −5` each (max −15), spread > 3 ticks `spread −5`, FCA `FCA −10`.
- Produces (`plan.ts`): `makePlan(sig: Signal, ctx: { ara?: number; arb?: number; cash?: number; value5m: number; cfg: WatchConfig }): TradePlan` with
  `TradePlan { action: Action; entryLow: number; entryHigh: number; stop: number; tp1: number; tp2: number; rr: number; lots: number; riskIdr: number; lotBasis: 'balance' | 'fixed'; waitPrice?: number; note?: string }`.
  - entryHigh = `floorTick(last)`, entryLow = `tickDown(entryHigh)`; for `TUNGGU` entryHigh = waitPrice.
  - stop = highest of `{bidWall, dayLow, vwap}` (each minus one tick) that is ≤ `tickDown(entryLow, 2)`; none → `floorTick(entryLow × 0.97)`. Swing: nearer of `swingLow − 1 tick` and `floorTick(ma20)`.
  - R = entryHigh − stop; tp1 = `ceilTick(entryHigh + 1.5R)`, tp2 = `ceilTick(entryHigh + 2.5R)`; tp1 lowered to `tickDown(offerWall)` when a persisting offer wall sits between entry and tp1 (swing: `nDayHigh`). Clamp every price to [arb, ara] when known. rr = (tp1 − entryHigh) / R, one decimal.
  - riskIdr = (cash ?? fixedIdr) × risk.pct[style]; lots = floor(min(riskIdr / (R × 100), cash / (entryHigh × 100), liquidityShare × value5m / (entryHigh × 100))) — skip a cap whose input is missing; R ≤ 0 → lots 0 with `note: 'Stop terlalu dekat; tentukan sendiri'`; lots 0 otherwise → `note: 'Risiko per trade terlalu kecil untuk 1 lot'`.
- [ ] **Step 1: Write the failing tests**
  ```ts
  it('builds the SMRA example plan', () => {
    // stop = bid wall 268 − 1 tick = 266 (≤ 272 − 2 ticks = 268); R = 8; tp1 = 274 + 12; tp2 = 274 + 20;
    // lots = min(120 000 / 800 = 150, cash 12 000 000 / 27 400 = 437, 5% × 2.1 M / 27 400 = 3 832) = 150
    const p = makePlan(sig({ setup: 'haka_sweep', refs: { last: 274, bidWall: 268, dayLow: 262 } }),
      { ara: 334, arb: 234, cash: 12_000_000, value5m: 2_100_000_000, cfg: defaults });
    expect(p).toMatchObject({ entryHigh: 274, entryLow: 272, stop: 266, tp1: 286, tp2: 294, rr: 1.5, lots: 150, riskIdr: 120_000, lotBasis: 'balance' });
  });
  it('picks the highest structural level that leaves room', () => {
    // vwap 270 − 1 tick = 268 is allowed (≤ 268) and beats the wall: stop 268, R 6, tp1 ceilTick(283) = 284
    expect(makePlan(sig({ setup: 'haka_sweep', refs: { last: 274, bidWall: 268, dayLow: 262, vwap: 270 } }),
      { cash: 12_000_000, value5m: 2_100_000_000, cfg: defaults })).toMatchObject({ stop: 268, tp1: 284, tp2: 290 });
  });
  it('clamps to ARA and stays on tick', () => { /* last 197, ara 200 → tp1/tp2 ≤ 200, onTick for all */ });
  it('zero risk gives zero lots', () => { /* stop == entry → lots 0, note set, no NaN */ });
  it('caps lots by liquidity on thin stocks', () => { /* value5m 20_000_000, entry 100 → lots ≤ 100 */ });
  it('scores with penalties and clamps to 0..100', () => { /* RVOL+25 HAKA+20 sapu+20 bid+12 notasi-5 → 72; extra +50 → 100 */ });
  ```
  (The spec's example message, with 15 lots, is illustrative; these rules give 150 for that input.)
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): alert score and trade plan"`

---

### Task 13: Notifications

**Files:**
- Create: `src/watch/notify/format.ts`, `src/watch/notify/notifier.ts`, `src/watch/notify/telegram.ts`, `src/watch/notify/macos.ts`
- Test: `test/unit/watch/notify.test.ts`

**Interfaces:**
- Consumes: `Alert { signal: Signal; score: number; plan?: TradePlan; risk: { notations: string[]; uma: boolean; toAraPct?: number; fca: boolean }; price: { last: number; changePct: number } }` (define in `types.ts`).
- Produces: `formatTelegram(a: Alert, at: number): string`, `formatMacos(a: Alert): { title: string; body: string }`; `class Notifier { constructor(o: { cfg: WatchConfig; senders: Sender[]; logger: Logger; recorder?: Recorder; now?: () => number }); send(a: Alert): Promise<boolean> }`; `interface Sender { name: string; send(a: Alert, text: { telegram: string; macos: { title: string; body: string } }): Promise<void> }`; `telegramSender(token: string, chatId: string, fetchImpl?: typeof fetch): Sender`; `macosSender(exec?: …): Sender`; `setupTelegram(token: string, fetchImpl?): Promise<string /* chatId */>`.
- Format (exact layout; numbers `id-ID`, prices without "Rp", money with "Rp" and `rb`/`jt`/`M` units):
  ```
  {emoji} [{STYLE}] {SYMBOL} {last} ({+x,x%}) — {title}
  AKSI: {action} {entryLow}–{entryHigh} · SL {stop} ({−x,x%}) · TP1 {tp1} · TP2 {tp2} · R:R 1:{rr}
  Lot: {lots} (risiko {pct}% = Rp{riskIdr} dari {saldo trading|modal tetap})
  • {fact}            (one line per fact)
  Skor {score}/100: {label +n · label −n …}
  ⚠️ Notasi: {codes|–} · UMA: {ya|tidak} · ke ARA: {+x%|?} · Sinyal aturan, bukan saran.
  {HH:mm:ss}
  ```
  Emoji: scalp 🔥, day ⚡, swing 📈, exit 🚨. `TUNGGU` prints `AKSI: TUNGGU di {waitPrice}` before the levels; `HINDARI` omits the plan lines.
- Gate: key `symbol|style`; drop when within `cooldownSec` of the last sent unless score ≥ last + `rescoreJump` or the action changed; stop sending non-exit alerts after `dailyCap` per Jakarta day; exit alerts bypass both. Each sender is called independently; a failing sender is logged (at most once per minute per sender) and does not block others. Sent alerts go to `recorder.alert`.
- Telegram: `POST https://api.telegram.org/bot{token}/sendMessage` JSON `{ chat_id, text, disable_web_page_preview: true }` (no parse mode). Setup: `getUpdates` → chat id of the most recent message; error `Kirim /start ke bot kamu dulu, lalu ulangi.` when none.
- macOS: `execFile('osascript', ['-e', 'display notification "<body>" with title "<title>"'])` with `"` and `\` escaped.
- [ ] **Step 1: Write the failing tests** `formats the scalp alert exactly` (a full expected string for one alert); `TUNGGU and HINDARI layouts`; `cooldown drops a repeat within 10 minutes but lets a 15-point jump through`; `daily cap stops non-exit alerts but not exits`; `telegram failure does not stop delivery` (telegram sender rejects → macOS sender still called, `send` resolves true, one log line); `escapes quotes for osascript`; `setupTelegram picks the latest chat id`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): alert formatting, anti-spam gate, Telegram and macOS"`

---

### Task 14: Orchestrator, clock and CLI

**Files:**
- Create: `src/watch/clock.ts`, `src/watch/run.ts`
- Modify: `src/cli.ts` (commands and HELP)
- Test: `test/unit/watch/run.test.ts`

**Interfaces:**
- Produces (`clock.ts`): `phaseAt(nowMs: number, schedule?: Schedule): 'closed' | 'preopen' | 'session1' | 'break' | 'session2' | 'preclose' | 'after'` with the default schedule Mon–Thu 08:45/09:00–12:00/13:30–15:50/16:00 and Fri 08:45/09:00–11:30/14:00–15:50/16:00 (Jakarta); `swingTimes(dateMs): number[]` = break start + 5 min, 15:00, 16:10.
- Produces (`run.ts`): `class WatchRunner { constructor(deps: { http: StockbitHttp; auth: AuthService; store: SessionStore; cfg: WatchConfig; home: string; logger: Logger; notifier: Notifier; feed?: DatafeedClient; now?: () => number }); start(): Promise<void>; stop(): Promise<void> }` and `replay(file: string, deps: Omit<…, 'feed'>): Promise<Alert[]>` (same pipeline; the notifier passed in is a printing one).
  - Pipeline per event: trades → tape (+ universe baseline learning at 15 min) → detectors for focus symbols and day detectors for all symbols at most once per 5 s per symbol; book → books; every `recomputeSec` → scanner → `feed.setChannels({ runningTradeBatch: ['*'], orderBook: focus ∪ holdings, livePrice: focus ∪ holdings })` and drop books of leavers; at swing times → swing scan with `minGapMs` between REST reads; ARA/ARB fetched once per symbol per day when it first needs a plan.
  - At pre-open: load universe, holdings, cash; if the trading session is missing send one notice `Sesi trading belum aktif: jalankan stockbit-mcp login --trading supaya lot dan peringatan portofolio jalan.` (bypasses the gate). Status log line every 60 s: connected, trades/s, focus.
  - Outside `preopen…preclose` the feed is stopped; after 16:00 the recorder closes.
- `src/cli.ts`: `watch` (live), `watch --dry-run` (live feed, alerts printed instead of sent), `watch --replay <file>` (prints alerts), `watch --setup-telegram` (prompts for the token, finds the chat id, saves config), `watch --install` (writes `~/Library/LaunchAgents/com.stockbit-mcp.watch.plist` that starts `watch` at 08:40 Mon–Fri with the current node and `dist/cli.js` paths, logs to `~/.stockbit-mcp/watch.log`, then prints the `launchctl load` command instead of running it). `watch` exits with a clear message when there is no exodus session.
- [ ] **Step 1: Write the failing tests** `phases for a Friday`; `replay of a synthetic recording produces the haka sweep alert` (build frames with the Task 2 encoders: a BBCA baseline, a 10-second burst of buy trades sweeping three offer levels, matching book frames; run `replay` with a fake http for universe/ARA; expect one alert with setup `haka_sweep`); `focus changes resubscribe the feed with the wildcard trade channel` (fake feed records `setChannels`); `missing trading session sends the notice once`.
- [ ] **Step 2–4:** run (FAIL) → implement → run (PASS).
- [ ] **Step 5: Commit** `git commit -m "feat(watch): orchestrator, market clock and watch command"`

---

### Task 15: Live check, app-conflict check and docs

**Files:**
- Modify: `README.md` (new "Watch bot" section), `docs/reverse-engineering.md` ("Realtime datafeed" section with the protocol facts in the spec), `src/watch/universe.ts` / `src/watch/feed/orderbook-text.ts` only if the live check disproves an assumption.

- [ ] **Step 1:** `npx tsc --noEmit && npx eslint . && npx vitest run --project unit` — Expected: all clean.
- [ ] **Step 2:** During market hours run `node dist/cli.js watch --dry-run` (after `npx tsup`) for 5 minutes. Expected log: connected, trades/s > 10, a focus of up to 10 symbols, order-book updates for them, and the FCA count from the universe load. Record what an alert looks like if one fires.
- [ ] **Step 3: App-conflict go/no-go with the user:** the user opens the Stockbit desktop app on a busy stock's running trade; run `watch --dry-run` for 60 s; the user reports whether the app's running trade stalled. Write the result into `docs/reverse-engineering.md`. If it conflicts, stop and tell the user (fallback per the spec: phone app while the bot runs).
- [ ] **Step 4:** `watch --setup-telegram` with the user's bot token; send one test alert through `Notifier` to Telegram and macOS.
- [ ] **Step 5:** Update README (how to run, Telegram setup, config keys, the risk caveat line) and reverse-engineering notes; regenerate nothing else. Commit `git commit -m "docs: watch bot usage and datafeed protocol"`.
