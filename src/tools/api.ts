import { z } from 'zod';
import { buildRequest, ENDPOINTS, findEndpoint, inputName, summarize } from '../catalog/index.js';
import { StockbitMcpError } from '../core/errors.js';
import type { JsonValue } from '../core/json.js';
import { READ_ONLY } from './annotations.js';
import { call } from './common.js';
import { defineTool, type AnyToolDefinition, type ToolOutput } from './types.js';

// Two tools that open the whole catalog: every GET the desktop app makes is reachable, also those
// without a dedicated tool. Writes stay behind their own tools (and orders behind confirmation).

const apiCatalog = defineTool({
  name: 'api_catalog',
  domain: 'api',
  title: 'Search the Stockbit endpoint catalog',
  description:
    'Lists Stockbit endpoints the desktop app uses, with their parameters, allowed values and what ' +
    'they return. Use it to find an endpoint for api_get when no dedicated tool fits, or to look up ' +
    'the exact enum values a dedicated tool accepts. Filters combine; with none, it lists groups ' +
    'and counts only.',
  inputSchema: {
    query: z
      .string()
      .min(2)
      .optional()
      .describe('Words matched against id, path, group and feature (all must match), e.g. "broker summary".'),
    group: z.string().optional().describe('Exact group, e.g. market, emitten, insider, screener, trading.'),
    include_writes: z
      .boolean()
      .optional()
      .describe('Also list endpoints that change something (for reference; api_get only reads).'),
    limit: z.number().int().min(1).max(50).optional().describe('Max endpoints to return, default 20.'),
  },
  annotations: { ...READ_ONLY, openWorldHint: false },
  async handler({ query, group, include_writes, limit }): Promise<ToolOutput<JsonValue>> {
    const words = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const pool = ENDPOINTS.filter((e) => include_writes || e.method === 'GET');
    if (words.length === 0 && !group) {
      const groups: Record<string, number> = {};
      for (const e of pool) groups[e.group] = (groups[e.group] ?? 0) + 1;
      return { data: { total: pool.length, groups } };
    }
    const hits = pool.filter((e) => {
      if (group && e.group !== group) return false;
      const hay = `${e.id} ${e.path} ${e.group} ${e.feature}`.toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    const max = limit ?? 20;
    return {
      data: {
        total: hits.length,
        endpoints: hits.slice(0, max).map(summarize) as unknown as JsonValue,
      },
      ...(hits.length > max ? { warnings: [`${hits.length - max} more match; narrow the query.`] } : {}),
    };
  },
});

const scalar = z.union([z.string(), z.number(), z.boolean()]);

const apiGet = defineTool({
  name: 'api_get',
  domain: 'api',
  title: 'Call any Stockbit read endpoint',
  description:
    'Calls one GET endpoint from api_catalog by its id. Path parameters fill the {placeholders}; ' +
    'query parameters use the names api_catalog lists (for documented endpoints, unknown names are ' +
    'refused). Returns Stockbit\'s data field. Prefer a dedicated tool when one exists.',
  inputSchema: {
    endpoint_id: z.string().min(1).describe('The id from api_catalog, e.g. get_broker_summary_v2.'),
    path_params: z.record(z.string(), scalar).optional().describe('Values for the {placeholders} in the path.'),
    query: z
      .record(z.string(), z.union([scalar, z.array(scalar)]))
      .optional()
      .describe('Query parameters; a list sends the key once per item.'),
  },
  annotations: READ_ONLY,
  async handler({ endpoint_id, path_params, query }, ctx) {
    const spec = findEndpoint(endpoint_id);
    if (!spec) {
      throw new StockbitMcpError('NOT_FOUND', `No endpoint ${endpoint_id} in the catalog.`, {
        hint: 'Look it up with api_catalog.',
      });
    }
    if (spec.method !== 'GET' || spec.destructive) {
      throw new StockbitMcpError('INVALID_INPUT', `${endpoint_id} is a ${spec.method}; api_get only reads.`);
    }
    const input: Record<string, unknown> = { ...path_params };
    if (spec.documented) {
      const known = new Set(spec.query.map((p) => inputName(p.name)));
      const unknown = Object.keys(query ?? {}).filter((k) => !known.has(k));
      if (unknown.length > 0) {
        throw new StockbitMcpError('INVALID_INPUT', `Unknown query parameters: ${unknown.join(', ')}.`, {
          details: { allowed: [...known] },
        });
      }
      Object.assign(input, query);
      const req = buildRequest(spec, input);
      return call(ctx, { host: req.host, path: req.path, query: req.query });
    }
    // Undocumented: the path is filled, the query goes as given.
    const req = buildRequest({ ...spec, query: [] }, input);
    return call(ctx, { host: req.host, path: req.path, ...(query ? { query } : {}) });
  },
});

export const apiTools: AnyToolDefinition[] = [apiCatalog, apiGet] as AnyToolDefinition[];
