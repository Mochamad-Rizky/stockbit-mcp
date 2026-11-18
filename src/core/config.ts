import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { LogLevel } from './logger.js';

export interface Config {
  // Where the session file lives.
  home: string;
  // How a deletion is confirmed: 'elicit' asks the user through the client (a form the client
  // shows), 'token' returns a preview and a one-time token that a second call must bring back,
  // 'auto' uses 'elicit' when the client supports it and 'token' otherwise.
  confirm: 'auto' | 'elicit' | 'token';
  // Whether order_buy and order_sell are offered. Orders always take two popups, whatever `confirm`.
  orders: boolean;
  logLevel: LogLevel;
  // Lists in a result are cut after this many items.
  maxItems: number;
  timeoutMs: number;
  // 'browser' sends every request from a Chromium tab, since Stockbit's Cloudflare blocks other
  // clients; 'node' uses Node's fetch.
  http: 'browser' | 'node';
  browser: {
    // Headless Chromium is blocked by Cloudflare too (2026-10-28); a visible window gets through.
    headless: boolean;
    // 'minimized' keeps the visible Chromium out of the way: its windows open in the background
    // and minimized, without taking the keyboard focus.
    window: 'minimized' | 'normal';
    // Chromium closes this long after the last request. The grace keeps one tool call that makes
    // several requests (a token refresh and retry, a 429 retry) in one window.
    idleMs: number;
    executablePath?: string;
  };
  bases: {
    exodus: string;
    carina: string;
    sekuritas: string;
  };
}

const EnvSchema = z.object({
  STOCKBIT_MCP_HOME: z.string().min(1).optional(),
  STOCKBIT_MCP_CONFIRM: z.enum(['auto', 'elicit', 'token']).default('auto'),
  STOCKBIT_MCP_ORDERS: z
    .enum(['on', 'off'])
    .default('on')
    .transform((v) => v === 'on'),
  STOCKBIT_MCP_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  STOCKBIT_MCP_MAX_ITEMS: z.coerce.number().int().min(10).max(5000).default(200),
  STOCKBIT_MCP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(20_000),
  STOCKBIT_MCP_HTTP: z.enum(['browser', 'node']).default('browser'),
  STOCKBIT_MCP_BROWSER_HEADLESS: z
    .enum(['true', 'false', '1', '0'])
    .default('false')
    .transform((v) => v === 'true' || v === '1'),
  STOCKBIT_MCP_BROWSER_WINDOW: z.enum(['minimized', 'normal']).default('minimized'),
  STOCKBIT_MCP_BROWSER_IDLE_MS: z.coerce.number().int().min(0).max(3_600_000).default(2000),
  STOCKBIT_MCP_BROWSER_PATH: z.string().min(1).optional(),
  STOCKBIT_EXODUS_BASE: z.url().default('https://exodus.stockbit.com'),
  STOCKBIT_CARINA_BASE: z.url().default('https://carina.stockbit.com'),
  STOCKBIT_SEKURITAS_BASE: z.url().default('https://api-sekuritas.stockbit.com'),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid stockbit-mcp environment: ${issues}`);
  }
  const e = parsed.data;
  return {
    home: e.STOCKBIT_MCP_HOME ?? join(homedir(), '.stockbit-mcp'),
    confirm: e.STOCKBIT_MCP_CONFIRM,
    orders: e.STOCKBIT_MCP_ORDERS,
    logLevel: e.STOCKBIT_MCP_LOG_LEVEL,
    maxItems: e.STOCKBIT_MCP_MAX_ITEMS,
    timeoutMs: e.STOCKBIT_MCP_TIMEOUT_MS,
    http: e.STOCKBIT_MCP_HTTP,
    browser: {
      headless: e.STOCKBIT_MCP_BROWSER_HEADLESS,
      window: e.STOCKBIT_MCP_BROWSER_WINDOW,
      idleMs: e.STOCKBIT_MCP_BROWSER_IDLE_MS,
      ...(e.STOCKBIT_MCP_BROWSER_PATH ? { executablePath: e.STOCKBIT_MCP_BROWSER_PATH } : {}),
    },
    bases: {
      exodus: e.STOCKBIT_EXODUS_BASE.replace(/\/+$/, ''),
      carina: e.STOCKBIT_CARINA_BASE.replace(/\/+$/, ''),
      sekuritas: e.STOCKBIT_SEKURITAS_BASE.replace(/\/+$/, ''),
    },
  };
}
