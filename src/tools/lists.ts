import { z } from 'zod';
import { CHANGES, DESTRUCTIVE } from './annotations.js';
import { call, dateInput, symbolInput, upper } from './common.js';
import { confirmationTokenInput, confirmFirst } from './confirmation.js';
import { endpointTool } from './endpoint-tool.js';
import { companyIdOf } from './reference.js';
import { defineTool, type AnyToolDefinition } from './types.js';

// Watchlists and price alerts: read freely, change with the usual tool permission, delete only
// after the user confirms.

const watchlistId = z
  .union([z.number().int(), z.string().min(1)])
  .describe('Watchlist id, from watchlist_list.');

const watchlistCreate = defineTool({
  name: 'watchlist_create',
  domain: 'watchlist',
  title: 'Create a watchlist',
  description: 'Creates an empty watchlist with the given name.\n\nEndpoint: POST exodus /watchlist.',
  inputSchema: { name: z.string().min(1).max(60).describe('Name of the new watchlist.') },
  annotations: CHANGES,
  async handler({ name }, ctx) {
    return call(ctx, { method: 'POST', path: '/watchlist', body: { name } });
  },
});

const watchlistRename = defineTool({
  name: 'watchlist_rename',
  domain: 'watchlist',
  title: 'Rename a watchlist',
  description: 'Renames a watchlist (and sets its description).\n\nEndpoint: PUT exodus /watchlist/{id}.',
  inputSchema: {
    watchlist_id: watchlistId,
    name: z.string().min(1).max(60).describe('New name.'),
    description: z.string().max(200).optional().describe('Description; default the name.'),
  },
  annotations: CHANGES,
  async handler({ watchlist_id, name, description }, ctx) {
    return call(ctx, {
      method: 'PUT',
      path: `/watchlist/${encodeURIComponent(String(watchlist_id))}`,
      body: { name, description: description ?? name },
    });
  },
});

const watchlistAdd = defineTool({
  name: 'watchlist_add',
  domain: 'watchlist',
  title: 'Add a stock to a watchlist',
  description:
    'Adds one symbol to a watchlist (the tool looks up the company id Stockbit needs).\n\n' +
    'Endpoint: POST exodus /watchlist/{id}/company/item.',
  inputSchema: { watchlist_id: watchlistId, symbol: symbolInput },
  annotations: CHANGES,
  async handler({ watchlist_id, symbol }, ctx) {
    const companyId = await companyIdOf(ctx, symbol);
    return call(ctx, {
      method: 'POST',
      path: `/watchlist/${encodeURIComponent(String(watchlist_id))}/company/item`,
      body: { company_id: Number.isNaN(Number(companyId)) ? companyId : Number(companyId) },
    });
  },
});

const watchlistRemove = defineTool({
  name: 'watchlist_remove',
  domain: 'watchlist',
  title: 'Remove a stock from a watchlist',
  description:
    'Removes one symbol from a watchlist.\n\nEndpoint: DELETE exodus /watchlist/{id}/company/{companyId}/item.',
  inputSchema: { watchlist_id: watchlistId, symbol: symbolInput },
  annotations: DESTRUCTIVE,
  async handler({ watchlist_id, symbol }, ctx) {
    const companyId = await companyIdOf(ctx, symbol);
    return call(ctx, {
      method: 'DELETE',
      path: `/watchlist/${encodeURIComponent(String(watchlist_id))}/company/${encodeURIComponent(companyId)}/item`,
    });
  },
});

const watchlistDelete = defineTool({
  name: 'watchlist_delete',
  domain: 'watchlist',
  title: 'Delete a watchlist',
  description:
    'Deletes a whole watchlist. The user confirms first (a popup, or a preview and token).\n\n' +
    'Endpoint: DELETE exodus /watchlist/{id}.',
  inputSchema: {
    watchlist_id: watchlistId,
    watchlist_name: z.string().optional().describe('Its name, shown in the confirmation.'),
    confirmation_token: confirmationTokenInput,
  },
  annotations: DESTRUCTIVE,
  async handler({ watchlist_id, watchlist_name, confirmation_token }, ctx) {
    const pending = await confirmFirst(
      ctx,
      {
        action: 'watchlist_delete',
        title: 'Hapus watchlist',
        lines: [`Watchlist: ${watchlist_name ?? watchlist_id} (id ${watchlist_id})`, 'Semua saham di dalamnya ikut terhapus.'],
        payload: { watchlist_id: String(watchlist_id) },
      },
      confirmation_token,
    );
    if (pending) return pending;
    return call(ctx, { method: 'DELETE', path: `/watchlist/${encodeURIComponent(String(watchlist_id))}` });
  },
});

const ALERT_ITEMS = [
  'ITEM_PRICE',
  'ITEM_PRICE_CHANGE',
  'ITEM_VALUE',
  'ITEM_VOLUME',
  'ITEM_FREQUENCY',
  'ITEM_BEST_BID',
  'ITEM_BEST_OFFER',
  'ITEM_RSI_14',
  'ITEM_MA_5',
  'ITEM_MA_10',
  'ITEM_MA_20',
  'ITEM_MA_50',
  'ITEM_MA_100',
  'ITEM_MA_200',
] as const;

