import { buildQuery, StockbitHttp, type TokenProvider } from '../../src/core/http.js';
import { createLogger } from '../../src/core/logger.js';

const bases = {
  exodus: 'https://exodus.test',
  carina: 'https://carina.test',
  sekuritas: 'https://sekuritas.test',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function tokens(initial: Record<string, string | undefined>, refreshTo?: string): TokenProvider & {
  refreshed: string[];
} {
  const state = { ...initial };
  const refreshed: string[] = [];
  return {
    refreshed,
    async token(kind) {
      return state[kind];
    },
    async refresh(kind) {
      refreshed.push(kind);
      if (refreshTo === undefined) {
        return false;
      }
      state[kind] = refreshTo;
      return true;
    },
  };
}

function client(fetchImpl: typeof fetch, provider: TokenProvider) {
  return new StockbitHttp({
    bases,
    tokens: provider,
    logger: createLogger('silent'),
    timeoutMs: 1000,
    fetch: fetchImpl,
    sleep: async () => {},
  });
}

describe('buildQuery', () => {
  it('repeats keys for lists and skips empty values', () => {
    expect(buildQuery({ a: 1, b: ['x', 'y'], c: undefined, d: null, e: true })).toBe(
      'a=1&b=x&b=y&e=true',
    );
  });
});

describe('StockbitHttp', () => {
  it('sends the bearer token to the right host and returns the parsed body', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const http = client(async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return json(200, { message: 'ok', data: { x: 1 } });
    }, tokens({ exodus: 'tok' }));

    const res = await http.request({ path: 'emitten/BBCA/info', query: { a: 'b' } });

    expect(res.body).toEqual({ message: 'ok', data: { x: 1 } });
    expect(res.source).toBe('/emitten/BBCA/info?a=b');
    expect(calls[0]?.url).toBe('https://exodus.test/emitten/BBCA/info?a=b');
    expect((calls[0]?.init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('uses the trading token for carina', async () => {
    let auth = '';
    const http = client(async (_url, init) => {
      auth = (init?.headers as Record<string, string>).Authorization ?? '';
      return json(200, {});
    }, tokens({ exodus: 'e', trading: 't' }));
    await http.request({ host: 'carina', path: '/portfolio/v2/list' });
    expect(auth).toBe('Bearer t');
  });

  it('fails with AUTH_REQUIRED when there is no session', async () => {
    const http = client(async () => json(200, {}), tokens({}));
    await expect(http.request({ path: '/x' })).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('refreshes once on 401 and retries with the new token', async () => {
    const seen: string[] = [];
    const provider = tokens({ exodus: 'old' }, 'new');
    const http = client(async (_url, init) => {
      const a = (init?.headers as Record<string, string>).Authorization ?? '';
      seen.push(a);
      return a === 'Bearer new' ? json(200, { ok: 1 }) : json(401, { message: 'expired' });
    }, provider);

    await expect(http.request({ path: '/x' })).resolves.toMatchObject({ status: 200 });
    expect(seen).toEqual(['Bearer old', 'Bearer new']);
    expect(provider.refreshed).toEqual(['exodus']);
  });

  it('reports TRADING_AUTH_REQUIRED when the trading token cannot be renewed', async () => {
    const http = client(async () => json(401, { message: 'expired' }), tokens({ trading: 't' }));
    await expect(http.request({ host: 'carina', path: '/x' })).rejects.toMatchObject({
      code: 'TRADING_AUTH_REQUIRED',
    });
  });

  it('retries GETs on 5xx but never repeats a POST', async () => {
    let gets = 0;
    const getHttp = client(async () => {
      gets++;
      return gets < 3 ? json(503, {}) : json(200, { ok: 1 });
    }, tokens({ exodus: 't' }));
    await expect(getHttp.request({ path: '/x' })).resolves.toMatchObject({ status: 200 });
    expect(gets).toBe(3);

    let posts = 0;
    const postHttp = client(async () => {
      posts++;
      return json(503, { message: 'down' });
    }, tokens({ trading: 't' }));
    await expect(
      postHttp.request({ host: 'carina', method: 'POST', path: '/order/v2/buy', body: {} }),
    ).rejects.toMatchObject({ code: 'UPSTREAM' });
    expect(posts).toBe(1);
  });

  it('maps a Cloudflare page to BLOCKED', async () => {
    const http = client(
      async () => new Response('<title>Attention Required! | Cloudflare</title>', { status: 403 }),
      tokens({ exodus: 't' }),
    );
    await expect(http.request({ path: '/x' })).rejects.toMatchObject({ code: 'BLOCKED' });
  });

  it('keeps the upstream message on 400', async () => {
    const http = client(async () => json(400, { message: 'invalid symbol' }), tokens({ exodus: 't' }));
    await expect(http.request({ path: '/x' })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      message: 'invalid symbol',
    });
  });
});
