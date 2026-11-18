// Shared types of the watch bot.

export interface Trade {
  symbol: string;
  price: number;
  // IDX trades are counted in shares; one lot is 100 shares.
  shares: number;
  value: number;
  // 'buy' = buyer-initiated (HAKA), 'sell' = seller-initiated (HAKI).
  side: 'buy' | 'sell' | 'none';
  // Exchange time, ms since epoch.
  time: number;
  tradeNo: number;
  board: number;
}

export interface BookLevel {
  price: number;
  orders: number;
  shares: number;
}

export interface BookSide {
  symbol: string;
  side: 'bid' | 'offer';
  levels: BookLevel[];
  time: number;
  total: number;
}

export interface LivePrice {
  symbol: string;
  last: number;
  prev: number;
  open: number;
  high: number;
  low: number;
  value: number;
  volume: number;
  changePct: number;
  time: number;
}

export type FeedEvent =
  | { kind: 'trades'; trades: Trade[] }
  | { kind: 'book'; book: BookSide }
  | { kind: 'price'; price: LivePrice }
  | { kind: 'pong' }
  | { kind: 'error'; code: number; message: string }
  | { kind: 'unknown'; field: number };

// What the bot subscribes to on the datafeed.
export interface Channels {
  runningTradeBatch: string[];
  orderBook: string[];
  livePrice: string[];
}

export type Style = 'scalp' | 'day' | 'swing' | 'exit';

export type Setup =
  | 'haka_sweep'
  | 'offer_thinning'
  | 'big_lot_burst'
  | 'rvol_spike'
  | 'day_high_break'
  | 'accumulation'
  | 'markup'
  | 'distribution'
  | 'swing_accumulation'
  | 'exit_distribution'
  | 'exit_stop'
  | 'exit_target';

export type Action = 'BELI' | 'TUNGGU' | 'HINDARI' | 'JUAL' | 'AMANKAN';

export interface ScoreComponent {
  label: string;
  points: number;
}

// Price levels a signal saw, for the trade plan.
export interface PlanRefs {
  last: number;
  vwap?: number;
  dayLow?: number;
  bidWall?: number;
  offerWall?: number;
  swingLow?: number;
  ma20?: number;
  nDayHigh?: number;
}

export interface Signal {
  style: Style;
  symbol: string;
  setup: Setup;
  // Indonesian, shown in the notification.
  title: string;
  action: Action;
  facts: string[];
  components: ScoreComponent[];
  at: number;
  refs: PlanRefs;
}

export interface RiskLabels {
  notations: string[];
  uma: boolean;
  toAraPct?: number;
  fca: boolean;
}

// A signal that passed its threshold, with its plan, ready to send.
export interface Alert {
  signal: Signal;
  score: number;
  plan?: import('./plan.js').TradePlan;
  risk: RiskLabels;
  // changePct is a fraction of the previous close (0.038 = +3.8%).
  price: { last: number; changePct: number };
}
