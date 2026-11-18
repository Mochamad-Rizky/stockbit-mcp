import type { RequestOptions } from '../../../src/core/http.js';
import type { JsonValue } from '../../../src/core/json.js';

// A stand-in for StockbitHttp: answers by path (without query), records calls.
export function fakeHttp(routes: Record<string, JsonValue | ((req: RequestOptions) => JsonValue)>) {
  const calls: RequestOptions[] = [];
  return {
    calls,
    async request(req: RequestOptions) {
      calls.push(req);
      const key = req.path.split('?')[0]!.replace(/^\/?/, '/');
      const route = routes[key];
      if (route === undefined) throw Object.assign(new Error(`not mocked: ${key}`), { code: 'NOT_FOUND' });
      const body = typeof route === 'function' ? route(req) : route;
      return { status: 200, body, source: key };
    },
  };
}
