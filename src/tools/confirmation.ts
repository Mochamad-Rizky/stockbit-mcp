import { z } from 'zod';
import type { ConfirmRequest } from '../core/confirm.js';
import type { JsonValue } from '../core/json.js';
import type { ToolContext, ToolOutput } from './types.js';

export const confirmationTokenInput = z
  .string()
  .min(10)
  .optional()
  .describe(
    'Only for clients without confirmation popups: the token a previous call returned with its ' +
      'preview. Send it only after the user has confirmed that preview.',
  );

// Asks the user. Resolves null when they confirmed (go ahead), or the output to return instead:
// the preview and token when the client cannot show a popup. A refusal throws.
export async function confirmFirst(
  ctx: ToolContext,
  request: ConfirmRequest,
  token: string | undefined,
): Promise<ToolOutput<JsonValue> | null> {
  const outcome = await ctx.confirmer.confirm(request, token);
  if (outcome.status === 'confirmed') {
    return null;
  }
  return {
    data: outcome as unknown as JsonValue,
    warnings: ['NOT SENT. Waiting for the user to confirm the preview.'],
  };
}
