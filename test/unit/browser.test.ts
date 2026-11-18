import type { Browser, LaunchOptions } from 'playwright-core';
import { BrowserFetch } from '../../src/core/browser.js';
import { loadConfig } from '../../src/core/config.js';
import { StockbitMcpError } from '../../src/core/errors.js';
import { StockbitHttp } from '../../src/core/http.js';
import { createLogger } from '../../src/core/logger.js';

// A stand-in for Playwright: page.evaluate runs the in-page function right here, where `fetch` is
// stubbed, so the request and answer cross the same boundary they cross in Chromium.
// Over CDP it makes windows the way Chromium does: Target.createTarget answers first, and the page
// event reaches every listener a moment later.
function fakeChromium(options: { failLaunch?: number } = {}) {
  const state = {
    launches: 0,
    closes: 0,
    newPages: 0,
    gotos: [] as string[],
    // The URLs each page was sent to, page by page.
    pageGotos: [] as string[][],
    launchOptions: [] as LaunchOptions[],
    targets: [] as Array<Record<string, unknown>>,
    minimized: [] as number[],
  };
  let failures = options.failLaunch ?? 0;
  let disconnect: (() => void) | undefined;

  const makePage = () => {
    const gotos: string[] = [];
    state.pageGotos.push(gotos);
    const page = {
      on: () => page,
      async goto(url: string) {
        gotos.push(url);
        state.gotos.push(url);
        return null;
      },
      evaluate: <A, R>(fn: (arg: A) => Promise<R>, arg: A) => fn(structuredClone(arg)),
    };
    return page;
  };

  const launch = async (launchOptions: LaunchOptions) => {
    if (failures > 0) {
      failures--;
      throw new Error(
        "browserType.launch: Executable doesn't exist at /nowhere/chrome\n╔════ box ════╗",
      );
    }
    state.launches++;
    state.launchOptions.push(launchOptions);
    const contextIds: string[] = [];
    let pageListeners: Array<(page: unknown) => void> = [];
    const context = {
      async newPage() {
        state.newPages++;
        return makePage();
      },
      waitForEvent(event: string) {
        expect(event).toBe('page');
        return new Promise((resolve) => pageListeners.push(resolve));
      },
    };
    const cdp = {
      async send(method: string, params: Record<string, unknown> = {}) {
        switch (method) {
          case 'Target.getBrowserContexts':
            return { browserContextIds: [...contextIds] };
          case 'Target.createTarget': {
            state.targets.push(params);
            const targetId = `target-${state.targets.length}`;
            setTimeout(() => {
              const page = makePage();
              const listeners = pageListeners;
              pageListeners = [];
              listeners.forEach((resolve) => resolve(page));
            }, 0);
            return { targetId };
          }
          case 'Browser.getWindowForTarget':
            return { windowId: Number(String(params.targetId).split('-')[1]) };
          case 'Browser.setWindowBounds':
            expect(params.bounds).toEqual({ windowState: 'minimized' });
            state.minimized.push(params.windowId as number);
            return {};
          default:
            throw new Error(`unexpected CDP ${method}`);
        }
      },
    };
    const browser = {
      on(event: string, fn: () => void) {
        if (event === 'disconnected') disconnect = fn;
        return browser;
      },
      async newBrowserCDPSession() {
        return cdp;
      },
      async newContext() {
        contextIds.push(`ctx-${contextIds.length + 1}`);
        return context;
      },
      async close() {
        state.closes++;
        disconnect?.();
      },
    };
    return browser as unknown as Browser;
  };
  return { state, launch, disconnect: () => disconnect?.() };
}

