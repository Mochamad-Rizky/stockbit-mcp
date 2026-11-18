# stockbit-mcp

An MCP server that lets an AI assistant (Claude Code, Claude Desktop, Cursor, …) read Stockbit the
way the Stockbit desktop app does: running trade, trade flow, broker summary and broker flow, broker
distribution, foreign flow, order book, prices and charts, fundamentals, ownership, corporate
actions, the screener, your watchlists and alerts, and your portfolio. It can also place buy and
sell limit orders, each one only after you confirm it in two popups.

> **Unofficial.** Stockbit has no public API. This server calls the same endpoints as the Stockbit
> desktop app 2.9.0, with your own account. Stockbit can change them at any time, and automated
> use may be against its terms. Use it for your own analysis, gently.
>
> **`order_buy` and `order_sell` trade with real money.** Every order is checked first, then shown
> to you in two confirmation popups in a row, and sent only if you tick both. Clients that cannot
> show popups (MCP elicitation) cannot place orders at all; there is no preview-and-token path for
> them. Nothing else here places orders or moves money; set `STOCKBIT_MCP_ORDERS=off` to remove the
> two order tools.

## What you can ask

The examples below show the tool the assistant picks and the shape of the result. **The numbers are
illustrative, not real market data.**

**"Broker mana yang akumulasi BBCA seminggu terakhir?"**

```jsonc
// broker_summary { "symbol": "BBCA", "period": "BROKER_SUMMARY_PERIOD_LAST_7_DAYS" }
{
  "ok": true,
  "data": {
    "broker_summary": {
      "brokers_buy":  [{ "netbs_broker_code": "AK", "blot": "41250", "bval": "3.71e+11", "netbs_buy_avg_price": "9010" }],
      "brokers_sell": [{ "netbs_broker_code": "YP", "slot": "-28840", "sval": "-2.60e+11", "netbs_sell_avg_price": "9025" }]
    },
    "bandar_detector": { "avg": { "accdist": "Acc" } }
  },
  "meta": { "durationMs": 412, "source": "/marketdetectors/BBCA?period=BROKER_SUMMARY_PERIOD_LAST_7_DAYS&…" }
}
```

**"Foreign flow TLKM sebulan ini gimana?"** → `foreign_flow { "symbol": "TLKM", "period": "PERIOD_RANGE_1M" }`
returns the daily foreign and domestic buy, sell and net series with totals.

**"Pasar hari ini lebih banyak yang naik atau turun?"** → `market_breadth {}` returns how many IHSG
stocks are up, down and unchanged (`{ "date": "2026-11-17" }` for a past day).

**"Saham apa saja yang satu industri sama AMRT?"** → `company_classifications` gives the four-level
sector tree (Sektor → Sub-sektor → Industri → Sub-industri), then
`company_by_classification { "ids": [117], "sort_order": "SORT_ORDER_HIGHEST_MARKET_CAP" }` lists the peers.

**"Running trade GOTO, cuma yang di atas 1 miliar"** →
`flow_running_trade { "symbols": ["GOTO"], "value_from": 1000000000 }`.

**"Cari saham PER di bawah 10 dan ROE di atas 15%"** → the assistant looks up metric ids with
`screener_metrics`, then runs

```jsonc
// screener_run
{ "rules": [
    { "metric_id": 2661, "metric_name": "PE Ratio (TTM)", "operator": "<", "value": 10 },
    { "metric_id": 2671, "metric_name": "ROE (TTM)", "operator": ">", "value": 15 } ] }
```

(metric ids here are placeholders; the real ones come from `screener_metrics`). The screener runs
as a temporary screen: nothing is saved to your account.

**"Hapus watchlist Swing"** → `watchlist_delete` asks you first. In Claude a confirmation form pops
up; nothing is deleted unless you tick it. Clients without such forms get a preview and a one-time
token instead, and the assistant must come back with your yes.

**"Beli BBCA 10 lot di 9500"** → `order_buy { "symbol": "BBCA", "lot": 10, "price": 9500 }`. Before
anything is sent the tool reads the stock, the order book, your trading balance and the fee rates,
and refuses an order that cannot go through: a suspended or untradable stock, a price off the IDX
tick grid (it names the nearest valid prices), a price outside today's ARB–ARA band, a sell of more
lots than you have. Then two popups come up, one after the other:

