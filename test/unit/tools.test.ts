import type { z } from 'zod';
import { buildRequest, endpoint, ENDPOINTS } from '../../src/catalog/index.js';
import { allTools } from '../../src/tools/index.js';
import { harness } from './helpers.js';

describe('tool definitions', () => {
  const tools = allTools();

  it('have unique snake_case names that start with their domain', () => {
    const names = tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z]+(_[a-z0-9]+)*$/);
      expect(t.name.startsWith(`${t.domain}`)).toBe(true);
    }
  });

  it('describe every input', () => {
    for (const t of tools) {
      for (const [key, schema] of Object.entries(t.inputSchema)) {
        expect((schema as z.ZodType).description, `${t.name}.${key}`).toBeTruthy();
      }
    }
  });

  it('annotate every tool that changes something as not read-only', () => {
    const writers = tools.filter((t) => /_(create|rename|add|remove|delete|set_status)$/.test(t.name));
    expect(writers.length).toBeGreaterThan(5);
    for (const t of writers) expect(t.annotations.readOnlyHint).toBe(false);
  });

  it('place orders only through order_buy and order_sell, never through the catalog', () => {
    const orders = tools.filter((t) => t.domain === 'order').map((t) => t.name);
    expect(orders).toEqual(['order_buy', 'order_sell']);
    for (const name of orders) {
      expect(tools.find((t) => t.name === name)?.annotations.destructiveHint).toBe(true);
    }
    expect(ENDPOINTS.some((e) => e.host === 'carina' && e.method !== 'GET')).toBe(false);
  });
});

describe('catalog requests', () => {
  it('maps dotted query keys and applies the app defaults', () => {
    const req = buildRequest(endpoint('get_running_trade'), { symbols: ['BBCA'], time_range_start: '09:00' });
    expect(req.path).toBe('/order-trade/running-trade');
    expect(req.query).toMatchObject({
      symbols: ['BBCA'],
      'time_range.start': '09:00',
      limit: 50,
      sort: 'DESC',
      order_by: 'RUNNING_TRADE_ORDER_BY_TIME',
    });
  });

  it('fills path parameters', () => {
    const req = buildRequest(endpoint('get_broker_summary'), { symbol: 'BBCA' });
    expect(req.path).toBe('/marketdetectors/BBCA');
    expect(req.query.period).toBe('BROKER_SUMMARY_PERIOD_LATEST');
  });

  // Stockbit answers the preset when both are sent: period=LATEST with from/to=2026-10-07 gave
  // the latest day's broker summary (live, 2026-10-29).
  it('leaves the preset default out when a date range is given', () => {
    const req = buildRequest(endpoint('get_broker_summary'), {
      symbol: 'BBCA',
      from: '2026-10-07',
      to: '2026-10-07',
    });
    expect(req.query).toMatchObject({ from: '2026-10-07', to: '2026-10-07' });
    expect(req.query).not.toHaveProperty('period');

    const historical = buildRequest(endpoint('get_broker_activity_historical'), {
      broker_codes: ['YP'],
      date_from: '2026-10-01',
      date_to: '2026-10-07',
    });
    expect(historical.query).not.toHaveProperty('period');

    const top = buildRequest(endpoint('get_top_stocks'), { start: '2026-10-01', end: '2026-10-07' });
    expect(top.query).not.toHaveProperty('period');
  });

  // The Broker Transaction view (financial 1.2.4) asks for the daily net trend this way; without
  // net_val_period nval_trend comes back empty (live, 2026-11-21).
  it('sends net_val_period for broker activity only when asked', () => {
    const plain = buildRequest(endpoint('get_broker_activity'), { broker_code: ['XL'] });
    expect(plain.query).not.toHaveProperty('net_val_period');

    const trend = buildRequest(endpoint('get_broker_activity'), {
      broker_code: ['XL'],
      net_val_period: 'NET_VAL_PERIOD_7D',
    });
    expect(trend.query).toMatchObject({ broker_code: ['XL'], net_val_period: 'NET_VAL_PERIOD_7D' });
  });

  it('sends the UNSPECIFIED preset with a date range where the endpoint has one', () => {
    const req = buildRequest(endpoint('get_foreign_flow_summary'), {
      symbols: ['BBCA'],
      from: '2026-10-01',
      to: '2026-10-07',
    });
    expect(req.query).toMatchObject({ period: 'TB_PERIOD_UNSPECIFIED', from: '2026-10-01', to: '2026-10-07' });
  });

  it('keeps a preset the caller chose next to a range', () => {
    const req = buildRequest(endpoint('get_broker_summary'), {
      symbol: 'BBCA',
      period: 'BROKER_SUMMARY_PERIOD_LAST_7_DAYS',
      from: '2026-10-07',
    });
    expect(req.query.period).toBe('BROKER_SUMMARY_PERIOD_LAST_7_DAYS');
  });
});