function make(
  chromium: ReturnType<typeof fakeChromium>,
  idleMs = 60_000,
  window: 'minimized' | 'normal' = 'normal',
) {
  return new BrowserFetch({
    headless: false,
    window,
    logger: createLogger('silent'),
    launch: chromium.launch,
    idleMs,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('BrowserFetch', () => {
  it('sends the request from a tab on the target origin and rebuilds the answer', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response('{"message":"Unauthorized"}', {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json', 'cf-ray': 'abc' },
      });
    });
    const chromium = fakeChromium();
    const browser = make(chromium);

    const res = await browser.fetch('https://exodus.test/emitten/BBCA/info?a=1', {
      method: 'POST',
      headers: { Authorization: 'Bearer tok', 'X-Platform': 'desktop' },
      body: '{"x":1}',
    });

    expect(res.status).toBe(401);
    expect(res.statusText).toBe('Unauthorized');
    expect(res.headers.get('cf-ray')).toBe('abc');
    expect(await res.json()).toEqual({ message: 'Unauthorized' });
    expect(seen[0]?.url).toBe('https://exodus.test/emitten/BBCA/info?a=1');
    expect(seen[0]?.init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer tok', 'x-platform': 'desktop' },
      body: '{"x":1}',
    });
    expect(chromium.state.gotos).toEqual(['https://exodus.test/']);
    expect(chromium.state.launchOptions).toEqual([{ headless: false }]);
    await browser.close();
  });

  it('starts one browser and one tab per origin', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const chromium = fakeChromium();
    const browser = make(chromium);

    await Promise.all([
      browser.fetch('https://exodus.test/a'),
      browser.fetch('https://exodus.test/b'),
      browser.fetch('https://carina.test/c'),
    ]);
    await browser.fetch('https://exodus.test/d');

    expect(chromium.state.launches).toBe(1);
    expect(chromium.state.gotos.sort()).toEqual(['https://carina.test/', 'https://exodus.test/']);
    await browser.close();
  });

  it('opens minimized background windows instead of focused pages', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const chromium = fakeChromium();
    const browser = make(chromium, 60_000, 'minimized');

    await Promise.all([
      browser.fetch('https://exodus.test/a'),
      browser.fetch('https://carina.test/b'),
      browser.fetch('https://exodus.test/c'),
    ]);

    expect(chromium.state.newPages).toBe(0);
    expect(chromium.state.targets).toEqual([
      { url: 'about:blank', browserContextId: 'ctx-1', newWindow: true, background: true },
      { url: 'about:blank', browserContextId: 'ctx-1', newWindow: true, background: true },
    ]);
    expect(chromium.state.minimized).toEqual([1, 2]);
    // Each window got its own origin: the page events were not mixed up between the two.
    expect(chromium.state.pageGotos.map((g) => g.length)).toEqual([1, 1]);
    expect(chromium.state.gotos.sort()).toEqual(['https://carina.test/', 'https://exodus.test/']);
    await browser.close();
  });

  it('answers a 204 without a body', async () => {
    vi.stubGlobal('fetch', async () => new Response(null, { status: 204 }));
    const browser = make(fakeChromium());
    const res = await browser.fetch('https://exodus.test/x', { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    await browser.close();
  });

  it('gives up when the caller signal times out', async () => {
    vi.stubGlobal('fetch', () => new Promise<Response>(() => {}));
    const browser = make(fakeChromium());
    await expect(
      browser.fetch('https://exodus.test/slow', { signal: AbortSignal.timeout(20) }),
    ).rejects.toMatchObject({
      name: 'TimeoutError',
    });
    await browser.close();
  });

  it('turns a failed fetch in the tab into a TypeError like Node fetch', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const browser = make(fakeChromium());
    await expect(browser.fetch('https://exodus.test/x')).rejects.toThrow(
      /fetch failed in Chromium: Failed to fetch/,
    );
    await browser.close();
  });

  it('reports a browser that cannot start, and tries again on the next request', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const chromium = fakeChromium({ failLaunch: 1 });
    const browser = make(chromium);

    const error = await browser.fetch('https://exodus.test/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StockbitMcpError);
    expect(error).toMatchObject({
      code: 'BROWSER_UNAVAILABLE',
      message:
        "Could not start Chromium: browserType.launch: Executable doesn't exist at /nowhere/chrome",
    });
    expect((error as StockbitMcpError).hint).toMatch(/npx playwright-core@[\d.]+ install chromium/);

    expect((await browser.fetch('https://exodus.test/x')).status).toBe(200);
    expect(chromium.state.launches).toBe(1);
    await browser.close();
  });

  it('starts a new browser after the window was closed', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const chromium = fakeChromium();
    const browser = make(chromium);
    await browser.fetch('https://exodus.test/x');
    chromium.disconnect();
    await browser.fetch('https://exodus.test/x');
    expect(chromium.state.launches).toBe(2);
    expect(chromium.state.gotos).toEqual(['https://exodus.test/', 'https://exodus.test/']);
    await browser.close();
  });

  it('closes the browser after the idle time', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const chromium = fakeChromium();
    const browser = make(chromium, 10);
    await browser.fetch('https://exodus.test/x');
    await new Promise((r) => setTimeout(r, 40));
    expect(chromium.state.closes).toBe(1);
    await browser.fetch('https://exodus.test/x');
    expect(chromium.state.launches).toBe(2);
    await browser.close();
  });

  it('keeps one browser across requests that come within the idle time', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const chromium = fakeChromium();
    const browser = make(chromium, 50);
    await browser.fetch('https://exodus.test/x');
    await new Promise((r) => setTimeout(r, 10));
    await browser.fetch('https://exodus.test/y');
    expect(chromium.state.launches).toBe(1);
    expect(chromium.state.closes).toBe(0);
    await browser.close();
  });

  it('never closes by itself with an infinite idle time', async () => {
    vi.stubGlobal('fetch', async () => new Response('{}'));
    const chromium = fakeChromium();
    const browser = make(chromium, Number.POSITIVE_INFINITY);
    await browser.fetch('https://exodus.test/x');
    await new Promise((r) => setTimeout(r, 20));
    expect(chromium.state.closes).toBe(0);
    await browser.close();
    expect(chromium.state.closes).toBe(1);
  });

  it('lets StockbitHttp keep its error from a browser that cannot start', async () => {
    const browser = make(fakeChromium({ failLaunch: 1 }));
    const http = new StockbitHttp({
      bases: {
        exodus: 'https://exodus.test',
        carina: 'https://carina.test',
        sekuritas: 'https://sekuritas.test',
      },
      tokens: { token: async () => 'tok', refresh: async () => false },
      logger: createLogger('silent'),
      timeoutMs: 1000,
      fetch: browser.fetch,
    });
    await expect(http.request({ path: '/x' })).rejects.toMatchObject({
      code: 'BROWSER_UNAVAILABLE',
    });
  });
});

describe('browser config', () => {
  it('sends requests through a visible, minimized Chromium by default', () => {
    const config = loadConfig({});
    expect(config.http).toBe('browser');
    expect(config.browser).toEqual({ headless: false, window: 'minimized', idleMs: 2000 });
  });

  it('reads the browser variables', () => {
    const config = loadConfig({
      STOCKBIT_MCP_HTTP: 'node',
      STOCKBIT_MCP_BROWSER_HEADLESS: 'true',
      STOCKBIT_MCP_BROWSER_WINDOW: 'normal',
      STOCKBIT_MCP_BROWSER_IDLE_MS: '0',
      STOCKBIT_MCP_BROWSER_PATH: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    expect(config.http).toBe('node');
    expect(config.browser).toEqual({
      headless: true,
      window: 'normal',
      idleMs: 0,
      executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    });
    expect(loadConfig({ STOCKBIT_MCP_BROWSER_HEADLESS: '0' }).browser.headless).toBe(false);
    expect(() => loadConfig({ STOCKBIT_MCP_BROWSER_HEADLESS: 'yes' })).toThrow(
      /STOCKBIT_MCP_BROWSER_HEADLESS/,
    );
  });
});