```text
Order BELI BBCA (1/2): cek detailnya

Saham: BBCA (Bank Central Asia Tbk.)
Aksi: BELI, limit order, berlaku hari ini, pasar reguler
Jumlah: 10 lot (1.000 lembar)
Harga: Rp 9.500 per lembar
Nilai order: Rp 9.500.000
Perkiraan total dengan fee: Rp 9.514.250
Pasar: terakhir Rp 9.475, bid 9.475 / offer 9.500, ARB 8.825 – ARA 10.150
Trading balance: Rp 20.000.000
Akun: Reguler

[ ] Ya, detail order ini benar
```

```text
Konfirmasi terakhir (2/2): BELI BBCA

BELI BBCA 10 lot @ Rp 9.500 = Rp 9.500.000 (≈ Rp 9.514.250 dengan fee)
Ini order sungguhan. Setelah dicentang, order langsung dikirim ke Stockbit dan bisa langsung match.

[ ] Ya, kirim order BELI BBCA sekarang
```

Declining or closing either popup sends nothing (`CONFIRMATION_DECLINED`). After both:

```jsonc
{
  "ok": true,
  "data": {
    "sent": true, "order_id": "1029384756", "side": "BUY", "symbol": "BBCA",
    "lot": 10, "shares": 1000, "price": 9500, "value": 9500000,
    "ui_ref": "W1793238399484BcQSgrPVpSkQs",
    "next": "Call account_orders for BBCA to see whether it is OPEN, matched or REJECTED by the exchange."
  },
  "meta": { "durationMs": 12, "source": "/order/v2/buy" }
}
```

Orders are plain limit orders, good for the day, on the regular board: no market, GTC, split,
day-trade or smart orders, and no amend or cancel (do those in the Stockbit app). An accepted order
can still be rejected by the exchange; `account_orders` shows what happened. If the connection
drops or Stockbit answers 5xx while the order is being sent, the tool says `ORDER_UNCERTAIN` and
does not resend: look in `account_orders` first.

**"Ada endpoint Stockbit buat seasonality?"** → `api_catalog { "query": "seasonality" }`, then
`api_get` calls it. `api_get` reaches every read endpoint in the catalog (195 of them), so data
without a dedicated tool is still one call away.

The full list, with every input, is in [docs/tools.md](docs/tools.md).

## Setup

Needs Node.js 20.19 or newer and a Stockbit account.

```bash
pnpm install
pnpm build
npx playwright-core@1.64.1 install chromium   # once: the browser the requests go through
```

To type `stockbit-mcp` instead of `node dist/cli.js`, put the CLI on your PATH once (any directory
on PATH works; `~/.local/bin` does not depend on the Node version nvm has active):

```bash
ln -s "$PWD/dist/cli.js" ~/.local/bin/stockbit-mcp
```

The link points at `dist/`, so a later `pnpm build` is picked up without linking again.

### Why Chromium shows up in the Dock

Stockbit's Cloudflare answers 403 to Node's `fetch` and to headless Chromium, and lets a visible
browser through (checked 2026-10-28). So every request, the login included, is sent from a real,
non-headless Chromium, kept out of the way: its windows (one per Stockbit host) open in the
background and minimized, without taking the keyboard focus, so all you see is its icon in the
Dock. It closes 2 seconds after the last request, so a tool call that makes several requests (a
token refresh, a retry) or tools called back to back share one browser. Starting it adds about a
second to the first call. During `login` it stays open until the login is done. Set
`STOCKBIT_MCP_BROWSER_WINDOW=normal` to watch the window instead.

To use a Chrome you already have instead of Playwright's Chromium, set
`STOCKBIT_MCP_BROWSER_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"`.

### Log in

```bash
stockbit-mcp login            # username/email and password
```

On a device Stockbit has not seen, it pushes an approval prompt to the Stockbit app on your phone;
approve it there (after five minutes the login falls back to a one-time code by WhatsApp, SMS or
email). Some accounts get verification steps only the app can do; then use tokens from a browser:

```bash
stockbit-mcp login --token
```

In a browser logged in to stockbit.com, open the developer tools, Network tab, and pick any request
to `exodus.stockbit.com`: the access token is its `Authorization` header without `Bearer `. The
refresh token is in the answer of the login request (`refresh.token`); without it you log in again
when the access token expires (about a day).

The `account_*` and `order_*` tools also need the brokerage session, opened with your trading PIN:

```bash
stockbit-mcp login --trading
```

