import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { toErrorPayload } from '../core/errors.js';
import { capArrays } from '../core/json.js';
import { toErrorResult, toSuccessResult } from '../core/result.js';
import type { AnyToolDefinition, ToolContext } from './types.js';

// Runs one tool the way every caller runs it: validated, its lists capped, wrapped in the envelope.
// It never throws; every failure becomes an error result.
export async function runTool(
  tool: AnyToolDefinition,
  args: unknown,
  ctx: ToolContext,
): Promise<CallToolResult> {
  const started = Date.now();
  const parsed = z.object(tool.inputSchema).strict().safeParse(args ?? {});
  if (!parsed.success) {
    return toErrorResult(
      {
        code: 'INVALID_INPUT',
        message: parsed.error.issues.map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`).join('; '),
      },
      Date.now() - started,
    );
  }
  try {
    const out = await tool.handler(parsed.data, ctx);
    const { value, cuts } = capArrays(out.data, ctx.config.maxItems);
    const warnings = [...(out.warnings ?? [])];
    if (cuts.length > 0) {
      warnings.push(
        `Lists were cut to ${ctx.config.maxItems} items (${cuts.slice(0, 5).join('; ')}${cuts.length > 5 ? '; …' : ''}). Narrow the request (limit, page, period) for the rest.`,
      );
    }
    return toSuccessResult(value, {
      durationMs: Date.now() - started,
      ...(out.source === undefined ? {} : { source: out.source }),
      ...(warnings.length === 0 ? {} : { warnings }),
    });
  } catch (error) {
    const payload = toErrorPayload(error);
    if (payload.code === 'INTERNAL') {
      ctx.logger.error('tool failed', { tool: tool.name, error: payload.message });
    }
    return toErrorResult(payload, Date.now() - started);
  }
}

export function registerTools(server: McpServer, tools: AnyToolDefinition[], ctx: ToolContext): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      (args: unknown) => runTool(tool, args, ctx),
    );
  }
}
