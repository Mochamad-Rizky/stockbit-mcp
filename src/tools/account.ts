import { endpointTool } from './endpoint-tool.js';
import type { AnyToolDefinition } from './types.js';

// The brokerage account (Stockbit Sekuritas, carina): portfolio, orders, balances and history. All
// of these only read, and all need the trading session (`stockbit-mcp login --trading`).

const TRADING = 'Needs the trading session (stockbit-mcp login --trading). Values IDR; lots of 100 shares.';

export const accountTools: AnyToolDefinition[] = [
  endpointTool({
    id: 'get_portfolio_list',
    name: 'account_portfolio',
    domain: 'account',
    title: 'Portfolio positions',
    summary:
      'Every stock held: lots (total, available to sell), average price, last price, market value, ' +
      'unrealized gain/loss and percent.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_portfolio_summary',
    name: 'account_portfolio_summary',
    domain: 'account',
    title: 'Portfolio summary',
    summary: 'Totals of the account: equity, invested, market value, unrealized and today\'s gain/loss, cash.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_portfolio_detail',
    name: 'account_position',
    domain: 'account',
    title: 'Position in one stock',
    summary:
      'The position in one symbol, regular and day-trade: lots held and available to sell (qty.available.lot), ' +
      'average price, gain/loss, whether a smart order can be created.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'list_orders',
    name: 'account_orders',
    domain: 'account',
    title: 'Today\'s orders',
    summary:
      'Orders of the account with status (OPEN, PARTIAL, MATCH, REJECTED, WITHDRAWN …), side, price, ' +
      'lots done/open, amounts and fees, GTC and smart-order details, and what can be amended or cancelled. ' +
      'Use it to confirm the result of order_* calls.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_order_detail',
    name: 'account_order_detail',
    domain: 'account',
    title: 'One order',
    summary: 'Full detail of one order by id, including match times and rejection message.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_buying_power',
    name: 'account_buying_power',
    domain: 'account',
    title: 'Buying power',
    summary:
      'Trading balance, trading limit, day-trade buying power and margin buying power. Pass stock_code to ' +
      'get the figures for that stock.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_cash_on_hand',
    name: 'account_cash',
    domain: 'account',
    title: 'Cash on hand',
    summary: 'Cash available in the RDN account.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_withdrawable_balance',
    name: 'account_withdrawable',
    domain: 'account',
    title: 'Withdrawable balance',
    summary: 'Cash that can be withdrawn now (read only; this server never withdraws).',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_trading_info',
    name: 'account_trading_info',
    domain: 'account',
    title: 'Trading limits and status',
    summary:
      'Trading rules for the account now: day-trade availability, split-order limits, market cycle, ' +
      'order count limits, margin status (choose with features).',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_stock_tradable',
    name: 'account_tradable',
    domain: 'account',
    title: 'Can these stocks be traded?',
    summary: 'For each symbol: tradable, sharia-tradable, margin-tradable, and per board (RG, NG, TN).',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_fee_formula',
    name: 'account_fees',
    domain: 'account',
    title: 'Fee rates',
    summary:
      'The account\'s buy and sell fee rates (broker, exchange, levy, VAT, income tax components) and the ' +
      'formulas the app uses to preview an order.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_transaction_history',
    name: 'account_history',
    domain: 'account',
    title: 'Transaction history',
    summary: 'Past transactions (trades, deposits, withdrawals, dividends …), filterable by stock and period.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_history_detail',
    name: 'account_history_detail',
    domain: 'account',
    title: 'One transaction',
    summary: 'Detail of one history entry.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'list_realized_pnl',
    name: 'account_realized_pnl',
    domain: 'account',
    title: 'Realized profit and loss',
    summary: 'Realized gains and losses of closed trades, filterable by stock and period.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_realized_pnl_detail',
    name: 'account_realized_pnl_detail',
    domain: 'account',
    title: 'Realized P/L detail',
    summary: 'The trades behind one realized P/L entry.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_trade_performance',
    name: 'account_performance_trades',
    domain: 'account',
    title: 'Trading performance',
    summary: 'Win rate and P/L of trades per stock over a period.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_total_equity_return',
    name: 'account_performance_return',
    domain: 'account',
    title: 'Equity return',
    summary: 'Return of the account\'s total equity over time.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_total_equity',
    name: 'account_performance_equity',
    domain: 'account',
    title: 'Total equity history',
    summary: 'Total equity of the account over time.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_cumulative_return',
    name: 'account_performance_cumulative',
    domain: 'account',
    title: 'Cumulative return vs IHSG',
    summary: 'Cumulative return of the portfolio over time, to compare with the index.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_stock_allocation',
    name: 'account_allocation',
    domain: 'account',
    title: 'Stock allocation',
    summary: 'How the portfolio is spread across stocks and sectors.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'list_sub_accounts',
    name: 'account_sub_accounts',
    domain: 'account',
    title: 'Sub-accounts',
    summary: 'The account\'s portfolios (regular, syariah, day-trade, margin) and their balances.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'list_exercises',
    name: 'account_exercises',
    domain: 'account',
    title: 'Rights and warrant exercises',
    summary: 'Exercise requests of rights and warrants.',
    notes: TRADING,
  }),
  endpointTool({
    id: 'get_bond_portfolio',
    name: 'account_bonds',
    domain: 'account',
    title: 'Bond portfolio',
    summary: 'Government bonds held (ORI, SBR, FR …) with coupons.',
    notes: TRADING,
  }),
];
