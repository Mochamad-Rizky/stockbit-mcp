import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { z } from 'zod';
import type { AuthService } from '../core/auth.js';
import type { Config } from '../core/config.js';
import type { Confirmer } from '../core/confirm.js';
import type { StockbitHttp } from '../core/http.js';
import type { JsonValue } from '../core/json.js';
import type { Logger } from '../core/logger.js';

// The prefix of every tool name, before the first underscore.
export type Domain =
  | 'session'
  | 'market'
  | 'price'
  | 'flow'
  | 'broker'
  | 'foreign'
  | 'company'
  | 'financial'
  | 'ownership'
  | 'corpaction'
  | 'screener'
  | 'stream'
  | 'search'
  | 'watchlist'
  | 'alert'
  | 'account'
  | 'order'
  | 'api';

export interface ToolContext {
  config: Readonly<Config>;
  logger: Logger;
  http: StockbitHttp;
  auth: AuthService;
  confirmer: Confirmer;
}

export interface ToolOutput<T extends JsonValue> {
  data: T;
  // The Stockbit path (and query) the data came from.
  source?: string;
  warnings?: string[];
}

export interface ToolDefinition<S extends z.ZodRawShape, T extends JsonValue> {
  // snake_case, starting with the domain and an underscore.
  name: string;
  domain: Domain;
  title: string;
  // For the model: when to use the tool, what it returns, its units and its limits.
  description: string;
  // Every field carries a .describe() text.
  inputSchema: S;
  annotations: ToolAnnotations;
  handler(input: z.output<z.ZodObject<S>>, ctx: ToolContext): Promise<ToolOutput<T>>;
}

export function defineTool<S extends z.ZodRawShape, T extends JsonValue>(
  def: ToolDefinition<S, T>,
): ToolDefinition<S, T> {
  return def;
}

export type AnyToolDefinition = ToolDefinition<z.ZodRawShape, JsonValue>;