const alertCreate = defineTool({
  name: 'alert_create',
  domain: 'alert',
  title: 'Create a price alert',
  description:
    'Creates a Stockbit alert on one symbol: price, change, value, volume, frequency, best bid/offer, ' +
    'RSI(14) or price vs a moving average, compared with a threshold. alert_options lists what the ' +
    'account allows.\n\nEndpoint: POST exodus /alert/v2/create.',
  inputSchema: {
    symbol: symbolInput,
    item: z.enum(ALERT_ITEMS).describe('What to watch. ITEM_MA_* compares the price with that moving average.'),
    operator: z
      .enum([
        'OPERATOR_GREATER_THAN',
        'OPERATOR_GREATER_THAN_EQUAL',
        'OPERATOR_EQUAL',
        'OPERATOR_LESSER_THAN_EQUAL',
        'OPERATOR_LESSER_THAN',
        'OPERATOR_CROSSING_UP',
        'OPERATOR_CROSSING_DOWN',
      ])
      .describe('Comparison; CROSSING_* fire when the item crosses the value (or the MA).'),
    value: z
      .union([z.number(), z.string()])
      .optional()
      .describe('Threshold (IDR for prices, percent for change). Leave out for ITEM_MA_*.'),
    expiry: z
      .enum([
        'EXPIRATION_ONE_WEEK',
        'EXPIRATION_ONE_MONTH',
        'EXPIRATION_THREE_MONTH',
        'EXPIRATION_SIX_MONTH',
        'EXPIRATION_ONE_YEAR',
        'EXPIRATION_CUSTOM',
      ])
      .optional()
      .describe('How long the alert lives; default one month.'),
    expiry_date: dateInput.optional().describe('End date, only with EXPIRATION_CUSTOM.'),
    note: z.string().max(200).optional().describe('A note shown with the alert.'),
  },
  annotations: CHANGES,
  async handler(input, ctx) {
    const body = {
      ...(input.note ? { name: input.note } : {}),
      symbol: upper(input.symbol),
      rules: {
        and: [
          {
            condition: {
              item: input.item,
              operator: input.operator,
              value: input.value === undefined ? '' : String(input.value),
            },
          },
        ],
      },
      expiry: input.expiry ?? 'EXPIRATION_ONE_MONTH',
      ...(input.expiry_date ? { expiry_date: input.expiry_date } : {}),
    };
    return call(ctx, { method: 'POST', path: '/alert/v2/create', body });
  },
});

const alertIds = z.array(z.number().int()).min(1).max(100).describe('Alert ids, from alert_list.');

const alertSetStatus = defineTool({
  name: 'alert_set_status',
  domain: 'alert',
  title: 'Turn alerts on or off',
  description: 'Activates or deactivates alerts.\n\nEndpoint: PATCH exodus /alert/v2/update-status.',
  inputSchema: { alert_ids: alertIds, status: z.enum(['STATUS_ACTIVE', 'STATUS_INACTIVE']).describe('New status.') },
  annotations: CHANGES,
  async handler({ alert_ids, status }, ctx) {
    return call(ctx, { method: 'PATCH', path: '/alert/v2/update-status', body: { alert_ids, status } });
  },
});

const alertDelete = defineTool({
  name: 'alert_delete',
  domain: 'alert',
  title: 'Delete alerts',
  description: 'Deletes alerts after the user confirms.\n\nEndpoint: POST exodus /alert/v2/delete.',
  inputSchema: { alert_ids: alertIds, confirmation_token: confirmationTokenInput },
  annotations: DESTRUCTIVE,
  async handler({ alert_ids, confirmation_token }, ctx) {
    const pending = await confirmFirst(
      ctx,
      {
        action: 'alert_delete',
        title: 'Hapus alert',
        lines: [`${alert_ids.length} alert: ${alert_ids.join(', ')}`],
        payload: { alert_ids },
      },
      confirmation_token,
    );
    if (pending) return pending;
    return call(ctx, { method: 'POST', path: '/alert/v2/delete', body: { alert_ids } });
  },
});

export const listTools: AnyToolDefinition[] = [
  endpointTool({
    id: 'list_watchlists',
    name: 'watchlist_list',
    domain: 'watchlist',
    title: 'Watchlists',
    summary: 'The account\'s watchlists with their ids and sizes.',
  }),
  endpointTool({
    id: 'get_watchlist',
    name: 'watchlist_get',
    domain: 'watchlist',
    title: 'Stocks in a watchlist',
    summary: 'The stocks of one watchlist with price, change and volume.',
  }),
  endpointTool({
    id: 'list_favorite_watchlists',
    name: 'watchlist_favorites',
    domain: 'watchlist',
    title: 'Favorite watchlists',
    summary: 'The watchlists marked favorite, in their order.',
  }),
  watchlistCreate,
  watchlistRename,
  watchlistAdd,
  watchlistRemove,
  watchlistDelete,
  endpointTool({
    id: 'list_alerts',
    name: 'alert_list',
    domain: 'alert',
    title: 'Alerts',
    summary: 'The account\'s alerts, optionally for one symbol or status.',
  }),
  endpointTool({
    id: 'get_alert_initialization',
    name: 'alert_options',
    domain: 'alert',
    title: 'Alert options for a symbol',
    summary: 'What an alert on one symbol can watch, the allowed expirations and the current values.',
  }),
  alertCreate,
  alertSetStatus,
  alertDelete,
] as AnyToolDefinition[];
