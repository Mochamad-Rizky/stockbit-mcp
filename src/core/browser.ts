import { createRequire } from 'node:module';
import type { Browser, BrowserContext, CDPSession, LaunchOptions, Page } from 'playwright-core';
import { StockbitMcpError } from './errors.js';
import type { Logger } from './logger.js';

// Stockbit's Cloudflare answers 403 to Node's fetch and to headless Chromium, and lets a visible
// Chromium through (seen 2026-10-28). BrowserFetch is a drop-in `fetch` that sends each request
// from a Chromium tab, so it leaves with the browser's own network stack. The tab sits on the
// target origin itself: the request is same-origin and its custom headers need no CORS preflight.

export interface BrowserFetchOptions {
  headless: boolean;
  // 'minimized' opens each window in the background and minimizes it at once, so a visible
  // Chromium takes neither the screen nor the keyboard focus; 'normal' shows it.
  window: 'minimized' | 'normal';
  // Chrome, Chromium or another Chromium-based browser; Playwright's own Chromium when unset.
  executablePath?: string;
  logger: Logger;
  // The browser closes once no request has been in flight for this long, and starts again on the
  // next one. Infinity keeps it open until close().
  idleMs: number;
  // Starts the browser; replaced in tests.
  launch?: (options: LaunchOptions) => Promise<Browser>;
}

interface Running {
  browser: Browser;
  context: BrowserContext;
  // Set when windows open minimized: the browser-level CDP session and the context's CDP id.
  hidden?: { cdp: CDPSession; contextId: string };
}

interface PageRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface PageAnswer {
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
  body: string;
}

// Statuses a Response may not carry a body with.
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

const PLAYWRIGHT_VERSION = (
  createRequire(import.meta.url)('playwright-core/package.json') as { version: string }
).version;

export const BROWSER_HINT =
  `Install the Chromium that stockbit-mcp drives with \`npx playwright-core@${PLAYWRIGHT_VERSION} install chromium\`, ` +
  'or point STOCKBIT_MCP_BROWSER_PATH at Chrome or Chromium.';

// Runs inside the tab: Playwright serializes it, so it may use nothing from this module.
async function fetchInPage(req: PageRequest): Promise<PageAnswer> {
  const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body });
  const headers: Array<[string, string]> = [];
  res.headers.forEach((value, key) => headers.push([key, value]));
  return { status: res.status, statusText: res.statusText, headers, body: await res.text() };
}

export class BrowserFetch {
  readonly fetch = ((input: string | URL | Request, init?: RequestInit) =>
    this.request(input, init)) as typeof fetch;

  private running: Promise<Running> | undefined;
  // One tab per origin (exodus, carina, sekuritas), reused by every request to it.
  private readonly pages = new Map<string, Promise<Page>>();
  private active = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  private opening: Promise<unknown> = Promise.resolve();

  constructor(private readonly options: BrowserFetchOptions) {}

  async close(): Promise<void> {
    clearTimeout(this.idleTimer);
    const running = this.running;
    this.running = undefined;
    this.pages.clear();
    if (running) {
      await running.then((r) => r.browser.close()).catch(() => {});
      this.options.logger.debug('chromium closed');
    }
  }

  private async request(input: string | URL | Request, init: RequestInit = {}): Promise<Response> {
    const url = new URL(input instanceof Request ? input.url : input);
    if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') {
      throw new TypeError('BrowserFetch sends string bodies only.');
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const req: PageRequest = {
      url: url.href,
      method: init.method ?? 'GET',
      headers,
      body: init.body ?? null,
    };

    clearTimeout(this.idleTimer);
    this.active++;
    try {
      const answer = await abortable(
        this.pageFor(url.origin).then((page) => page.evaluate(fetchInPage, req)),
        init.signal ?? undefined,
      );
      return new Response(NULL_BODY.has(answer.status) ? null : answer.body, {
        status: answer.status,
        statusText: answer.statusText,
        headers: answer.headers,
      });
    } catch (error) {
      if (
        error instanceof StockbitMcpError ||
        (error as Error).name === 'TimeoutError' ||
        (error as Error).name === 'AbortError'
      ) {
        throw error;
      }
      throw new TypeError(`fetch failed in Chromium: ${firstLine(error)}`, { cause: error });
    } finally {
      this.active--;
      if (this.active === 0 && Number.isFinite(this.options.idleMs)) {
        this.idleTimer = setTimeout(() => void this.close(), this.options.idleMs);
        this.idleTimer.unref();
      }
    }
  }

