import { z } from 'zod';
import { dateInput } from './common.js';
import { endpointTool } from './endpoint-tool.js';
import type { AnyToolDefinition } from './types.js';

// Order flow, broker and foreign flow, price and chart data. Units were checked against captured
// answers (docs/reverse-engineering.md): most lot fields are lots (100 shares), the order book
// levels and a few totals are shares, and every value is IDR.

const LOTS = 'Volumes (lot, blot, slot) are in lots of 100 shares; values are IDR.';

// Stockbit's dates are Jakarta dates. Jakarta is UTC+7 all year (no daylight saving), so its
// calendar day is the UTC one shifted by 7 hours.
const JAKARTA_OFFSET_MS = 7 * 3_600_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() + JAKARTA_OFFSET_MS - days * 86_400_000).toISOString().slice(0, 10);
}

// The first or last second of a Jakarta day, as unix seconds.
function jakartaUnix(date: string, edge: 'start' | 'end'): number {
  return Date.parse(`${date}T${edge === 'start' ? '00:00:00' : '23:59:59'}+07:00`) / 1000;
}

export const marketTools: AnyToolDefinition[] = [
  // ---- Order flow ------------------------------------------------------------------------------
  endpointTool({
    id: 'get_running_trade',
    name: 'flow_running_trade',
    domain: 'flow',
    title: 'Running trade',
    summary:
      'The tape: every matched trade, newest first, for one or more symbols or the whole market. ' +
      'Filter by price, lot size, value, time range, broker or investor type; page with trade_number ' +
      'and cursor_direction.',
    notes:
      `${LOTS} While the market is open Stockbit hides the broker codes of today's trades ` +
      '(is_show_bs false) and ignores broker/investor filters; they work after the close or for a past ' +
      'date. A past date works for a single symbol only. Buyer/seller codes carry [D] domestic or [F] foreign.',
  }),
  endpointTool({
    id: 'get_running_trade_group',
    name: 'flow_running_trade_group',
    domain: 'flow',
    title: 'Running trade grouped by order',
    summary: 'Running trade with the partial fills of one order grouped together, for one symbol.',
    notes: LOTS,
  }),
  endpointTool({
    id: 'get_trade_book',
    name: 'flow_trade_book',
    domain: 'flow',
    title: 'Trade book (done summary)',
    summary:
      'How much traded at each price (group_by GROUP_BY_PRICE) or in each time bucket (GROUP_BY_TIME), ' +
      'split into buy and sell side: frequency, lots and value. The "done summary" view.',
    notes: `${LOTS} Numbers come pre-formatted as strings (e.g. "1,372,029", "134.55B").`,
  }),
  endpointTool({
    id: 'get_trade_flow_chart',
    name: 'flow_trade_flow',
    domain: 'flow',
    title: 'Trade flow chart',
    summary:
      'Trade flow over the day: cumulative buy vs sell value, volume and frequency per interval for one ' +
      'symbol, the series behind Stockbit\'s Trade Flow chart.',
    notes: LOTS,
  }),
  endpointTool({
    id: 'get_order_queue',
    name: 'flow_order_queue',
    domain: 'flow',
    title: 'Order queue at a price',
    summary:
      'The queue of individual orders waiting at one price level (bid or offer), with their lots and ' +
      'time, for one symbol. Use the order book first to pick the price.',
    notes: LOTS,
  }),

  // ---- Broker ----------------------------------------------------------------------------------
  endpointTool({
    id: 'get_broker_summary',
    name: 'broker_summary',
    domain: 'broker',
    title: 'Broker summary (bandarmology)',
    summary:
      'Top buyer and seller brokers of one symbol over a period, with net lots, value and average ' +
      'price, plus the accumulation/distribution read (bandar detector). The classic broker summary.',
    notes:
      'blot/slot are net lots; blotv is gross shares and bvalv gross IDR, so bvalv/blotv is the average ' +
      'price. Broker data is end-of-day or mid-day, not tick-live.',
  }),
  endpointTool({
    id: 'get_broker_summary_v2',
    name: 'broker_summary_v2',
    domain: 'broker',
    title: 'Broker summary (new endpoint)',
    summary:
      'The newer broker summary the desktop Broker Position module uses: buyers and sellers of one ' +
      'symbol over a period with net or gross values.',
    notes: `${LOTS} Note market_board takes MARKET_TYPE_* values here.`,
  }),
  endpointTool({
    id: 'get_broker_flow_chart',
    name: 'broker_flow',
    domain: 'broker',
    title: 'Broker flow chart',
    summary:
      'Broker flow: the cumulative net buy/sell of the top brokers in one symbol over time (the Broker ' +
      'Flow chart). Filter to a broker with broker_code.',
    notes: LOTS,
  }),
  endpointTool({
    id: 'get_broker_distribution',
    name: 'broker_distribution',
    domain: 'broker',
    title: 'Broker distribution',
    summary:
      'Which brokers bought and sold one symbol at which prices: broker x price matrix of value or ' +
      'volume (data_type), the Broker Distribution view.',
    notes:
      'Volume amounts are gross lots; values IDR. market_board takes MARKET_TYPE_* values. On the web ' +
      'Stockbit shows this only to accounts with equity above Rp10.000.000; the server may enforce it.',
  }),
  endpointTool({
    id: 'get_broker_activity',
    name: 'broker_activity',
    domain: 'broker',
    title: 'Broker activity (what a broker traded)',
    summary:
      'For one broker code: the stocks it bought and sold most over a period, net or gross. Use it to ' +
      'follow a broker across the market.',
    notes: `${LOTS} market_board takes MARKET_TYPE_* values.`,
  }),
  endpointTool({
    id: 'get_broker_activity_historical',
    name: 'broker_activity_history',
    domain: 'broker',
    title: 'Broker activity history',
    summary:
      'Day-by-day (or weekly/monthly) net activity of chosen brokers in chosen symbols, for spotting ' +
      'steady accumulation or distribution.',
    notes: LOTS,
  }),
  endpointTool({
    id: 'get_broker_activity_chart',
    name: 'broker_activity_chart',
    domain: 'broker',
    title: 'Broker activity chart',
    summary: 'Time series of chosen brokers\' net activity, optionally within chosen symbols.',
    notes: LOTS,
  }),
  endpointTool({
    id: 'get_top_brokers',
    name: 'broker_top',
    domain: 'broker',
    title: 'Top brokers of the market',
    summary: 'Brokers ranked market-wide by total, buy, sell or net value over a period.',
    notes: 'total_volume is shares; values IDR. Mid-day snapshots carry is_mid_day.',
  }),
  endpointTool({
    id: 'list_brokers',
    name: 'broker_list',
    domain: 'broker',
    title: 'Broker list',
    summary: 'All broker codes with their names and type, to translate codes such as YP, CC or AK.',
  }),

  // ---- Foreign flow ----------------------------------------------------------------------------
  endpointTool({
    id: 'get_foreign_domestic_activity',
    name: 'foreign_flow',
    domain: 'foreign',
    title: 'Foreign vs domestic flow',
    summary:
      'Foreign and domestic buy, sell and net for one symbol over a period range, as a chart series ' +
      'with totals (the Foreign Flow tab).',
    notes: 'volume fields are shares; values IDR. market_type takes MARKET_TYPE_REGULAR or MARKET_TYPE_ALL_MARKET.',
  }),
  endpointTool({
    id: 'get_foreign_flow_summary',
    name: 'foreign_flow_summary',
    domain: 'foreign',
    title: 'Foreign flow summary',
    summary: 'Foreign vs domestic summary for one or more symbols over a period: net foreign value/volume.',
    notes: 'Values IDR. Mid-day snapshots carry is_mid_day / is_break_time.',
  }),
  endpointTool({
    id: 'get_foreign_flow_historical',
    name: 'foreign_flow_history',
    domain: 'foreign',
    title: 'Foreign flow history',
    summary: 'Daily foreign vs domestic net for one or more symbols over a period.',
    notes: 'Values IDR.',
  }),

  // ---- Market ----------------------------------------------------------------------------------
  endpointTool({
    id: 'get_market_movers',
    name: 'market_movers',
    domain: 'market',
    title: 'Market movers',
    summary:
      'Ranked stock lists: top gainers, losers, most active by value/volume/frequency, net foreign ' +
      'buy/sell, and more (mover_type). Defaults to the main, development, acceleration and new ' +
      'economy boards.',
    notes: 'volume.raw is lots; values IDR. Net foreign is stamped per session (net_foreign_updated_at).',
  }),
  endpointTool({
    id: 'get_market_mover_options',
    name: 'market_mover_options',
    domain: 'market',
    title: 'Market mover categories',
    summary: 'The mover types available in one category, e.g. MOVER_CATEGORY_IEPIEV_MOVER (pre-opening).',
  }),
  endpointTool({
    id: 'get_market_mover_catalog',
    name: 'market_breadth',
    domain: 'market',
    title: 'Market breadth (advancers vs decliners)',
    summary:
      'How many IHSG stocks are up, down and unchanged, live or on a past trading day: the breadth ' +
      'bar of the app\'s market overview.',
    notes:
      'Live counts are 0 before the market opens and on non-trading days; pass date for a closed day. ' +
      'Only the IHSG catalog is known to work (LQ45 and IDX30 answered "Catalog not found", 2026-11-18).',
    override: { date: dateInput.optional() },
    prepare: (input) => ({ catalog_codes: 'IHSG', ...input }),
  }),
  endpointTool({
    id: 'get_top_stocks',
    name: 'market_top_stocks',
    domain: 'market',
    title: 'Top stocks by investor flow',
    summary:
      'Stocks ranked by net (or buy/sell) value of an investor type (all, foreign, domestic) over a period.',
    notes: 'Values IDR. Mid-day snapshots carry is_mid_day.',
  }),
  endpointTool({
    id: 'get_market_status',
    name: 'market_status',
    domain: 'market',
    title: 'Market open/closed',
    summary: 'Whether IDX is open now and the trading time left.',
  }),
  endpointTool({
    id: 'get_market_session',
    name: 'market_session',
    domain: 'market',
    title: 'Market sessions',
    summary: 'Today\'s IDX session schedule (pre-opening, session 1, break, session 2, pre-closing, post-trading).',
  }),

  // ---- Price -----------------------------------------------------------------------------------
  endpointTool({
    id: 'get_orderbook',
    name: 'price_orderbook',
    domain: 'price',
    title: 'Order book and quote',
    summary:
      'Live quote and order book of one symbol: last price, change, open/high/low, previous close, ' +
      'ARA/ARB limits, bid and offer levels with lots and frequency, IEP/IEV in pre-opening.',
    notes:
      'bid[].volume and offer[].volume are SHARES (divide by 100 for lots); total_bid_offer.raw_lot is ' +
      'shares too despite its name; iepiev quantities are lots. Prices IDR.',
  }),
  endpointTool({
    id: 'list_orderbook_companies',
    name: 'price_snapshot',
    domain: 'price',
    title: 'Quote snapshot of many symbols',
    summary:
      'One call for up to 100 symbols: last price, change, open/high/low, previous close, volume, ' +
      'value, frequency, foreign buy/sell/net and foreign vs domestic share, status, notations, ' +
      'ARA/ARB. For watchlists and portfolios; use price_orderbook for one symbol\'s bid and offer levels.',
    notes:
      'value, fbuy, fsell, fnet and net_foreign are IDR; foreign and domestic are percentages. bid and ' +
      'offer are null here.',
    override: { symbols: z.array(z.string().trim().min(1)).min(1).max(100) },
  }),
  endpointTool({
    id: 'get_latest_prices_v3',
    name: 'price_latest',
    domain: 'price',
    title: 'Latest prices of symbols',
    summary:
      'Latest OHLC, previous close, change, average price, volume, value and frequency of one or more ' +
      'symbols, stamped with the time of the last update.',
    notes: 'Every number comes as {raw:{value}, formatted} with value a string. Prices and value are IDR.',
    override: { symbol: z.array(z.string().trim().min(1)).min(1).max(100) },
  }),
  endpointTool({
    id: 'get_price_ladder',
    name: 'price_ladder',
    domain: 'price',
    title: 'Price summary of symbols',
    summary: 'Last price, change and basic quote fields for one or more symbols in one call.',
  }),
  endpointTool({
    id: 'get_market_price_by_board',
    name: 'price_by_board',
    domain: 'price',
    title: 'IHSG price and volume by board',
    summary:
      "One day's IHSG (composite index) level, volume and value split by board (regular, cash, " +
      'negotiated), as on the home market card. Use symbol IHSG.',
    notes:
      'volume is shares; values IDR. Stockbit answers an empty result (markets: []) for stocks such ' +
      'as BBCA and for COMPOSITE (checked 2026-10-29); for a stock use price_history or price_ladder.',
  }),
  endpointTool({
    id: 'get_historical_summary',
    name: 'price_history',
    domain: 'price',
    title: 'Historical prices (daily/weekly/monthly)',
    summary:
      'OHLC, change, volume, value, frequency and foreign buy/sell per day (or week/month) for one symbol. ' +
      'Dates default to the last year.',
    notes: 'volume is lots; values IDR. Page through with page.',
    omit: ['start_date', 'end_date'],
    extra: {
      start_date: dateInput.optional().describe('First date, YYYY-MM-DD. Default one year ago.'),
      end_date: dateInput.optional().describe('Last date, YYYY-MM-DD. Default today.'),
    },
    prepare: (input) => ({
      ...input,
      start_date: input.start_date ?? isoDaysAgo(365),
      end_date: input.end_date ?? isoDaysAgo(0),
    }),
  }),
  endpointTool({
    id: 'get_price_performance',
    name: 'price_performance',
    domain: 'price',
    title: 'Price performance',
    summary: 'Return of one symbol over standard windows (1D, 1W, 1M, 3M, YTD, 1Y, 3Y, 5Y).',
  }),
  endpointTool({
    id: 'get_seasonality',
    name: 'price_seasonality',
    domain: 'price',
    title: 'Seasonality',
    summary: 'Average monthly return of one symbol over past years (Seasonality tab).',
  }),
  endpointTool({
    id: 'get_seasonality_years',
    name: 'price_seasonality_years',
    domain: 'price',
    title: 'Seasonality years',
    summary: 'Which years of seasonality data exist for one symbol.',
  }),
  endpointTool({
    id: 'chartbit_daily_bars',
    name: 'price_daily_bars',
    domain: 'price',
    title: 'Daily OHLCV bars',
    summary: 'Daily candles (open, high, low, close, volume, value) of one symbol between two dates, for charting and indicators.',
    omit: ['from', 'to'],
    extra: {
      start_date: dateInput.optional().describe('Oldest date, YYYY-MM-DD. Default one year ago.'),
      end_date: dateInput.optional().describe('Newest date, YYYY-MM-DD. Default today.'),
    },
    // Chartbit's `from` is the newest bound and `to` the oldest.
    prepare: ({ start_date, end_date, ...rest }) => ({
      ...rest,
      from: (end_date as string | undefined) ?? isoDaysAgo(0),
      to: (start_date as string | undefined) ?? isoDaysAgo(365),
    }),
  }),
  endpointTool({
    id: 'chartbit_intraday_bars',
    name: 'price_intraday_bars',
    domain: 'price',
    title: 'Intraday bars',
    summary: 'Intraday candles of one symbol between two dates.',
    notes: 'Use short ranges (a few days): intraday history is long.',
    omit: ['from', 'to'],
    extra: {
      start_date: dateInput.optional().describe('Oldest date, YYYY-MM-DD. Default yesterday.'),
      end_date: dateInput.optional().describe('Newest date, YYYY-MM-DD. Default today.'),
    },
    // Unlike the daily bars, intraday bounds are unix seconds (still newest first).
    prepare: ({ start_date, end_date, ...rest }) => ({
      ...rest,
      from: jakartaUnix((end_date as string | undefined) ?? isoDaysAgo(0), 'end'),
      to: jakartaUnix((start_date as string | undefined) ?? isoDaysAgo(1), 'start'),
    }),
  }),
  endpointTool({
    id: 'get_daily_chart',
    name: 'price_chart',
    domain: 'price',
    title: 'Price line chart',
    summary: 'The price line of one symbol for a timeframe (today, 1w, 1m, 3m, ytd, 1y, 3y, 5y), as on the stock page.',
  }),
  endpointTool({
    id: 'get_ihsg_daily_chart',
    name: 'price_ihsg_chart',
    domain: 'price',
    title: 'IHSG (composite) chart',
    summary: 'The Jakarta Composite Index (IHSG) line for a timeframe.',
  }),
  endpointTool({
    id: 'chartbit_corp_action_events',
    name: 'price_corp_action_marks',
    domain: 'price',
    title: 'Corporate action marks on the chart',
    summary: 'Dividends, splits, rights and other corporate actions of one symbol between two dates, as chart markers.',
    override: { symbol: z.string().min(1) },
  }),
];
