import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ElicitRequestSchema, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/core/config.js';
import { createLogger } from '../../src/core/logger.js';
import { createMemorySessionStore, type Session } from '../../src/core/session-store.js';
import { createServer } from '../../src/server.js';

export interface Recorded {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: unknown;
}

export type Responder = (req: Recorded) => { status?: number; body: unknown } | undefined;

export const LOGGED_IN: Session = {
  version: 1,
  exodus: { access: { token: 'exo-access' }, refresh: { token: 'exo-refresh' }, savedAt: '2026-10-28T00:00:00Z' },
  trading: { access: { token: 'car-access' }, refresh: { token: 'car-refresh' }, savedAt: '2026-10-28T00:00:00Z' },
};

export async function harness(
  respond: Responder,
  options: { session?: Session; elicit?: (message: string) => ElicitResult; env?: Record<string, string> } = {},
) {
  const calls: Recorded[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const req: Recorded = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: (init?.headers as Record<string, string>) ?? {},
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    calls.push(req);
    const answer = respond(req) ?? { status: 404, body: { message: 'not mocked' } };
    return new Response(JSON.stringify(answer.body), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const store = createMemorySessionStore(options.session ?? LOGGED_IN);
  const config = loadConfig({ STOCKBIT_MCP_HOME: '/nonexistent', ...options.env });
  const built = createServer({ config, logger: createLogger('silent'), store, fetch: fetchImpl });

  const client = new Client(
    { name: 'test', version: '0' },
    options.elicit ? { capabilities: { elicitation: { form: {} } } } : {},
  );
  if (options.elicit) {
    const answer = options.elicit;
    client.setRequestHandler(ElicitRequestSchema, async (request) => answer(request.params.message));
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([built.server.connect(serverSide), client.connect(clientSide)]);

  async function callTool(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests poke into arbitrary data
    return result.structuredContent as { ok: boolean; data?: any; error?: any; meta?: any };
  }
  return { client, calls, store, callTool, tools: built.tools };
}
