# stockbit-mcp watch: a rules-based IDX movement alert bot

Date: 2026-11-18. Status: approved by the user on 2026-11-18.

## Intent

The user trades IDX stocks in three styles (scalping, day trading, swing) and wants a bot that
watches the whole market for them, spots the moves worth acting on, including the way a "bandar"
accumulates, marks up and distributes a stock, and tells them through a notification what to do:
buy now, wait for a pullback, avoid, or sell what they hold, with the price levels, the lot size and
a score that explains itself. The Stockbit screener refreshes only every 15 minutes; the bot must
pick its candidates from the live running trade of the whole market instead.

## Goals

- Watch every listed stock in real time during IDX trading hours, gorengan and special-monitoring
  boards included, and keep a live top 5 of candidates.
- Detect setups for each style with explicit rules (no LLM in v1) and notify only when one fires.
- Make every notification actionable: action, entry zone, stop loss, two targets, risk/reward, a
  lot size from the user's risk budget, risk labels, and a 0-100 score with its breakdown.
- Warn about stocks the user already holds when the tape turns against them (distribution, stop
  level broken, target reached).
- Record the day's tape so that rules can be replayed and tuned on real data.

## Non-goals (v1)

- Placing, amending or cancelling orders. The bot never trades; `order_buy`/`order_sell` stay the
  only order path, behind their popups.
- LLM-written summaries or LLM-chosen signals (planned later for swing alerts only, see Approaches).
- Email delivery (later).
- Running anywhere but the user's Mac; a server or VPS deployment.
- Backtesting over history beyond the bot's own recordings.

## Anti-goals (a failure even if it works)

- Spam: alerts the user learns to ignore. Fewer, better alerts beat coverage.
- False confidence: the notification must read as a rules-based signal with its reasons, never as
  advice or a certainty. Every message carries the risk labels.
- Hurting the account: polling patterns that get the account rate-limited or flagged, or a bot
  connection that keeps knocking out the user's own Stockbit app.

## Constraints and facts

Found by reading the Stockbit desktop app 2.9.0 bundle and checked live on 2026-11-18 (see
`docs/reverse-engineering.md` and the memory note on the datafeed):

- **Realtime datafeed**: `wss://wss-jkt.trading.stockbit.com/ws?_s=dfctx_v2_0`, WebSocket
  subprotocol `desktop`, binary protobuf (`securities.transactional.datafeed.v1`). It connects from
  plain Node (global `WebSocket`); Cloudflare does not block it, unlike the exodus REST API.
  - Subscribe: `WebsocketRequest{1 user_id, 2 channel: WebsocketChannel, 5 access_token}` with the
    exodus access token. Heartbeat: `WebsocketRequest{4 ping{1 "ping"}}` every 15 s, answered "pong".
  - `WebsocketChannel` fields: `running_trade_batch` 5, `order_book` 2, `liveprice_v3` 12,
    `intraday_v3` 14, `best_bid_offer` 9, `market_mover` 10. Answers come wrapped in
    `WebsocketWrapMessageChannel` (oneof): `running_trade_batch` 8, `orderbook` 10,
    `liveprice_v3` 16, `ping` 2, `error` 7.
  - `running_trade_batch: ["*"]` streams the whole market: about 94 trades/s, 285 symbols in 30 s,
    about 8 KB/s mid-morning. Each trade has stock, price, volume (shares), action (1 = buy-initiated
    = HAKA, 2 = sell-initiated = HAKI), time, trade number, board, value. No broker code.
  - `order_book: [symbols]` sends full depth per side as text:
    `#O|BBRI|BID|3120;179;2245700|3110;444;3551900|…|<epoch>-<n>&<total>` (price; number of orders;
    shares). About 66 updates in 20 s for two symbols. `order_book_v3` and `best_bid_offer` sent
    nothing in a 20 s test.
  - The full protobuf schemas are in the bundle as protobuf-es `proto3.makeMessageType(...)`
    (`usePrimus-*.js`); a working minimal codec exists from the spike.
