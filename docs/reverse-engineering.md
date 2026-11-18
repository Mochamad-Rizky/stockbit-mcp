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
