import { accountTools } from './account.js';
import { apiTools } from './api.js';
import { listTools } from './lists.js';
import { marketTools } from './market.js';
import { orderTools } from './orders.js';
import { referenceTools } from './reference.js';
import { sessionTools } from './session.js';
import type { AnyToolDefinition } from './types.js';

export function allTools(): AnyToolDefinition[] {
  return [
    ...sessionTools,
    ...marketTools,
    ...referenceTools,
    ...listTools,
    ...accountTools,
    ...orderTools,
    ...apiTools,
  ];
}
