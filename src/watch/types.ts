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
