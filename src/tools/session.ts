import { CATALOG_APP_VERSION } from '../catalog/index.js';
import type { JsonValue } from '../core/json.js';
import { VERSION } from '../version.js';
import { READ_ONLY } from './annotations.js';
import { defineTool, type AnyToolDefinition } from './types.js';

const sessionStatus = defineTool({
  name: 'session_status',
  domain: 'session',
  title: 'Login status',
  description:
    'Whether this server has a Stockbit session (needed by every tool) and a trading session (needed ' +
    'by the account_* tools), with their expiry. Never returns the tokens. If a session is missing, ' +
    'tell the user to run `stockbit-mcp login` (or `stockbit-mcp login --trading`) in a terminal.',
  inputSchema: {},
  annotations: { ...READ_ONLY, openWorldHint: false },
  async handler(_input, ctx) {
    const status = await ctx.auth.status();
    return {
      data: {
        ...status,
        server_version: VERSION,
        catalog_app_version: CATALOG_APP_VERSION,
      } as unknown as JsonValue,
    };
  },
});

export const sessionTools: AnyToolDefinition[] = [sessionStatus] as AnyToolDefinition[];