describe('dates sent by the price tools', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('sends intraday bounds as unix seconds of the Jakarta day, newest first', async () => {
    const h = await harness((req) =>
      req.url.pathname === '/chartbit/BBCA/price/intraday' ? { body: { data: { chartbit: [] } } } : undefined,
    );
    await h.callTool('price_intraday_bars', { symbol: 'BBCA', start_date: '2026-10-07', end_date: '2026-10-07' });
    const q = h.calls[0]!.url.searchParams;
    expect(q.get('from')).toBe(String(Date.parse('2026-10-07T23:59:59+07:00') / 1000));
    expect(q.get('to')).toBe(String(Date.parse('2026-10-07T00:00:00+07:00') / 1000));
  });

  it('defaults "today" to the Jakarta date, not the UTC one', async () => {
    // 01:30 in Jakarta on the 29th is still the 28th in UTC.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T18:30:00Z'));
    const h = await harness((req) =>
      req.url.pathname.startsWith('/company-price-feed/historical/summary/') ? { body: { data: [] } } : undefined,
    );
    await h.callTool('price_history', { symbol: 'BBCA' });
    const q = h.calls[0]!.url.searchParams;
    expect(q.get('end_date')).toBe('2026-10-29');
    expect(q.get('start_date')).toBe('2025-10-29');
  });
});

describe('tools over MCP', () => {
  it('reads the running trade with upper-cased symbols and returns Stockbit data', async () => {
    const h = await harness((req) =>
      req.url.pathname === '/order-trade/running-trade' ? { body: { message: 'ok', data: { running_trade: [1, 2] } } } : undefined,
    );
    const out = await h.callTool('flow_running_trade', { symbols: ['bbca'] });
    expect(out.ok).toBe(true);
    expect(out.data).toEqual({ running_trade: [1, 2] });
    const sent = h.calls[0]!;
    expect(sent.url.host).toBe('exodus.stockbit.com');
    expect(sent.url.searchParams.getAll('symbols')).toEqual(['BBCA']);
    expect(sent.headers.Authorization).toBe('Bearer exo-access');
    expect(sent.headers['X-Platform']).toBe('desktop');
  });

  it('sends chartbit bars with the newest date as `from`', async () => {
    const h = await harness(() => ({ body: { data: [] } }));
    await h.callTool('price_daily_bars', { symbol: 'TLKM', start_date: '2026-01-01', end_date: '2026-06-30' });
    const sent = h.calls[0]!;
    expect(sent.url.pathname).toBe('/chartbit/TLKM/price/daily');
    expect(sent.url.searchParams.get('from')).toBe('2026-06-30');
    expect(sent.url.searchParams.get('to')).toBe('2026-01-01');
  });

  it('uses the trading token for account tools', async () => {
    const h = await harness(() => ({ body: { data: { results: [] } } }));
    await h.callTool('account_portfolio');
    expect(h.calls[0]?.url.host).toBe('carina.stockbit.com');
    expect(h.calls[0]?.headers.Authorization).toBe('Bearer car-access');
  });

  it('caps long lists and says so', async () => {
    const h = await harness(() => ({ body: { data: Array.from({ length: 30 }, (_, i) => i) } }), {
      env: { STOCKBIT_MCP_MAX_ITEMS: '10' },
    });
    const out = await h.callTool('market_movers');
    expect(out.data).toHaveLength(10);
    expect(out.meta.warnings[0]).toContain('kept 10 of 30');
  });

  it('reports a missing session as AUTH_REQUIRED with a hint', async () => {
    const h = await harness(() => ({ body: {} }), { session: { version: 1 } });
    const out = await h.callTool('company_info', { symbol: 'BBCA' });
    expect(out.ok).toBe(false);
    expect(out.error.code).toBe('AUTH_REQUIRED');
    expect(out.error.hint).toContain('stockbit-mcp login');
  });

  it('refreshes an expired exodus token with the refresh token and retries', async () => {
    const h = await harness((req) => {
      if (req.url.pathname === '/login/refresh') {
        expect(req.headers.Authorization).toBe('Bearer exo-refresh');
        return {
          body: { data: { access: { token: 'exo-new', expired_at: '2026-10-29T00:00:00Z' }, refresh: { token: 'exo-refresh-2' } } },
        };
      }
      return req.headers.Authorization === 'Bearer exo-new' ? { body: { data: { ok: 1 } } } : { status: 401, body: {} };
    });
    const out = await h.callTool('market_status');
    expect(out.ok).toBe(true);
    const saved = await h.store.read();
    expect(saved.exodus?.access.token).toBe('exo-new');
    expect(saved.exodus?.refresh?.token).toBe('exo-refresh-2');
  });

  it('refreshes the trading token on carina 401', async () => {
    const h = await harness((req) => {
      if (req.url.pathname === '/auth/refresh') {
        expect(req.url.host).toBe('carina.stockbit.com');
        expect(req.headers.Authorization).toBe('Bearer car-refresh');
        return { body: { data: { access_token: 'car-new', refresh_token: 'car-refresh-2', account: { type: 1 } } } };
      }
      return req.headers.Authorization === 'Bearer car-new' ? { body: { data: {} } } : { status: 401, body: {} };
    });
    expect((await h.callTool('account_cash')).ok).toBe(true);
    expect((await h.store.read()).trading?.access.token).toBe('car-new');
  });
});

