import { z } from 'zod';
import { StockbitMcpError } from '../core/errors.js';
import { isJsonObject } from '../core/json.js';
import { READ_ONLY } from './annotations.js';
import { call, limitInput, pageInput } from './common.js';
import { endpointTool } from './endpoint-tool.js';
import { defineTool, type AnyToolDefinition } from './types.js';

// Company reference, fundamentals, ownership, corporate actions, screener, search and the social
// stream: everything on a stock page besides prices and order flow.

const screenerRule = z
  .object({
    metric_id: z.number().int().describe('fitem id of the metric, from screener_metrics.'),
    metric_name: z.string().min(1).describe('Its display name, e.g. "PE Ratio (TTM)".'),
    operator: z.enum(['>', '<', '>=', '<=', '=', 'all']).describe('"all" adds the metric as a column without filtering.'),
    value: z
      .union([z.number(), z.string()])
      .optional()
      .describe('Threshold for a basic rule (metric operator value).'),
    compare_metric_id: z
      .number()
      .int()
      .optional()
      .describe('For a metric-vs-metric rule: the right-hand metric id (metric operator multiplier x compare).'),
    compare_metric_name: z.string().optional().describe('Display name of compare_metric_id.'),
    multiplier: z.number().optional().describe('Factor on the right-hand metric, default 1.'),
  })
  .describe('One screener rule.');

const screenerRun = defineTool({
  name: 'screener_run',
  domain: 'screener',
  title: 'Run a stock screener',
  description:
    'Screens IDX stocks with rules on fundamental, technical and flow metrics and returns the matching ' +
    'stocks with the metric values as columns. Look up metric ids with screener_metrics and universes ' +
    'with screener_universe first. Runs a temporary screener: nothing is saved to the account. ' +
    'Some metrics (e.g. bandarmology) may need Stockbit Pro.\n\nEndpoint: POST exodus /screener/templates (save "0").',
  inputSchema: {
    rules: z.array(screenerRule).min(1).max(20).describe('The rules; all must hold.'),
    universe_name: z.string().optional().describe('Universe name from screener_universe, default "IHSG".'),
    universe_scope: z.string().optional().describe('Its scope, default "IHSG".'),
    universe_scope_id: z.string().optional().describe('Its scope id, default "".'),
    page: pageInput,
    limit: limitInput(100, 50),
    order_column: z
      .number()
      .int()
      .min(2)
      .optional()
      .describe('Column to sort by: 2 is the first rule\'s metric, 3 the second, and so on. Default 2.'),
    order: z.enum(['asc', 'desc']).optional().describe('Sort direction, default desc.'),
  },
  annotations: READ_ONLY,
  async handler(input, ctx) {
    const rows = input.rules.map((r, i) => {
      const compare = r.compare_metric_id !== undefined;
      if (!compare && r.operator !== 'all' && r.value === undefined) {
        throw new StockbitMcpError('INVALID_INPUT', `rules[${i}]: a basic rule needs value.`);
      }
      return {
        id: i + 1,
        type: compare ? 'compare' : 'basic',
        item1: r.metric_id,
        item1_name: r.metric_name,
        operator: r.operator,
        item2: compare ? String(r.compare_metric_id) : r.value === undefined ? '' : String(r.value),
        item2_name: compare ? (r.compare_metric_name ?? '') : '',
        multiplier: compare ? String(r.multiplier ?? 1) : '',
      };
    });
    // The app strips every underscore from the serialized rules (item1_name -> item1name) and the
    // server expects that form.
    const filters = JSON.stringify(rows).replace(/_/g, '');
    const body = {
      filters,
      universe: JSON.stringify({
        name: input.universe_name ?? 'IHSG',
        scope: input.universe_scope ?? 'IHSG',
        scopeId: input.universe_scope_id ?? '',
      }),
      name: 'stockbit-mcp',
      description: '',
      type: 'TEMPLATE_TYPE_CUSTOM',
      screenerid: '0',
      save: '0',
      page: input.page ?? 1,
      limit: input.limit ?? 50,
      ordercol: input.order_column ?? 2,
      ordertype: input.order ?? 'desc',
      sequence: '',
    };
    return call(ctx, { method: 'POST', path: '/screener/templates', body });
  },
});

// The numeric company id some endpoints take instead of the ticker.
export async function companyIdOf(ctx: Parameters<AnyToolDefinition['handler']>[1], symbol: string) {
  const out = await call(ctx, { path: `/emitten/${encodeURIComponent(symbol.toUpperCase())}/info` });
  const id = isJsonObject(out.data) ? out.data.id : undefined;
  if (typeof id !== 'number' && typeof id !== 'string') {
    throw new StockbitMcpError('NOT_FOUND', `No company id for ${symbol}.`);
  }
  return String(id);
}

