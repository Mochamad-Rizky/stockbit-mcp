import type { z } from 'zod';
import { buildRequest, endpoint, shapeFor } from '../catalog/index.js';
import type { JsonValue } from '../core/json.js';
import { READ_ONLY } from './annotations.js';
import { call } from './common.js';
import type { AnyToolDefinition, Domain } from './types.js';

export interface EndpointToolConfig {
  // The catalog id of the endpoint.
  id: string;
  name: string;
  domain: Domain;
  title: string;
  // What it is for, in a sentence or two, for the model.
  summary: string;
  // Units, caveats, how it relates to other tools.
  notes?: string;
  omit?: string[];
  override?: Record<string, z.ZodType>;
  // Inputs of the tool's own, which `prepare` maps onto the endpoint's parameters.
  extra?: z.ZodRawShape;
  // Fills or rewrites inputs before the request is built.
  prepare?: (input: Record<string, unknown>) => Record<string, unknown>;
  // Reshapes Stockbit's data before it is returned (keep it light: the model reads raw data well).
  shape?: (data: JsonValue) => JsonValue;
}

const RESPONSE_LIMIT = 700;

// Ticker-like inputs are sent upper case, as the app does.
const TICKER_KEYS = /^(symbol|symbols|stock_code|company|emiten|ticker)$/;

function upperTickers(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  for (const [key, value] of Object.entries(out)) {
    if (!TICKER_KEYS.test(key)) continue;
    if (typeof value === 'string') out[key] = value.trim().toUpperCase();
    if (Array.isArray(value)) out[key] = value.map((v) => (typeof v === 'string' ? v.trim().toUpperCase() : v));
  }
  return out;
}

export function endpointTool(cfg: EndpointToolConfig): AnyToolDefinition {
  const spec = endpoint(cfg.id);
  if (spec.method !== 'GET' || spec.destructive) {
    throw new Error(`${cfg.name}: endpointTool only wraps reads, ${cfg.id} is ${spec.method}`);
  }
  const response =
    spec.response.length > RESPONSE_LIMIT ? `${spec.response.slice(0, RESPONSE_LIMIT)}…` : spec.response;
  const description = [
    cfg.summary,
    cfg.notes,
    response ? `Returns (Stockbit's data field): ${response}` : undefined,
    spec.paywall ? `Paywall: ${spec.paywall}.` : undefined,
    `Endpoint: ${spec.method} ${spec.host} ${spec.path}.`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return {
    name: cfg.name,
    domain: cfg.domain,
    title: cfg.title,
    description,
    inputSchema: {
      ...shapeFor(spec, {
        ...(cfg.omit ? { omit: cfg.omit } : {}),
        ...(cfg.override ? { override: cfg.override } : {}),
      }),
      ...cfg.extra,
    },
    annotations: READ_ONLY,
    async handler(input, ctx) {
      const prepared = upperTickers(cfg.prepare ? cfg.prepare(input) : input);
      const req = buildRequest(spec, prepared);
      const out = await call(ctx, { host: req.host, method: req.method, path: req.path, query: req.query });
      return cfg.shape ? { ...out, data: cfg.shape(out.data) } : out;
    },
  };
}