// Requests of the 2.9.0 endpoints, shaped as the app sends them and as Stockbit answered them live
// (2026-11-18).
describe('tools for the 2.9.0 endpoints', () => {
  const sent = async (tool: string, args: Record<string, unknown>) => {
    const h = await harness(() => ({ body: { message: 'ok', data: [] } }));
    const out = await h.callTool(tool, args);
    expect(out.ok, JSON.stringify(out.error)).toBe(true);
    const req = h.calls[0]!;
    return { path: req.url.pathname, q: req.url.searchParams, headers: req.headers };
  };

  it('sends the 2.9.0 app version', async () => {
    const { headers } = await sent('company_classifications', {});
    expect(headers['X-AppVersion']).toBe('2.9.0');
  });

  it('lists companies of several classification nodes with a sort order', async () => {
    const { path, q } = await sent('company_by_classification', {
      ids: [10, 11],
      sort_order: 'SORT_ORDER_HIGHEST_MARKET_CAP',
    });
    expect(path).toBe('/emitten/classification/company');
    expect(q.getAll('ids')).toEqual(['10', '11']);
    expect(q.get('sort_order')).toBe('SORT_ORDER_HIGHEST_MARKET_CAP');
  });

  it('reads one classification node by id', async () => {
    const { path, q } = await sent('company_classification', { id: 1 });
    expect(path).toBe('/emitten/classification');
    expect(q.get('id')).toBe('1');
  });

  it('reads the UBO view of an investor', async () => {
    const { path, q } = await sent('ownership_investor_ubo', { investor_id: '11460', report_date: '2026-10-31' });
    expect(path).toBe('/insider/ubo');
    expect(q.get('investor_id')).toBe('11460');
    expect(q.get('report_date')).toBe('2026-10-31');
  });

  it('asks market breadth for IHSG unless told otherwise', async () => {
    const live = await sent('market_breadth', {});
    expect(live.path).toBe('/order-trade/market-mover/catalog');
    expect(live.q.get('catalog_codes')).toBe('IHSG');
    expect(live.q.has('date')).toBe(false);
    const past = await sent('market_breadth', { date: '2026-11-17' });
    expect(past.q.get('date')).toBe('2026-11-17');
  });

  it('sends many symbols upper case, once per key', async () => {
    const snap = await sent('price_snapshot', { symbols: ['bbca', 'tlkm'] });
    expect(snap.path).toBe('/orderbook/companies');
    expect(snap.q.getAll('symbols')).toEqual(['BBCA', 'TLKM']);
    const latest = await sent('price_latest', { symbol: ['goto'] });
    expect(latest.path).toBe('/company-price-feed/v3/prices/latest');
    expect(latest.q.getAll('symbol')).toEqual(['GOTO']);
  });

  it('pages favorite screeners like the app (page 1, 25 per page)', async () => {
    const { path, q } = await sent('screener_favorites', { search: 'momentum' });
    expect(path).toBe('/screener/v2/favorites');
    expect(q.get('page')).toBe('1');
    expect(q.get('limit')).toBe('25');
    expect(q.get('search')).toBe('momentum');
  });

  it('refuses more than 100 symbols in one snapshot', async () => {
    const h = await harness(() => ({ body: { data: [] } }));
    // The MCP SDK checks the input schema before the tool runs.
    const result = await h.client.callTool({
      name: 'price_snapshot',
      arguments: { symbols: Array.from({ length: 101 }, (_, i) => `S${i}`) },
    });
    expect(result.isError).toBe(true);
    expect(h.calls).toHaveLength(0);
  });
});