const shareholdersMonthly = defineTool({
  name: 'ownership_shareholders_monthly',
  domain: 'ownership',
  title: 'Monthly shareholder list (KSEI)',
  description:
    'The shareholders above 1% of one company from the monthly report, with holdings and changes. ' +
    'Takes the ticker; the tool looks up the numeric company id.\n\nEndpoint: GET exodus /insider/shareholding/companies/{companyId}.',
  inputSchema: {
    symbol: z.string().min(1).describe('IDX ticker, e.g. BBCA.'),
    report_date: z.string().optional().describe('Report month as YYYY-MM-DD; default the latest.'),
  },
  annotations: READ_ONLY,
  async handler({ symbol, report_date }, ctx) {
    const id = await companyIdOf(ctx, symbol);
    return call(ctx, {
      path: `/insider/shareholding/companies/${encodeURIComponent(id)}`,
      ...(report_date ? { query: { report_date } } : {}),
    });
  },
});

export const referenceTools: AnyToolDefinition[] = [
  // ---- Company ---------------------------------------------------------------------------------
  endpointTool({
    id: 'get_emitten_info',
    name: 'company_info',
    domain: 'company',
    title: 'Company info and quote header',
    summary:
      'The stock page header of one symbol: name, sector/sub-sector, board, price and change, special ' +
      'notations, indexes it belongs to, tradeability, corporate action banner, day-trade and margin info.',
  }),
  endpointTool({
    id: 'get_company_profile',
    name: 'company_profile',
    domain: 'company',
    title: 'Company profile',
    summary:
      'Business description, listing date, address, management (board of directors and commissioners), ' +
      'shareholders and the history of the company.',
  }),
  endpointTool({
    id: 'get_company_subsidiaries',
    name: 'company_subsidiaries',
    domain: 'company',
    title: 'Subsidiaries',
    summary: 'Subsidiaries of one company with ownership percentage and business.',
  }),
  endpointTool({
    id: 'list_trending_stocks',
    name: 'company_trending',
    domain: 'company',
    title: 'Trending stocks',
    summary: 'Stocks trending on Stockbit right now (most discussed and viewed).',
  }),
  endpointTool({
    id: 'list_indexes',
    name: 'company_indexes',
    domain: 'company',
    title: 'Indexes',
    summary: 'IDX indexes (IHSG, LQ45, IDX30, sector indexes …) with their latest value and change.',
  }),
  endpointTool({
    id: 'list_sector_overview',
    name: 'company_sectors',
    domain: 'company',
    title: 'Sector overview',
    summary: 'Sectors with their average change, to see sector rotation.',
  }),
  endpointTool({
    id: 'list_sector_subsectors',
    name: 'company_subsectors',
    domain: 'company',
    title: 'Sub-sectors of a sector',
    summary: 'The sub-sectors of one sector (use the sector id or name from company_sectors).',
  }),
  endpointTool({
    id: 'list_subsector_companies',
    name: 'company_by_subsector',
    domain: 'company',
    title: 'Companies in a sub-sector',
    summary: 'Every company in one sub-sector, with price and change — peers for comparison.',
  }),
  endpointTool({
    id: 'list_catalog_companies',
    name: 'company_by_catalog',
    domain: 'company',
    title: 'Companies in an index or catalog',
    summary: 'Members of an index or catalog (e.g. LQ45) by its catalog code.',
  }),
  endpointTool({
    id: 'list_classifications',
    name: 'company_classifications',
    domain: 'company',
    title: 'Sector classification tree',
    summary:
      'The whole IDX sector classification as a tree of four levels: level 1 Sektor, 2 Sub-sektor, ' +
      '3 Industri, 4 Sub-industri. Each node has an id for company_classification and ' +
      'company_by_classification.',
    notes: 'Names are Indonesian; level-1 nodes carry the English sector label in symbol (e.g. "Non-Cyclical").',
  }),
  endpointTool({
    id: 'get_classification',
    name: 'company_classification',
    domain: 'company',
    title: 'One sector classification node',
    summary:
      'One node of the sector classification (id from company_classifications) with its direct ' +
      'children and how many companies each holds (total_company).',
    notes: 'The node\'s own name, level and total_company sit beside data; data lists the children.',
  }),
  endpointTool({
    id: 'list_classification_companies',
    name: 'company_by_classification',
    domain: 'company',
    title: 'Companies in a sector classification',
    summary:
      'Every company under one or more classification nodes (any level: a whole sector or a single ' +
      'sub-industry), with price, change, market cap and liquidity. Peers at the finest grain.',
    notes:
      'One group per id in data[]. marketcap and valuema20 (20-day average traded value) are IDR; ' +
      'volume and avgvolume are shares.',
    override: {
      ids: z.array(z.number().int().positive()).min(1).max(20),
    },
  }),
  endpointTool({
    id: 'get_global_markets',
    name: 'company_global_markets',
    domain: 'company',
    title: 'Global markets',
    summary: 'World indexes, commodities and currencies as Stockbit shows them in Discover.',
  }),

  // ---- Fundamentals ----------------------------------------------------------------------------
  endpointTool({
    id: 'get_keystats',
    name: 'financial_keystats',
    domain: 'financial',
    title: 'Key statistics',
    summary:
      'Key statistics of one symbol: valuation (PE, PBV, EV/EBITDA), per-share data, profitability ' +
      '(ROE, ROA, margins), solvency, growth, dividend — current and per year.',
  }),
  endpointTool({
    id: 'get_financial_statements',
    name: 'financial_statements',
    domain: 'financial',
    title: 'Financial statements',
    summary:
      'Income statement, balance sheet or cash flow of one symbol, quarterly or annual (report_type and ' +
      'statement_type select which).',
    notes: 'Values are in the currency and scale the response states (often IDR billions).',
  }),
  endpointTool({
    id: 'get_fitem_ratio',
    name: 'financial_ratios',
    domain: 'financial',
    title: 'Financial items for symbols',
    summary: 'Chosen financial items (fitem ids, from screener_metrics) for one or more symbols at once.',
  }),
  endpointTool({
    id: 'get_comparison_ratios',
    name: 'financial_comparison',
    domain: 'financial',
    title: 'Peer comparison',
    summary: 'Ratios of one symbol next to its industry peers (the Comparison tab).',
  }),
  endpointTool({
    id: 'get_comparison_industries',
    name: 'financial_comparison_industries',
    domain: 'financial',
    title: 'Comparison peer groups',
    summary: 'The peer groups (industries) one symbol can be compared within.',
  }),
  endpointTool({
    id: 'get_comparison_metrics',
    name: 'financial_comparison_metrics',
    domain: 'financial',
    title: 'Comparison metrics',
    summary: 'The metrics the comparison view can show.',
  }),
  endpointTool({
    id: 'get_fundachart',
    name: 'financial_chart',
    domain: 'financial',
    title: 'Fundamental chart (PE/PBV bands, metric history)',
    summary:
      'History of a fundamental metric (e.g. PE or PBV band) for one or more companies over a timeframe, ' +
      'the Fundachart view.',
  }),
  endpointTool({
    id: 'get_analyst_rating',
    name: 'financial_analyst_ratings',
    domain: 'financial',
    title: 'Analyst ratings',
    summary: 'Broker analyst ratings and target prices for one symbol.',
  }),
  endpointTool({
    id: 'get_analyst_consensus',
    name: 'financial_analyst_consensus',
    domain: 'financial',
    title: 'Analyst consensus',
    summary: 'Consensus of analyst ratings and target price for one symbol.',
  }),

  // ---- Ownership -------------------------------------------------------------------------------
  endpointTool({
    id: 'list_insider_transactions',
    name: 'ownership_insider_transactions',
    domain: 'ownership',
    title: 'Insider / major holder transactions',
    summary:
      'Buys and sells reported by insiders and major holders (above 5%), per symbol or market-wide, ' +
      'with date, price, shares before/after.',
  }),
  endpointTool({
    id: 'get_insider_ownership',
    name: 'ownership_insider_holdings',
    domain: 'ownership',
    title: 'Holdings of an insider',
    summary: 'What one insider or major holder owns across companies.',
  }),
  endpointTool({
    id: 'get_shareholder_composition',
    name: 'ownership_composition',
    domain: 'ownership',
    title: 'Shareholder composition',
    summary:
      'Ownership composition of one symbol over time by investor type (local/foreign, institution, ' +
      'retail …) from KSEI data.',
  }),
  endpointTool({
    id: 'get_ultimate_beneficial_owners',
    name: 'ownership_ubo',
    domain: 'ownership',
    title: 'Ultimate beneficial owners',
    summary: 'The ultimate beneficial owners (UBO) behind one company.',
  }),
  endpointTool({
    id: 'get_shareholding_network',
    name: 'ownership_network',
    domain: 'ownership',
    title: 'Shareholding network',
    summary: 'The ownership graph around a company or investor: who owns whom, to a depth.',
  }),
  endpointTool({
    id: 'get_investor_holdings',
    name: 'ownership_investor_holdings',
    domain: 'ownership',
    title: 'Holdings of an investor (monthly)',
    summary: 'Every company one investor holds above 1%, from the monthly report (investor id from other ownership tools).',
  }),
  endpointTool({
    id: 'get_investor_ubo',
    name: 'ownership_investor_ubo',
    domain: 'ownership',
    title: 'What an investor ultimately owns (UBO)',
    summary:
      'The companies one investor ultimately owns, directly and through holding companies ' +
      '(subholdings), with shares, percentage and value now and a month earlier. The investor-side ' +
      'view of ownership_ubo. Investor id from ownership_shareholders_monthly (holders[].investor.id).',
    notes:
      'Monthly data: first_available_date and last_available_date bound report_date. Works best for ' +
      'individuals; corporate investors often answer empty holdings. Values IDR.',
  }),
  shareholdersMonthly,

  // ---- Corporate actions and calendar ----------------------------------------------------------
  endpointTool({
    id: 'get_calendar_day',
    name: 'corpaction_calendar',
    domain: 'corpaction',
    title: 'Corporate action and economic calendar',
    summary:
      'Everything scheduled on a date: dividends (cum/ex/payment), stock splits, rights issues, bonus, ' +
      'IPOs, RUPS/AGMs, public expose, plus economic calendar events.',
  }),
  endpointTool({
    id: 'list_corpactions_by_category',
    name: 'corpaction_by_category',
    domain: 'corpaction',
    title: 'Corporate actions by category',
    summary:
      'Corporate actions of one category (e.g. dividend, rups, stocksplit, rightissue, warrant, bonus, ' +
      'tenderoffer, ipo, economic), market-wide or for one symbol (symbol).',
  }),
  endpointTool({
    id: 'list_stock_conversion',
    name: 'corpaction_conversion',
    domain: 'corpaction',
    title: 'Rights/warrant conversion history',
    summary: 'Exercise and conversion history of a right or warrant (e.g. BUKA-W).',
  }),
  endpointTool({
    id: 'get_corpaction_status',
    name: 'corpaction_status',
    domain: 'corpaction',
    title: 'Active corporate action of a symbol',
    summary: 'Whether one symbol has an active corporate action now (e.g. in a cum date window).',
  }),

  // ---- Screener --------------------------------------------------------------------------------
  endpointTool({
    id: 'get_screener_metrics',
    name: 'screener_metrics',
    domain: 'screener',
    title: 'Screener metrics',
    summary: 'The tree of metrics a screener rule can use, with their fitem ids (needed by screener_run).',
  }),
  endpointTool({
    id: 'get_screener_universe',
    name: 'screener_universe',
    domain: 'screener',
    title: 'Screener universes',
    summary: 'The stock universes a screener can run on: IHSG, indexes, sectors, watchlists.',
  }),
  endpointTool({
    id: 'list_screener_presets',
    name: 'screener_presets',
    domain: 'screener',
    title: 'Preset screeners',
    summary: 'Stockbit\'s ready-made (guru and preset) screeners.',
  }),
  endpointTool({
    id: 'list_saved_screeners',
    name: 'screener_saved',
    domain: 'screener',
    title: 'Saved screeners',
    summary: 'The screeners saved in this account.',
  }),
  endpointTool({
    id: 'list_favorite_screeners_v2',
    name: 'screener_favorites',
    domain: 'screener',
    title: 'Favorite screeners',
    summary:
      'The screeners this account marked as favorite, searchable by name and paged, optionally with ' +
      'each one\'s rules (with_summary). Run one with screener_result (type 2 for ' +
      'TEMPLATE_TYPE_CUSTOM, 1 for TEMPLATE_TYPE_GURU).',
    notes: 'With with_summary=true Stockbit pages by 10 whatever the limit; follow pagination.next_page.',
  }),
  endpointTool({
    id: 'get_screener_result',
    name: 'screener_result',
    domain: 'screener',
    title: 'Result of a saved or preset screener',
    summary: 'Runs a saved or preset screener by id and returns the matching stocks.',
  }),
  screenerRun,

  // ---- Search, stream, research ------------------------------------------------------------------
  endpointTool({
    id: 'search_v2',
    name: 'search',
    domain: 'search',
    title: 'Search',
    summary: 'Searches companies (and people/insiders) by ticker or name.',
  }),
  endpointTool({
    id: 'get_symbol_stream',
    name: 'stream_symbol',
    domain: 'stream',
    title: 'Stream posts of a symbol',
    summary:
      'Posts in the Stockbit stream of one symbol: community posts, news, reports and IDX announcements ' +
      '(category). Page with last_stream_id.',
  }),
  endpointTool({
    id: 'get_symbol_pinned_posts',
    name: 'stream_pinned',
    domain: 'stream',
    title: 'Pinned posts of a symbol',
    summary: 'The posts pinned on one symbol\'s stream (often the company\'s own announcements).',
  }),
  endpointTool({
    id: 'list_research',
    name: 'stream_research',
    domain: 'stream',
    title: 'Research reports',
    summary: 'Stockbit research articles, optionally for one symbol or keyword.',
  }),
];