- **REST** (exodus) goes through the existing Chromium `BrowserFetch` and session (`src/core`).
  Useful reads, all in the catalog: `/emitten/classification/company` (every company with
  `valuema20`, `avgvolume`, market cap, notations, UMA, status), the orderbook REST (ARA/ARB),
  broker summary and bandar detector (`/marketdetectors/{symbol}`), foreign flow, chartbit daily
  bars, market session times, and with the trading session the portfolio and buying power.
- IDX hours (Jakarta, UTC+7): pre-opening 08:45-09:00, session 1 09:00-12:00 (Friday -11:30),
  session 2 13:30-15:50 (Friday from 14:00), pre-closing to 16:00. Read the day's schedule from
  `market_session` rather than hard-coding it.
- IDX price fractions and ARA/ARB bands: `src/tools/orders.ts` already implements the tick grid
  (`onTick`, `nearestTicks`) and reads ARA/ARB from the orderbook REST.
- The trading (carina) session expires daily; without it the bot loses holdings and buying power
  and must say so, not fail.
- Runs on the user's Mac only, during market hours. Language of notifications: Indonesian.

## Approaches considered

1. **Pure rules** (chosen by the user). Explicit detectors on the tape and order book. Fast (alert
   within seconds), free, deterministic and tunable on recordings.
2. **Rules plus an LLM summary per alert.** Same detectors, with 2-3 sentences of context from
   Claude. Better to read, but needs a paid API key and adds 2-5 s, too slow for scalping. Kept as a
   later add-on for swing alerts; v1 keeps the alert object rich enough to feed it.
3. **LLM decides.** The model reads the data and picks what to send. Most flexible, but slowest,
   most expensive and least repeatable. Rejected.

For candidate selection: the user's 15-minute screener was rejected as too slow; the bot ranks the
whole market from the global running trade instead (decided together).

## Design

### Shape

A long-running command `stockbit-mcp watch` in this repository, reusing `src/core` (session,
token refresh, Chromium REST). It starts before pre-opening, idles outside sessions, and stops after
pre-closing. A launchd agent to start it on weekdays is optional (`watch --install`). A replay mode
(`watch --replay <file>`) feeds a recording through the same pipeline with notifications printed
instead of sent.

```
datafeed WS ──► tape (all trades) ──► scanner (per-symbol windows) ──► top 5 (focus)
     │                                        │                         │
     └── order_book + liveprice for focus ◄───┴─────────────────────────┘
                                              │
REST (Chromium): universe, baselines,         ▼
ARA/ARB, broker/foreign, portfolio ──► detectors (scalp/day/swing/exit) ──► scorer ──► trade plan
                                                                                       │
                                                  recorder (tape + book to disk)       ▼
                                                                        notifier (macOS, Telegram)
```

### Universe and baselines (at start, REST)

- Every company from `/emitten/classification/company` over all level-1 nodes: symbol, name,
  `valuema20` (20-day average traded value), `avgvolume`, market cap, notations, UMA, status.
- Expected value per minute = `valuema20` / minutes in a trading day; this is the RVOL baseline.
  Stocks without a baseline (new listings) get one from their own first 15 minutes.
- Special-monitoring board (FCA, call auction) stocks are flagged; their detectors differ (below).

### Scanner and top 5

- Every trade from the global feed updates per-symbol rolling windows of 1 min, 5 min, 15 min and
  since open: value, number of trades, HAKA and HAKI value, largest lot, price change from open and
  from the window start, high/low of day.
- Candidate score (0-100) from: 5-min RVOL, HAKA share of value, price change, trade frequency
  relative to its own normal, big-lot count. Weights are initial values to tune on recordings.
- Top 5 recomputed every 30 s with hysteresis (a stock must beat the fifth place by a margin and
  stay out for a minimum time before it leaves). Entering the top 5 subscribes `order_book` and
  `liveprice_v3` for it; leaving unsubscribes. Held stocks are always in focus (in addition to the
  top 5).
