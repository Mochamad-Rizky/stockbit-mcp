#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { passwordLogin, tokenLogin, tradingLogin } from './cli/login.js';
import { AuthService } from './core/auth.js';
import { BrowserFetch } from './core/browser.js';
import { loadConfig } from './core/config.js';
import { isStockbitMcpError } from './core/errors.js';
import { createLogger } from './core/logger.js';
import { createFileSessionStore } from './core/session-store.js';
import { createServer } from './server.js';
import { allTools } from './tools/index.js';
import { VERSION } from './version.js';

const HELP = `stockbit-mcp ${VERSION}: MCP server for Stockbit (IDX)

Usage:
  stockbit-mcp [serve]          Run the MCP server over stdio (what MCP clients start)
  stockbit-mcp login            Log in with username and password
  stockbit-mcp login --token    Save tokens copied from a logged-in browser
  stockbit-mcp login --trading  Open the trading session with the PIN (for account_* tools)
  stockbit-mcp logout [--trading]
  stockbit-mcp status           Show the login state (never the tokens)
  stockbit-mcp tools            List the tools

Requests go through Chromium (Stockbit's Cloudflare blocks other clients). Its windows open
minimized in the background (STOCKBIT_MCP_BROWSER_WINDOW), and it closes 2 s after the last request
(STOCKBIT_MCP_BROWSER_IDLE_MS).

Environment: STOCKBIT_MCP_HOME (default ~/.stockbit-mcp), STOCKBIT_MCP_CONFIRM (auto|elicit|token),
STOCKBIT_MCP_MAX_ITEMS, STOCKBIT_MCP_TIMEOUT_MS, STOCKBIT_MCP_LOG_LEVEL,
STOCKBIT_MCP_HTTP (browser|node), STOCKBIT_MCP_BROWSER_PATH, STOCKBIT_MCP_BROWSER_HEADLESS,
STOCKBIT_MCP_BROWSER_WINDOW (minimized|normal), STOCKBIT_MCP_BROWSER_IDLE_MS.`;

async function main(argv: string[]): Promise<number> {
  const [command = 'serve', ...rest] = argv;
  const flags = new Set(rest);
  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const store = createFileSessionStore(config.home);
  // Chromium starts on the first request only, so status, logout and tools never open it.
  // A login polls for the phone approval every 2 s, so it keeps one window until it is done.
  const idleMs = command === 'serve' ? config.browser.idleMs : Number.POSITIVE_INFINITY;
  const browser =
    config.http === 'browser' ? new BrowserFetch({ ...config.browser, idleMs, logger }) : undefined;
  const fetchImpl = browser ? { fetch: browser.fetch } : {};
  const auth = new AuthService({
    store,
    bases: config.bases,
    logger,
    timeoutMs: config.timeoutMs,
    ...fetchImpl,
  });

  switch (command) {
    case 'serve': {
      const { server, tools } = createServer({ config, logger, store, ...fetchImpl });
      await server.connect(new StdioServerTransport());
      logger.info('stockbit-mcp ready', { tools: tools.length, http: config.http });
      // The client went away: take the Chromium window down with the server.
      process.stdin.once('end', () => {
        void (browser?.close() ?? Promise.resolve()).finally(() => process.exit(0));
      });
      return new Promise<number>(() => {});
    }
    case 'login':
      try {
        if (flags.has('--trading')) await tradingLogin(auth);
        else if (flags.has('--token')) await tokenLogin(auth);
        else await passwordLogin(auth);
      } finally {
        await browser?.close();
      }
      return 0;
    case 'logout':
      await auth.logout(flags.has('--trading') ? 'trading' : 'all');
      process.stderr.write(flags.has('--trading') ? 'Trading session removed.\n' : 'Logged out.\n');
      return 0;
    case 'status':
      process.stdout.write(`${JSON.stringify(await auth.status(), null, 2)}\n`);
      return 0;
    case 'tools':
      for (const tool of allTools()) process.stdout.write(`${tool.name}\t${tool.title}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}\n`);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    if (isStockbitMcpError(error)) {
      process.stderr.write(`${error.code}: ${error.message}\n${error.hint ? `${error.hint}\n` : ''}`);
    } else {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    }
    process.exit(1);
  },
);
