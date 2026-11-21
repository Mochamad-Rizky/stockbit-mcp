// Builds src/catalog/endpoints.json from the reverse-engineering notes of the Stockbit desktop app
// 2.7.4 (see docs/reverse-engineering.md), plus scripts/catalog-additions.json: endpoints first
// found in 2.9.0, already in catalog form. The notes are kept outside the repository because the
// captures they came from hold personal data; the catalog keeps only paths, parameter names, enum
// literals and descriptions.
//
// node scripts/build-catalog.mjs <research-dir> <static-catalog.json>
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [researchDir, staticCatalogPath] = process.argv.slice(2);
if (!researchDir || !staticCatalogPath) {
  console.error('usage: node scripts/build-catalog.mjs <research-dir> <static-catalog.json>');
  process.exit(2);
}

// The app version the catalog (and the X-AppVersion header) follows.
const APP_VERSION = '2.9.0';

const HOSTS = {
  'exodus.stockbit.com': 'exodus',
  'carina.stockbit.com': 'carina',
  'api-sekuritas.stockbit.com': 'sekuritas',
  exodus: 'exodus',
  carina: 'carina',
  'api-sekuritas': 'sekuritas',
};

// Paths reached only through login, device or registration flows, or that hand out credentials.
// api_get must never call them, and listing them would only invite it.
const PRIVATE_PREFIX =
  /^\/(login|logout|auth|mfa|sekuritas\/auth|partner|registration|dev|user\/credential|v2\/registration)(\/|$)/;

// Strings in the chartbit module that look like paths but are only labels of its error reports.
const NOT_PATHS = new Set([
  '/chartbit/daily-price',
  '/chartbit/intraday',
  '/chartbit/quotes',
  '/chartbit/corp-action-events',
  '/chartbit/emiten-info',
  '/chartbit/search',
]);

function normType(raw, hasEnum) {
  const t = String(raw ?? 'string');
  if (/^array<enum>$/.test(t)) return hasEnum ? 'enum[]' : 'string[]';
  if (/^(array<string>|string\[\]|string\|string\[\])$/.test(t)) return 'string[]';
  if (/^(integer|int)/.test(t) || t === 'string(int)') return 'integer';
  if (/^number/.test(t)) return 'number';
  if (t === 'boolean') return 'boolean';
  if (t === 'string(YYYY-MM-DD)') return 'date';
  if (t === 'enum') return hasEnum ? 'enum' : 'string';
  if (t === 'object') return 'object';
  return 'string';
}

function unitOf(raw) {
  const m = /\(([^)]+)\)/.exec(String(raw ?? ''));
  return m && m[1] !== 'YYYY-MM-DD' && m[1] !== 'int' ? m[1] : undefined;
}

function normParam(p) {
  if (typeof p === 'string') {
    return { name: p, type: 'string', required: true };
  }
  const enumValues = Array.isArray(p.enum) && p.enum.length > 0 ? p.enum.map(String) : undefined;
  const out = {
    name: p.name,
    type: normType(p.type, Boolean(enumValues)),
    required: Boolean(p.required),
  };
  if (enumValues) out.enum = enumValues;
  if (p.default !== undefined && p.default !== null) out.default = p.default;
  const unit = unitOf(p.type);
  const description = [p.description, unit ? `Unit: ${unit}.` : ''].filter(Boolean).join(' ');
  if (description) out.description = description;
  return out;
}

function toTemplate(path) {
  return path.replace(/\$\{([^}]+)\}/g, (_, name) => `{${String(name).split('.').pop()}}`);
}

function load(name) {
  return JSON.parse(readFileSync(join(researchDir, name), 'utf8'));
}

const sources = [
  ['market', load('market-flow.json')],
  ['fundamental', load('fundamental.json')],
  ['trading', load('trading.json')],
];

// Two notes may name the same endpoint with different placeholder names ({symbol}, {cleanupSymbol}).
const keyOf = (method, host, path) => `${method} ${host} ${path.replace(/\{[^}]+\}/g, '{}')}`;
const weight = (e) => e.query.length + (e.body?.length ?? 0) + (e.bodySchema ? 5 : 0) + e.response.length / 1000;

