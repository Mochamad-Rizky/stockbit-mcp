# How the catalog was built

`src/catalog/endpoints.json` lists the endpoints the Stockbit desktop app (macOS) calls. Most of
it was made from 2.7.4 by static analysis of the installed app and of captures from the author's
own sessions; no Stockbit code was run and no request was made to Stockbit for it. The endpoints
added from 2.9.0 are described under "2.9.0 additions".

## The app

- `Stockbit.app` is a Tauri 2.12.1 shell (Rust, wry 0.57) around the system WKWebView. The web view
  is not inspectable (no `setInspectable:`), and the binary uses the hardened runtime, so the app
  cannot be driven over a debugging protocol the way an Electron app can.
- The main interface is a Vite bundle embedded in the binary: a phf map of `(path, brotli bytes)`
  entries in `__DATA_CONST`. Extracting it gives 627 assets.
- Most analysis features are Module Federation remotes loaded at run time from
  `storage.stockbit.com/<module>/<version>/static/remoteEntry.js` (broker-flow, broker-distribution,
  broker-position, broker-activity-chart, tradebook-chart, historical, financial, movers,
  top-stocks, insider-activity, chartbit, …). The pinned versions are in the bundle's fallback
  manifest; the files were read from the app's own WebKit network cache.
- API calls go through axios instances named after their host: `exodusServiceApi`
  (`exodus.stockbit.com`: market data, social, account), `sekuritasTradingV2Api`
  (`carina.stockbit.com`: brokerage) and `sekuritasSmartApi` (`api-sekuritas.stockbit.com`).

## 2.9.0 additions

`scripts/catalog-additions.json` holds the endpoints found in the Stockbit desktop app 2.9.0
(2026-11-18), in catalog form. They came from the same kind of static reading: the brotli assets
embedded in the 2.9.0 binary (632 of them; the Mach-O layout is unchanged) and the newest remote
modules in the app's WebKit network cache. Each was then checked with one live GET from the
author's own session.

- Remote versions are no longer pinned in the bundle: 2.9.0 resolves them at run time from
  `compass.stockbit.com/api/manifest/{app}/2.9.0/resolved`.
- `X-AppVersion` is the app version (`window.__SDA__.version`); the other headers are unchanged.
- New reads: the four-level sector classification (`/emitten/classification{,/list,/company}`),
  investor-side UBO (`/insider/ubo`), market breadth (`/order-trade/market-mover/catalog`, which
  only answers for `IHSG`), multi-symbol quotes (`/orderbook/companies`,
  `/company-price-feed/v3/prices/latest`), screener v2 lists (`/screener/v2/{templates,favorites}`;
  with `with_summary=true` they page by 10 whatever the limit) and `/search/v2/recent` (needs
  `placement`).
- Left out on purpose:
  - e-IPO (`/eipo/v1/*`, underwriters and their IPO performance) runs on a separate partner token
    (`/partner/eipo/access_token`) on carina and api-sekuritas.
  - Smart orders (stop, trailing stop, bracket, volume trigger), day-trade orders and bulk
    amend/cancel are order writes.
  - The AI screener (`POST /screener/rules/generate {prompt}`) writes to the server.

## Remote updates after 2.9.0

Remote modules change without an app update. `scripts/catalog-updates.json` holds changes to
endpoints the catalog already documents, applied by the build after the notes.

- 2026-11-21, `financial` 1.2.4: a **Broker Transaction** view (chunk 3567, a "broker map": pick
  brokers, see the stocks they traded and the stocks they share). It adds no endpoint: one
  `/order-trade/broker/activity` call per selected broker (query key `broker-map-activity`), plus
  prices in groups of 100 symbols. The app now sends `net_val_period=NET_VAL_PERIOD_7D`, an enum
  from `financial.order_trade.entity.v1.NetValPeriod` (7D, 1M, 3M, 6M, 1Y). Rows also carry
  `broker_code`, `type`, `date`, `freq`, `company_detail` and `nval_trend[{date, nval, nvol,
  nfreq}]`. Checked live the same day: without the parameter `nval_trend` is `[]`; 7D, 1M and 3M
  give 7, 21 and 63 daily points ending at the last trading day, even with an older `from`/`to`;
  6M and 1Y answer 404 "Data belum tersedia untuk periode ini".

## Realtime datafeed (used by `stockbit-mcp watch`)

Read from the 2.9.0 bundle (`usePrimus-*.js`, protobuf-es `proto3.makeMessageType` definitions) and
checked live on 2026-11-18 with the author's session.