- *Builder's call (design review):* quiet accumulation would never score into a momentum top 5, so
  a second shortlist of up to 5 **accumulation candidates** is ranked from tape-only signs: value
  well above normal while the price range stays within a few ticks and HAKI is absorbed without the
  price falling. They get `order_book` too, so the wall-based bandar rules can see them. The focus
  set is therefore at most 5 momentum + 5 accumulation + holdings (about 15 order books). Whether
  the datafeed caps subscriptions per connection is unknown; the subscription manager logs any
  error frame and drops the lowest-ranked focus stocks if one appears.

### Detectors (initial rules; thresholds in config, tuned on recordings)

Scalping (focus stocks, seconds):
- **HAKA sweep**: within about 10 s buy-initiated trades take out at least two offer levels and the
  value is a multiple of the stock's normal 1-min value.
- **Offer thinning**: the top three offer levels lose half their volume within a minute without the
  price falling, while bids hold.
- **Big-lot burst**: several trades above the day's 99th percentile lot size in a short span.

Day trading (all stocks, minutes):
- **RVOL spike** with price up and HAKA dominant over 5-15 min.
- **Day-high breakout** on rising value.
- **Intraday accumulation**: price held in a narrow range while value is high, HAKI absorbed and a
  bid wall persists (bandar collecting).
- **Markup start**: accumulation followed by HAKA with big lots and the price stepping up.
- **Distribution**: price up or flat while big HAKI lots dominate and offer walls refill.

