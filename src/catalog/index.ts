import { z } from 'zod';
import { StockbitMcpError } from '../core/errors.js';
import type { Host, HttpMethod, QueryValue } from '../core/http.js';
import catalog from './endpoints.json' with { type: 'json' };

// The Stockbit endpoints the desktop app calls, as scripts/build-catalog.mjs wrote them from the
// reverse-engineering notes of 2.7.4 and the 2.9.0 additions (scripts/catalog-additions.json).
// `documented` endpoints list their parameters; the others only their path.

export type ParamType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'enum'
  | 'string[]'
  | 'enum[]'
  | 'object';

export interface ParamSpec {
  name: string;
  type: ParamType;
  required: boolean;
  enum?: string[];
  default?: unknown;
  description?: string;
}

export interface EndpointSpec {
  id: string;
  method: HttpMethod;
  host: Host;
  path: string;
  group: string;
  documented: boolean;
  destructive: boolean;
  pathParams: ParamSpec[];
  query: ParamSpec[];
  body?: ParamSpec[];
  feature: string;
  response: string;
  paywall?: string;
  seenInHar: boolean;
}

export const ENDPOINTS: readonly EndpointSpec[] = (catalog as { endpoints: EndpointSpec[] }).endpoints;
export const CATALOG_APP_VERSION: string = (catalog as { appVersion: string }).appVersion;

const BY_ID = new Map(ENDPOINTS.map((e) => [e.id, e]));

export function endpoint(id: string): EndpointSpec {
  const spec = BY_ID.get(id);
  if (!spec) {
    // A tool that names an id the catalog lacks is a bug, caught by the unit tests.
    throw new Error(`Unknown catalog endpoint: ${id}`);
  }
  return spec;
}

export function findEndpoint(id: string): EndpointSpec | undefined {
  return BY_ID.get(id);
}

// Query keys such as `time_range.start` or `symbol[i]` are not valid tool argument names.
export function inputName(name: string): string {
  return name.replace(/\[[^\]]*\]/g, '').replace(/[^A-Za-z0-9_]/g, '_');
}

function usableParam(p: ParamSpec): boolean {
  return /^[A-Za-z]/.test(p.name);
}

function describe(p: ParamSpec): string {
  const parts = [p.description?.trim() || p.name];
  if (p.default !== undefined) {
    parts.push(`Default ${JSON.stringify(p.default)}.`);
  }
  return parts.join(' ');
}

function zodFor(p: ParamSpec): z.ZodType {
  switch (p.type) {
    case 'integer':
      return z.number().int();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'date':
      return z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
    case 'enum':
      return p.enum && p.enum.length > 0 ? z.enum(p.enum as [string, ...string[]]) : z.string();
    case 'string[]':
      return z.array(z.string().min(1)).min(1);
    case 'enum[]':
      return z
        .array(p.enum && p.enum.length > 0 ? z.enum(p.enum as [string, ...string[]]) : z.string())
        .min(1);
    case 'object':
      return z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
    default:
      return z.string().min(1);
  }
}

// Defaults the app sends are applied when the caller leaves a parameter out, so a bare call behaves
// like opening the screen in the app. Only scalar defaults that fit the type are used.
function defaultFor(p: ParamSpec): QueryValue | undefined {
  const d = p.default;
  if (d === undefined || d === null) return undefined;
  if (p.type === 'enum') return typeof d === 'string' && p.enum?.includes(d) ? d : undefined;
  if (p.type === 'integer' || p.type === 'number') return typeof d === 'number' ? d : undefined;
  if (p.type === 'boolean') return typeof d === 'boolean' ? d : undefined;
  if (p.type === 'enum[]' || p.type === 'string[]') {
    const ok =
      Array.isArray(d) &&
      d.length > 0 &&
      d.every((v) => typeof v === 'string' && (p.type === 'string[]' || p.enum?.includes(v)));
    return ok ? (d as string[]) : undefined;
  }
  return undefined;
}

export interface ShapeOptions {
  // Inputs to leave out of the shape (the tool sets them itself).
  omit?: string[];
  // Replacement schemas for some inputs, by input name.
  override?: Record<string, z.ZodType>;
}