describe('api tools', () => {
  it('lists groups and finds endpoints by words', async () => {
    const h = await harness(() => undefined);
    const groups = await h.callTool('api_catalog');
    expect(groups.data.total).toBeGreaterThan(100);
    const found = await h.callTool('api_catalog', { query: 'broker distribution' });
    expect(found.data.endpoints.map((e: { id: string }) => e.id)).toContain('get_broker_distribution');
  });

  it('calls a documented endpoint and refuses unknown query names', async () => {
    const h = await harness(() => ({ body: { data: { ok: true } } }));
    const ok = await h.callTool('api_get', {
      endpoint_id: 'get_seasonality',
      path_params: { symbol: 'BBRI' },
      query: { back_year: 5, year: 2026 },
    });
    expect(ok.ok).toBe(true);
    expect(h.calls[0]?.url.pathname).toBe('/company-price-feed/seasonality/BBRI');

    const bad = await h.callTool('api_get', { endpoint_id: 'get_seasonality', path_params: { symbol: 'BBRI' }, query: { nope: 1 } });
    expect(bad.error.code).toBe('INVALID_INPUT');
  });

  it('refuses writes', async () => {
    const h = await harness(() => undefined);
    const write = ENDPOINTS.find((e) => e.method !== 'GET')!;
    const out = await h.callTool('api_get', { endpoint_id: write.id });
    expect(out.error.code).toBe('INVALID_INPUT');
    expect(h.calls).toHaveLength(0);
  });
});

describe('screener_run', () => {
  it('serializes rules the way the app does (no underscores) and never saves', async () => {
    const h = await harness(() => ({ body: { data: { calcs: [] } } }));
    await h.callTool('screener_run', {
      rules: [
        { metric_id: 2661, metric_name: 'PE_Ratio', operator: '<', value: 10 },
        { metric_id: 2, metric_name: 'Price', operator: '>', compare_metric_id: 3, compare_metric_name: 'MA 20', multiplier: 1.1 },
      ],
    });
    const body = h.calls[0]!.body as { save: string; filters: string; universe: string };
    expect(h.calls[0]!.method).toBe('POST');
    expect(body.save).toBe('0');
    expect(body.filters).not.toContain('_');
    expect(JSON.parse(body.filters)).toEqual([
      { id: 1, type: 'basic', item1: 2661, item1name: 'PERatio', operator: '<', item2: '10', item2name: '', multiplier: '' },
      { id: 2, type: 'compare', item1: 2, item1name: 'Price', operator: '>', item2: '3', item2name: 'MA 20', multiplier: '1.1' },
    ]);
    expect(JSON.parse(body.universe)).toEqual({ name: 'IHSG', scope: 'IHSG', scopeId: '' });
  });
});

describe('confirmed deletions', () => {
  it('deletes a watchlist only after the user ticks the popup', async () => {
    const asked: string[] = [];
    const h = await harness(() => ({ body: { data: null } }), {
      elicit: (message) => {
        asked.push(message);
        return { action: 'accept', content: { confirm: true } };
      },
    });
    const out = await h.callTool('watchlist_delete', { watchlist_id: 42, watchlist_name: 'Swing' });
    expect(out.ok).toBe(true);
    expect(asked[0]).toContain('Swing');
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['DELETE /watchlist/42']);
  });

  it('sends nothing when the user declines', async () => {
    const h = await harness(() => ({ body: {} }), { elicit: () => ({ action: 'decline' }) });
    const out = await h.callTool('alert_delete', { alert_ids: [1, 2] });
    expect(out.error.code).toBe('CONFIRMATION_DECLINED');
    expect(h.calls).toHaveLength(0);
  });

  it('uses a preview and token when the client has no popup', async () => {
    const h = await harness(() => ({ body: { data: null } }));
    const first = await h.callTool('alert_delete', { alert_ids: [7] });
    expect(first.ok).toBe(true);
    expect(first.data.status).toBe('pending');
    expect(h.calls).toHaveLength(0);

    const second = await h.callTool('alert_delete', { alert_ids: [7], confirmation_token: first.data.confirmation_token });
    expect(second.ok).toBe(true);
    expect(h.calls.map((c) => `${c.method} ${c.url.pathname}`)).toEqual(['POST /alert/v2/delete']);
    expect(h.calls[0]?.body).toEqual({ alert_ids: [7] });
  });
});

describe('watchlist_add', () => {
  it('looks up the company id and posts it', async () => {
    const h = await harness((req) =>
      req.url.pathname === '/emitten/BBCA/info' ? { body: { data: { id: 1234, symbol: 'BBCA' } } } : { body: { data: {} } },
    );
    await h.callTool('watchlist_add', { watchlist_id: 9, symbol: 'bbca' });
    const post = h.calls.find((c) => c.method === 'POST')!;
    expect(post.url.pathname).toBe('/watchlist/9/company/item');
    expect(post.body).toEqual({ company_id: 1234 });
  });
});