- URL `wss://wss-jkt.trading.stockbit.com/ws?_s=dfctx_v2_<n>` (n = the app's reconnect counter),
  WebSocket subprotocol `desktop`, binary frames. Plain Node's `WebSocket` connects: unlike exodus
  REST, the datafeed is not behind Cloudflare's browser check.
- Client → server: `securities.transactional.datafeed.v1.WebsocketRequest{1 user_id, 2 channel,
  3 key, 4 ping, 5 access_token}`. The app subscribes with `{user_id, channel, access_token}` (the
  exodus access token), sends the whole channel set again whenever it changes, and pings
  `{4 {1 "ping"}}` every 15 s (answered `ping{"pong"}`; no answer within 3 s → reconnect).
- `WebsocketChannel` (repeated strings unless noted): watchlist 1, order_book 2, running_trade 3,
  is_hotlist 4 (bool), running_trade_batch 5, liveprice 6, iepiev 7, intraday 8, best_bid_offer 9,
  market_mover 10 (message), order_queue 11 (message), liveprice_v3 12, order_book_v3 13,
  intraday_v3 14, tradebook 15 (message), fitem 16 (message), market_mover_catalog 17. `"*"` in
  running_trade_batch streams the whole market: about 94 trades/s and 8 KB/s mid-morning.
- Server → client: `WebsocketWrapMessageChannel`, a oneof: running_trade 1, ping 2, top20 3,
  watchlist 4, orderbook_header 5, orderbook_body 6, error 7 (`{1 code 400|401, 2 message}`),
  running_trade_batch 8, liveprice 9, orderbook 10, iepiev 11, intraday 12, best_bid_offer 13,
  market_mover_batch 14, order_queue 15, liveprice_v3 16, orderbook_v3 17, intraday_v3 18,
  tradebook 19, fitem 20, market_mover_catalog 21, tradebook_book 22.
- `RunningTrade`: stock 2, price 3 (double), volume 4 (double, **shares**), action 5 (1 buy-initiated =
  HAKA, 2 sell-initiated = HAKI), time 7 (Timestamp), trade_number 9, market_board 10, value 11. No
  broker code. Checked: 300 shares × 5 675 = value 1 702 500.
- `orderbook` (10) carries `{1 stock_code, 2 body}` where body is text, one side per message:
  `#O|BBRI|BID|3120;179;2245700|3110;444;3551900|…|1794969627-5368&49457200` (price; number of
  orders; shares … then epoch seconds-n & total shares). Full depth (24 levels seen). In a 20 s test
  `order_book_v3` and `best_bid_offer` sent nothing for the symbols tried.
- `liveprice_v3` (16): numbers as `financial.common.v1.DecimalValue{1 raw{1 value string}, 2 formatted}`.

## Protocol facts the server relies on

- Headers: `Authorization: Bearer <token>`, `X-Platform: desktop`, `X-AppVersion: 2.9.0` (2.7.4
  before).
- Login: `POST /login/v6/username {user, password, player_id}`; a new device answers with
  `new_device.trusted_device` (approval prompt: `/login/v4/new-device/prompt/send`, poll
  `/mfa/v1/prompt/verified/result` every 2 s, `/login/v4/new-device/prompt/verify`) or
  `new_device.multi_factor` (`/mfa/verification/v1/challenge/*`, then `/login/v6/new-device/verify`).
- Refresh: exodus `POST /login/refresh` and carina `POST /auth/refresh`, each with its refresh token
  as the bearer and no body; both rotate the refresh token. The app refreshes only after a 401.
- Brokerage session: `GET exodus /sekuritas/auth/token`, then `POST carina /auth/v2/login
  {login_token, pin}`.
- Errors: `{message, error_type, data}`; `NO_SUBSCRIPTION` / 402 means paywalled; a 403 with
  `cf-mitigated: challenge` is a Cloudflare challenge (most likely on the login paths).
- Cloudflare (2026-10-28): Node's `fetch` and headless Chromium get a 403 "Attention Required" page
  on every exodus path, with or without a token; a headful Chromium (Playwright's, or Chrome) gets
  the API's own answers. Hence `src/core/browser.ts` sends requests from a tab on the API origin.

## Orders

`order_buy` and `order_sell` are written by hand (`src/tools/orders.ts`), not from the catalog,
which holds GETs only. The request bodies come from the app's own submit code; no order traffic was
captured, so the answer shape (`data.order_id`) is inferred from how the app reads it.

- `POST carina /order/v2/buy` and `/order/v2/sell`: `{ui_ref, symbol, price, shares, board_type:
  "RG", is_gtc, time_in_force: "0", platform_order_type}`. `shares` is lots × 100; `price` is IDR
  per share. `PLATFORM_ORDER_TYPE_LIMIT_DAY` with `is_gtc: false` is the app's limit, good-for-day
  order.
- `ui_ref` is the app's idempotency key, `W` + `Date.now()` + 13 letters, one per order. Whether
  carina deduplicates on it is not known, so an order is never resent after a timeout or a 5xx.
- No PIN goes with an order: the trading access token is the only authorization.
- The app checks the IDX tick table (`fractionList`) and reads ARA/ARB from the exodus order book;
  the server enforces both before asking the user.

## Rebuilding

The notes the builder reads hold paths, parameter names, enum literals and descriptions only. The
captures they came from contain personal data and are not part of this repository.

```bash
node scripts/build-catalog.mjs <research-dir> <static-catalog.json>
```