Order-book facts used by several detectors: walls (levels far above the stock's typical level size)
count only after they survive for a configurable time; a wall pulled before being hit is recorded
as a fake and lowers the score of setups that leaned on it.

Swing (REST, scheduled at the lunch break, about 15:00 and after the close):
- Bandar detector accumulation over several days, top-buyer concentration in the broker summary,
  foreign net buying streak, price near an N-day high with volume dry-up then expansion.
- *Builder's call (design review):* the swing scan does not cover the whole market. Its list is the
  day's top 30 by value × RVOL from the tape, the accumulation shortlist, the user's Stockbit
  watchlists and the holdings, capped at 60 symbols. With about three REST reads per symbol this
  stays near 500 reads a day, spaced out (no bursts), through the existing Chromium client.

Exit warnings (held stocks, any time): distribution on a held stock, price through the plan's stop
level, target reached.

- Holdings come from the account (`portfolio`), so the user runs `stockbit-mcp login --trading`
  with the PIN every morning before the open (decided by the user). The bot reminds them through
  the notifier when the trading session is missing at pre-opening, and otherwise runs without
  holdings or balance.
- For a holding with no plan from an earlier alert, the stop is whichever is nearer below the
  price: the average buy price −5% (configurable) or the structural level (the day's low or below
  the holding bid wall); the targets are 1.5R/2.5R from the average price (decided by the user).
  When an alert on a held stock produced a plan, that plan's levels win.

FCA / call-auction stocks: HAKA, sweep and wall rules do not apply; only price and volume changes
between auction rounds are used, and the alert says it is an FCA stock.

### Score

Each alert's score (0-100) is the sum of weighted components, listed in the notification, e.g.
`RVOL +25 · HAKA +20 · sapu offer +20 · bid wall +10 · broker acc +10 · notasi −5`. Penalties: special
notation, UMA, close to ARA, wide spread, fake walls seen. Only alerts above the style's threshold
are sent.

### Trade plan

- **Action**: BELI (buy now), TUNGGU (wait for a pullback to a stated price), HINDARI (avoid,
  distribution), and for held stocks JUAL / AMANKAN (sell or take profit).
- **Entry zone** from the current offer and the swept levels; **stop loss** from structure (below the
  holding bid wall, the day's low or VWAP, whichever is nearest below and meaningful); **TP1/TP2** at
  1.5R/2.5R or the nearest offer wall if closer; **R:R**. All prices on the IDX tick grid and inside
  ARB-ARA.
- **Lots** = risk budget / (entry - stop) / 100, where the risk budget is a configurable share of
  the trading balance (default 1%), read from the account when the trading session is open;
  otherwise from a fixed amount in config, and the message says which.
- *Builder's call (design review):* "trading balance" is the account's cash trading balance, never
  margin buying power. Lots are also capped by cash buying power and by liquidity: at most 5% of the
  stock's traded value over the last 5 minutes (this bites on gorengan). The risk share is set per
  style in config, default 1% for each.
- *Builder's call (design review):* swing plans use daily bars, not the intraday book: stop below
  the recent swing low or the 20-day average, whichever is nearer and meaningful; targets at 1.5R
  and 2.5R or the last N-day high; the same lot formula.

### Notifications

- Channels: macOS notification (short) and Telegram (full message). Telegram setup: the user makes a
  bot with @BotFather; `watch --setup-telegram` stores the token and finds the chat id.
- Example:

```
🔥 [SCALP] SMRA 274 (+3,8%) — HAKA sapu offer
AKSI: BELI 272–274 · SL 266 (−2,9%) · TP1 280 · TP2 288 · R:R 1:2,1
Lot: 15 (risiko 1% = Rp120rb dari saldo trading)
• 5 menit: Rp2,1 M (RVOL 6,2x), HAKA 91%
• Sapu 3 level offer 274→276, lot terbesar 8.140
• Offer 278 tinggal 1.200 lot (−70% dalam 2 menit)
• Bid tebal di 270: 45.000 lot, bertahan 3 menit
Skor 82/100: RVOL +25 · HAKA +20 · sapu +20 · bid +12 · notasi 0 · ARA +5
⚠️ Notasi: – · UMA: tidak · ke ARA: +18% · Sinyal aturan, bukan saran.
09:33:12
```

- Anti-spam: one alert per stock per style per 10 minutes unless the score rises a lot or the action
  changes; a daily cap (config); exit warnings are never capped.

### Recording and replay

- Append every datafeed message (raw protobuf, length-prefixed, with receive time) to
  `~/.stockbit-mcp/tape/YYYY-MM-DD.bin.gz` (about 170 MB/day raw), plus the alerts sent as NDJSON.
- `watch --replay` runs a recording through the same scanner, detectors and scorer; this is how
  thresholds are set before alerts are trusted.

### Config and files

- `~/.stockbit-mcp/watch.json` (mode 600): Telegram token and chat id, risk share or amount,
  thresholds and weights per style, daily cap, quiet periods, styles on/off.
- Logs to stderr; a status line (connection, trades/s, current top 5) every minute.

### Resilience

- Reconnect with backoff on close or missed pong; resubscribe the current channels; refresh the
  exodus token through `AuthService` when the datafeed reports unauthorized.
- Missing trading session: no lots from balance, no holdings, one notice per day.

## Left to the builder

- Module layout under `src/watch/`, the codec (hand-written from the extracted schemas or
  `@bufbuild/protobuf` with generated types), window data structures, test layout.
- Exact initial thresholds and weights (start from the values above; tune by replay).
- macOS notification mechanism (`osascript` or another).

## Open points to verify while building

- Whether a bot datafeed connection disconnects the Stockbit app's own connection when both run.
  The user keeps the desktop app open during trading hours, so this is a go/no-go check as soon as
  the feed client works: the user shows a live running trade in the app while the bot connects for
  60 s. If they conflict, the fallback is the user following the market on the phone app (a
  different platform) while the bot runs; anything else goes back to the user.
- The tail fields of the order-book text (`<epoch>-<n>&<total>`) and how BID and OFFER messages
  alternate.
- How long the exodus access token lives and whether the datafeed closes when it expires.
- How FCA stocks are recognized in the universe data (notation or board field).