The session lives in `~/.stockbit-mcp/session.json`, readable by you only. Tokens are refreshed
automatically when Stockbit rejects them, and are never logged or returned by a tool. `status`
shows the state, `logout` (or `logout --trading`) removes it.

### Connect a client

Claude Code:

```bash
claude mcp add stockbit -- node /absolute/path/to/stockbit-mcp/dist/cli.js
```

Orders need a client that shows MCP elicitation popups. Claude Code does. Claude Desktop did not as
of mid-2026, so there the order tools answer `CONFIRMATION_UNAVAILABLE` and everything else works.

Claude Desktop, Cursor and other clients (in their MCP JSON config):

```json
{
  "mcpServers": {
    "stockbit": {
      "command": "node",
      "args": ["/absolute/path/to/stockbit-mcp/dist/cli.js"]
    }
  }
}
```

## Reading the numbers

| Field | Unit |
|---|---|
| Prices, values, amounts | IDR |
| Running trade, trade book, order queue, broker summary `blot`/`slot`, broker flow, price history `volume`, market movers `volume` | lots (100 shares) |
| Order book `bid[].volume` / `offer[].volume`, `total_bid_offer.raw_lot`, foreign flow `volume`, broker top `total_volume`, broker summary `blotv` | shares |

Other things worth knowing:

- Broker codes in the running trade are hidden while the market is open (`is_show_bs: false`); broker
  and investor filters work after the close or for a past date.
- Broker and foreign summaries are end-of-day or mid-day snapshots (`is_mid_day`), not tick-live.
- Board and period parameters use different enum families per endpoint (`BOARD_TYPE_*`,
  `MARKET_TYPE_*`, `MARKET_BOARD_*`, `RT_PERIOD_*`, `TB_PERIOD_*` …). Each tool lists the values it takes.
- Some features need Stockbit Pro or a minimum equity; Stockbit answers those with `PAYWALLED`.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `STOCKBIT_MCP_HOME` | `~/.stockbit-mcp` | Where the session file lives |
| `STOCKBIT_MCP_CONFIRM` | `auto` | How deletions are confirmed: `elicit` (always a popup), `token` (always preview + token), `auto` (popup when the client supports it). Orders always take two popups, whatever this says |
| `STOCKBIT_MCP_ORDERS` | `on` | `off` removes `order_buy` and `order_sell` |
| `STOCKBIT_MCP_MAX_ITEMS` | `200` | Lists in results are cut after this many items, with a warning |
| `STOCKBIT_MCP_TIMEOUT_MS` | `20000` | Per-request timeout |
| `STOCKBIT_MCP_LOG_LEVEL` | `info` | Logs go to stderr |
| `STOCKBIT_MCP_HTTP` | `browser` | `browser` sends requests from a Chromium tab; `node` uses Node's `fetch` (blocked by Cloudflare as of 2026-10-28) |
| `STOCKBIT_MCP_BROWSER_PATH` | Playwright's Chromium | Path to a Chrome or Chromium executable |
| `STOCKBIT_MCP_BROWSER_WINDOW` | `minimized` | `minimized` opens Chromium's windows minimized in the background; `normal` shows them |
| `STOCKBIT_MCP_BROWSER_IDLE_MS` | `2000` | Chromium closes this many ms after the last request (`0`: right away) |
| `STOCKBIT_MCP_BROWSER_HEADLESS` | `false` | `true` hides the window, but Cloudflare blocks headless Chromium |

## Watch bot

`stockbit-mcp watch` is a separate command that runs on your Mac during market hours. It watches the
whole IDX market on Stockbit's realtime feed and sends you alerts for scalping, day-trading and
swing setups, plus warnings on stocks you hold. It never places orders.

> **Rules, not advice.** Every alert comes from explicit rules (HAKA/HAKI share, RVOL, swept offers,
> bid and offer walls, broker accumulation …) with its score broken down. Tune them on your own
> recordings before trusting them, and decide every trade yourself.

How it works:

- The running trade of every stock (`*` on the datafeed) feeds per-stock windows: value against the
  20-day average (RVOL), HAKA vs HAKI, big lots, range.
- Every 30 s it keeps two short lists: the top 5 by momentum and the top 5 by quiet accumulation.
  Those, plus your holdings, get the live order book, which shows walls, fake walls and thinning
  offers.
