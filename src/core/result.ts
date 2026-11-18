import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ErrorPayload } from './errors.js';
import type { JsonValue } from './json.js';

export interface ToolMeta {
  durationMs: number;
  // The Stockbit path the data came from, so an answer can say where a number was read.
  source?: string;
  warnings?: string[];
}

// The envelope goes into both the text block and structuredContent: clients that only render text
// and clients that read structured data must see the same information.
export function toSuccessResult(data: JsonValue, meta: ToolMeta): CallToolResult {
  const envelope = { ok: true, data, meta };
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}

export function toErrorResult(error: ErrorPayload, durationMs: number): CallToolResult {
  const envelope = { ok: false, error, meta: { durationMs } };
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify(envelope) }],
    structuredContent: envelope,
  };
}