const endpoints = new Map();
for (const [source, list] of sources) {
  for (const e of list) {
    // Brokerage writes (orders, transfers) are not part of this server, so the catalog leaves them out.
    if (source === 'trading' && e.method !== 'GET') continue;
    const host = HOSTS[e.host ?? 'exodus.stockbit.com'] ?? 'exodus';
    const path = toTemplate(e.path.startsWith('/') ? e.path : `/${e.path}`);
    const key = keyOf(e.method, host, path);
    const pathParams = (e.path_params ?? []).map((p) => ({ ...normParam(p), required: true }));
    const entry = {
      id: e.id,
      method: e.method,
      host,
      path,
      group: e.group ?? source,
      documented: true,
      destructive: Boolean(e.destructive),
      pathParams,
      query: (e.query ?? []).map(normParam),
      ...(Array.isArray(e.body) && e.body.length > 0 ? { body: e.body.map(normParam) } : {}),
      // Nested bodies (screener rules, alert conditions) stay in the notes' JSON-schema-like form.
      ...(e.body && !Array.isArray(e.body) && typeof e.body === 'object' ? { bodySchema: e.body } : {}),
      feature: e.feature ?? '',
      response: e.response_summary ?? '',
      ...(e.paywall && e.paywall !== 'no' ? { paywall: String(e.paywall) } : {}),
      seenInHar: Boolean(e.seen_in_har),
    };
    // Keep the better documented of two notes on the same endpoint.
    const previous = endpoints.get(key);
    if (!previous || weight(entry) > weight(previous)) {
      endpoints.set(key, entry);
    }
  }
}

// Calls found in the bundles that the notes do not document: listed with their path only, so that
// api_get can still reach them with a free-form query.
const known = new Set([...endpoints.values()].map((e) => keyOf(e.method, e.host, e.path)));
const ids = new Set([...endpoints.values()].map((e) => e.id));
for (const c of JSON.parse(readFileSync(staticCatalogPath, 'utf8'))) {
  const method = String(c.verb).replace('?', '');
  const host = HOSTS[c.host] ?? 'exodus';
  const path = toTemplate(c.path);
  if (method !== 'GET' || NOT_PATHS.has(path) || PRIVATE_PREFIX.test(path)) continue;
  const key = keyOf(method, host, path);
  if (known.has(key)) continue;
  let id = `get_${path.replace(/\{[^}]+\}/g, 'by').replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '').toLowerCase()}`;
  while (ids.has(id)) id = `${id}_2`;
  ids.add(id);
  known.add(key);
  const pathParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({ name: m[1], type: 'string', required: true }));
  endpoints.set(key, {
    id,
    method,
    host,
    path,
    group: path.split('/')[1] ?? 'other',
    documented: false,
    destructive: false,
    pathParams,
    query: [],
    feature: `Seen in ${c.source}; parameters not documented.`,
    response: '',
    seenInHar: false,
  });
}

// Endpoints found in the 2.9.0 app (see docs/reverse-engineering.md), written in catalog form. The
// notes win where they already document the same endpoint.
const additions = JSON.parse(readFileSync(new URL('./catalog-additions.json', import.meta.url), 'utf8'));
for (const e of additions) {
  const key = keyOf(e.method, e.host, e.path);
  if (known.has(key) || endpoints.has(key)) continue;
  if (ids.has(e.id)) throw new Error(`catalog-additions.json: duplicate id ${e.id}`);
  ids.add(e.id);
  known.add(key);
  endpoints.set(key, e);
}

// Changes the newer app made to endpoints already documented (see docs/reverse-engineering.md):
// query parameters it added, and a replacement feature/response text where given.
const updates = JSON.parse(readFileSync(new URL('./catalog-updates.json', import.meta.url), 'utf8'));
for (const u of updates) {
  const e = [...endpoints.values()].find((x) => x.id === u.id);
  if (!e) throw new Error(`catalog-updates.json: unknown id ${u.id}`);
  for (const q of u.query ?? []) {
    if (!e.query.some((p) => p.name === q.name)) e.query.push(q);
  }
  if (u.feature) e.feature = u.feature;
  if (u.response) e.response = u.response;
}

const list = [...endpoints.values()]
  .filter((e) => !PRIVATE_PREFIX.test(e.path))
  .sort((a, b) => a.group.localeCompare(b.group) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method));

// Long digit runs in descriptions are example ids from captures (order or exchange numbers): mask
// them so no captured identifier ends up in the repository.
const text = JSON.stringify({ appVersion: APP_VERSION, endpoints: list }, null, 1).replace(
  /\b\d{12,}\b/g,
  '<number>',
);
writeFileSync(new URL('../src/catalog/endpoints.json', import.meta.url), `${text}\n`);
const counts = list.reduce((acc, e) => {
  const k = `${e.method === 'GET' ? 'read' : 'write'}:${e.documented ? 'documented' : 'path-only'}`;
  acc[k] = (acc[k] ?? 0) + 1;
  return acc;
}, {});
console.log(list.length, counts);