- Detectors fire on setups:
  - scalping: HAKA sweep, offer thinning, big-lot burst;
  - day trading: RVOL spike, day-high break, accumulation, markup, distribution;
  - swing: bandar accumulation from daily bars, the broker summary and foreign flow, at the lunch
    break, 15:00 and 16:10;
  - exits on what you hold: stop broken, first target reached, distribution.
- An alert goes out only above the style's score threshold, at most once per stock and style per 10
  minutes, and at most 30 a day.

What an alert looks like (illustrative numbers):

```text
🔥 [SCALP] SMRA 278 (+3,0%) — HAKA sapu offer
AKSI: BELI 276–278 · SL 270 (−2,9%) · TP1 290 · TP2 298 · R:R 1:1,5
• 5 menit: Rp2,1 M (RVOL 6,2x), HAKA 91%
• Sapu 3 level offer 274→280, lot terbesar 3.000
• Bid tebal di 272: 50.000 lot, bertahan 1 menit
Skor 87/100: RVOL +25 · HAKA +20 · sapu +20 · bid +12 · offer tipis +10
⚠️ Notasi: – · UMA: tidak · ke ARA: +20% · Sinyal aturan, bukan saran.
09:33:12
```

The levels in an alert:

- **Stop:** under the nearest structure that leaves room, meaning a holding bid wall, the day's low
  or VWAP (for swing: the 10-day low or the 20-day average).
- **Targets:** 1.5R and 2.5R, the first capped at a persisting offer wall.
- **No portfolio in alerts:** notifications show the signal only, never your holdings, balance or a
  lot size. (Lot sizes are still worked out internally, from 1% risk of the cash trading balance, to
  turn a buy with no room to its target into TUNGGU.)
- **Price grid:** every price is on the IDX tick grid and inside ARB–ARA.

Setup:

```bash
stockbit-mcp login                 # once
stockbit-mcp login --trading       # every morning, for exit warnings on what you hold
stockbit-mcp watch --setup-telegram  # optional: make a bot with @BotFather, send it /start, paste its token
stockbit-mcp watch --dry-run       # try it: alerts are printed, nothing is sent
stockbit-mcp watch                 # alerts to macOS notifications and Telegram
stockbit-mcp watch --install       # optional: start it every weekday at 08:40 (LaunchAgent)
```

The feed connects from Node directly (Stockbit's datafeed is not behind the browser check);
Chromium is used only for the few REST reads (company list, ARA/ARB, broker summary, portfolio).
Every feed frame is recorded to `~/.stockbit-mcp/tape/YYYY-MM-DD.bin.gz` and every alert to
`…alerts.ndjson`; `stockbit-mcp watch --replay <file>` runs a recorded day through the rules again.

Settings live in `~/.stockbit-mcp/watch.json`. Every key has a default, so the file only needs what
you change, for example:

```json
{ "risk": { "pct": { "scalp": 0.005 } }, "alerts": { "dailyCap": 15 }, "thresholds": { "day": 70 } }
```

The keys are `telegram`, `macos`, `styles` (turn scalp/day/swing/exit on or off), `risk`, `alerts`,
`thresholds`, `scanner`, `scalp`, `day`, `book` and `swing`. Their defaults are in
`src/watch/config.ts`.

## Errors

Every result is `{ ok, data | error, meta }`. Error codes: `AUTH_REQUIRED` / `TRADING_AUTH_REQUIRED`
(log in again), `PAYWALLED`, `RATE_LIMITED`, `BLOCKED` (Cloudflare), `BROWSER_UNAVAILABLE`
(Chromium is not installed or `STOCKBIT_MCP_BROWSER_PATH` is wrong), `TIMEOUT`, `INVALID_INPUT`,
`NOT_FOUND`, `UPSTREAM`, `CONFIRMATION_DECLINED`, `CONFIRMATION_EXPIRED`, `CONFIRMATION_UNAVAILABLE`
(the client cannot show the popups an order needs), `ORDER_UNCERTAIN` (the order may or may not
have reached Stockbit: check `account_orders` before sending it again).

## Development

```bash
pnpm test          # unit and in-memory MCP tests (no network)
pnpm typecheck
pnpm lint
pnpm docs:tools    # regenerate docs/tools.md
```

The endpoint catalog (`src/catalog/endpoints.json`) was built from the Stockbit desktop app; see
[docs/reverse-engineering.md](docs/reverse-engineering.md).

## License

MIT