// The tool input shape for an endpoint: path parameters (required) then query parameters.
export function shapeFor(spec: EndpointSpec, options: ShapeOptions = {}): z.ZodRawShape {
  const shape: Record<string, z.ZodType> = {};
  const omit = new Set(options.omit ?? []);
  for (const p of spec.pathParams.filter(usableParam)) {
    const key = inputName(p.name);
    if (omit.has(key)) continue;
    shape[key] = (options.override?.[key] ?? zodFor(p)).describe(describe(p));
  }
  for (const p of spec.query.filter(usableParam)) {
    const key = inputName(p.name);
    if (omit.has(key) || key in shape) continue;
    const base = options.override?.[key] ?? zodFor(p);
    const optional = !p.required || defaultFor(p) !== undefined;
    shape[key] = (optional ? base.optional() : base).describe(describe(p));
  }
  return shape;
}

export interface BuiltRequest {
  host: Host;
  method: HttpMethod;
  path: string;
  query: Record<string, QueryValue>;
}

function scalar(value: unknown): QueryValue {
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'object' ? JSON.stringify(v) : (v as string | number | boolean)));
  }
  if (value !== null && typeof value === 'object') {
    return JSON.stringify(value);
  }
  return value as QueryValue;
}

// A custom date range and a preset (period=LAST_7_DAYS, timeframe=1y …) are alternatives: Stockbit
// answers the preset when both are sent (broker summary with period=LATEST and from/to=2026-10-07
// gave the latest day, live 2026-10-29). So with a range the preset's default is left out, or
// replaced by its UNSPECIFIED value where the endpoint has one (foreign-domestic historical/summary).
const RANGE_KEYS = new Set(['from', 'to', 'date_from', 'date_to', 'start', 'end']);
const PRESET_KEYS = new Set(['period', 'timeframe']);

// Turns tool input into the request: fills the path template, maps input names back to the query
// keys Stockbit expects and applies the app's defaults.
export function buildRequest(spec: EndpointSpec, input: Record<string, unknown>): BuiltRequest {
  let path = spec.path;
  for (const p of spec.pathParams) {
    const value = input[inputName(p.name)];
    if (value === undefined || value === null || value === '') {
      throw new StockbitMcpError('INVALID_INPUT', `${inputName(p.name)} is required.`);
    }
    path = path.replace(`{${p.name}}`, encodeURIComponent(String(value)));
  }
  if (/\{[^}]+\}/.test(path)) {
    throw new StockbitMcpError('INVALID_INPUT', `Missing path parameters for ${spec.path}.`);
  }
  const query: Record<string, QueryValue> = {};
  const ranged = spec.query.some(
    (p) => RANGE_KEYS.has(p.name) && input[inputName(p.name)] !== undefined,
  );
  for (const p of spec.query.filter(usableParam)) {
    const value = input[inputName(p.name)];
    const chosen =
      value !== undefined
        ? scalar(value)
        : ranged && PRESET_KEYS.has(p.name)
          ? p.enum?.find((v) => v.endsWith('_UNSPECIFIED'))
          : defaultFor(p);
    if (chosen !== undefined) {
      query[p.name] = chosen;
    }
  }
  return { host: spec.host, method: spec.method, path, query };
}

// A short form of the spec for api_catalog: enough to call api_get correctly.
export function summarize(spec: EndpointSpec) {
  const param = (p: ParamSpec) => ({
    name: inputName(p.name),
    type: p.type,
    ...(p.required ? { required: true } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default === undefined ? {} : { default: p.default as string | number | boolean }),
    ...(p.description ? { description: p.description } : {}),
  });
  return {
    id: spec.id,
    method: spec.method,
    host: spec.host,
    path: spec.path,
    group: spec.group,
    documented: spec.documented,
    feature: spec.feature,
    ...(spec.response ? { response: spec.response } : {}),
    ...(spec.paywall ? { paywall: spec.paywall } : {}),
    path_params: spec.pathParams.filter(usableParam).map(param),
    query: spec.query.filter(usableParam).map(param),
  };
}