  private pageFor(origin: string): Promise<Page> {
    const known = this.pages.get(origin);
    if (known) {
      return known;
    }
    const page = this.openPage(origin);
    this.pages.set(origin, page);
    const forget = () => {
      if (this.pages.get(origin) === page) {
        this.pages.delete(origin);
      }
    };
    page.then((p) => p.on('close', forget), forget);
    return page;
  }

  private async openPage(origin: string): Promise<Page> {
    const { context, hidden } = await this.start();
    const page = hidden ? await this.openHidden(context, hidden) : await context.newPage();
    // Whatever the API answers at its root (usually a 404 JSON) is fine: only the origin matters.
    await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
    return page;
  }

  // Playwright's newPage brings Chromium to the front and takes the keyboard focus (macOS,
  // 2026-10-28). A window made over CDP in the background takes neither; Target.createTarget's
  // windowState is ignored, so it is minimized right after. Playwright picks the new target up as
  // a page of the context.
  private openHidden(context: BrowserContext, { cdp, contextId }: NonNullable<Running['hidden']>) {
    // One window at a time, so that the 'page' event awaited is the one of the window just made.
    const job = this.opening.then(async () => {
      const page = context.waitForEvent('page');
      page.catch(() => {});
      const { targetId } = await cdp.send('Target.createTarget', {
        url: 'about:blank',
        browserContextId: contextId,
        newWindow: true,
        background: true,
      });
      const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      return page;
    });
    this.opening = job.catch(() => {});
    return job;
  }

  private start(): Promise<Running> {
    if (this.running) {
      return this.running;
    }
    const running = this.launch();
    this.running = running;
    running.then(
      ({ browser }) =>
        browser.on('disconnected', () => {
          // The user closed the window, or Chromium died: the next request starts a new one.
          if (this.running === running) {
            this.running = undefined;
            this.pages.clear();
          }
        }),
      () => {
        if (this.running === running) {
          this.running = undefined;
        }
      },
    );
    return running;
  }

  private async launch(): Promise<Running> {
    const launch =
      this.options.launch ??
      (async (o: LaunchOptions) => (await import('playwright-core')).chromium.launch(o));
    const { headless, executablePath } = this.options;
    let browser: Browser;
    try {
      browser = await launch({ headless, ...(executablePath ? { executablePath } : {}) });
    } catch (error) {
      throw new StockbitMcpError(
        'BROWSER_UNAVAILABLE',
        `Could not start Chromium: ${firstLine(error)}`,
        {
          hint: BROWSER_HINT,
          cause: error,
        },
      );
    }
    this.options.logger.info('chromium started', {
      headless,
      window: this.options.window,
      ...(executablePath ? { executablePath } : {}),
    });
    if (headless || this.options.window === 'normal') {
      return { browser, context: await browser.newContext() };
    }
    const cdp = await browser.newBrowserCDPSession();
    const before = new Set((await cdp.send('Target.getBrowserContexts')).browserContextIds);
    const context = await browser.newContext();
    const contextId = (await cdp.send('Target.getBrowserContexts')).browserContextIds.find(
      (id) => !before.has(id),
    );
    if (!contextId) {
      await browser.close();
      throw new StockbitMcpError('INTERNAL', 'Could not find the Chromium context over CDP.');
    }
    return { browser, context, hidden: { cdp, contextId } };
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(signal.reason as Error);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

// Playwright errors carry a framed log after the first line.
function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split('\n')[0]?.trim() ?? message;
}
