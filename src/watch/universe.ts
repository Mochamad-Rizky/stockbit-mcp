import type { JsonValue } from '../core/json.js';
import { field, getJson, type Http, list, num } from './rest.js';

// Every listed company with what the bot needs to judge its tape: the 20-day average traded value
// (the RVOL baseline), notations and UMA (risk labels) and whether it trades on the special
// monitoring board (notation X: periodic call auction instead of continuous trading).

export interface StockInfo {
  symbol: string;
  name: string;
  valueMa20: number;
  avgVolume: number;
  marketCap: number;
  notations: string[];
  uma: boolean;
  fca: boolean;
  active: boolean;
}

// Trading minutes of a Monday-Thursday: session 1 09:00-12:00 and session 2 13:30-15:50.
export const TRADING_MINUTES = 320;
// A new listing's baseline is learned from its first 15 minutes.
export const LEARN_MINUTES = 15;

function toInfo(c: JsonValue): StockInfo | undefined {
  const symbol = field(c, 'symbol');
  if (typeof symbol !== 'string' || !symbol) return undefined;
  const notations = list(field(c, 'notations'))
    .map((n) => field(n, 'notation_code'))
    .filter((n): n is string => typeof n === 'string');
  const name = field(c, 'name');
  return {
    symbol,
    name: typeof name === 'string' ? name : symbol,
    valueMa20: num(field(c, 'valuema20')) ?? 0,
    avgVolume: num(field(c, 'avgvolume')) ?? 0,
    marketCap: num(field(c, 'marketcap')) ?? 0,
    notations,
    uma: field(c, 'uma') === true,
    fca: notations.includes('X'),
    active: field(c, 'company_status') === 'STATUS_ACTIVE',
  };
}

export class Universe {
  private readonly learned = new Map<string, number>();

  private constructor(private readonly stocks: Map<string, StockInfo>) {}

  static async load(http: Http): Promise<Universe> {
    const tree = list(await getJson(http, '/emitten/classification/list'));
    const ids = tree.map((n) => num(field(n, 'id'))).filter((n): n is number => n !== undefined);
    const groups = list(await getJson(http, '/emitten/classification/company', { ids }));
    const stocks = new Map<string, StockInfo>();
    for (const g of groups) {
      for (const c of list(field(g, 'companies'))) {
        const info = toInfo(c);
        if (info && !stocks.has(info.symbol)) stocks.set(info.symbol, info);
      }
    }
    return new Universe(stocks);
  }

  static of(stocks: StockInfo[]): Universe {
    return new Universe(new Map(stocks.map((s) => [s.symbol, s])));
  }

  get size(): number {
    return this.stocks.size;
  }

  get(symbol: string): StockInfo | undefined {
    return this.stocks.get(symbol);
  }

  symbols(): string[] {
    return [...this.stocks.keys()];
  }

  // IDR traded per minute on a normal day, or undefined when there is no baseline yet.
  expectedPerMinute(symbol: string): number | undefined {
    const ma = this.stocks.get(symbol)?.valueMa20 ?? 0;
    if (ma > 0) return ma / TRADING_MINUTES;
    return this.learned.get(symbol);
  }

  // For a stock without a 20-day average: its value over its first LEARN_MINUTES minutes, divided by
  // what those minutes weigh in the intraday profile (average-minute units; LEARN_MINUTES if flat).
  learnBaseline(symbol: string, valueFirst15m: number, minutes = LEARN_MINUTES): void {
    if ((this.stocks.get(symbol)?.valueMa20 ?? 0) > 0 || valueFirst15m <= 0 || minutes <= 0) return;
    this.learned.set(symbol, valueFirst15m / minutes);
  }
}
