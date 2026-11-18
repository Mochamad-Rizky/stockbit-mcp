import { ceilTick, floorTick, tickDown } from '../core/ticks.js';
import type { WatchConfig } from './config.js';
import type { Action, Signal } from './types.js';

// The trade plan printed in an alert: where to buy, where the idea is wrong, where to take profit,
// and how many lots the risk budget allows. Every price is on the IDX grid and inside ARB-ARA.

export interface TradePlan {
  action: Action;
  entryLow: number;
  entryHigh: number;
  stop: number;
  tp1: number;
  tp2: number;
  rr: number;
  lots: number;
  riskIdr: number;
  lotBasis: 'balance' | 'fixed';
  waitPrice?: number;
  note?: string;
}

export interface PlanContext {
  ara?: number;
  arb?: number;
  // Cash trading balance (never margin buying power).
  cash?: number;
  // Traded value over the last 5 minutes, for the liquidity cap.
  value5m?: number;
  cfg: WatchConfig;
}

export function makePlan(sig: Signal, ctx: PlanContext): TradePlan {
  const { refs } = sig;
  const cfg = ctx.cfg;
  const clamp = (p: number) => {
    let v = p;
    if (ctx.ara !== undefined) v = Math.min(v, ctx.ara);
    if (ctx.arb !== undefined) v = Math.max(v, ctx.arb);
    return v;
  };

  let waitPrice: number | undefined;
  if (sig.action === 'TUNGGU') waitPrice = floorTick(refs.bidWall ?? refs.vwap ?? refs.last);
  const entryHigh = clamp(waitPrice ?? floorTick(refs.last));
  const entryLow = clamp(tickDown(entryHigh));

  let stop: number;
  if (sig.style === 'swing') {
    const cands = [refs.swingLow !== undefined ? tickDown(refs.swingLow) : undefined, refs.ma20 !== undefined ? floorTick(refs.ma20) : undefined]
      .filter((x): x is number => x !== undefined && x < entryLow);
    stop = cands.length ? Math.max(...cands) : floorTick(entryLow * 0.97);
  } else {
    const room = tickDown(entryLow, 2);
    const cands = [refs.bidWall, refs.dayLow, refs.vwap]
      .filter((x): x is number => x !== undefined && x > 0)
      .map((x) => tickDown(x))
      .filter((x) => x <= room);
    stop = cands.length ? Math.max(...cands) : floorTick(entryLow * 0.97);
  }
  stop = clamp(stop);

  const r = entryHigh - stop;
  let tp1 = ceilTick(entryHigh + 1.5 * Math.max(r, 0));
  const tp2 = clamp(ceilTick(entryHigh + 2.5 * Math.max(r, 0)));
  const cap = sig.style === 'swing' ? refs.nDayHigh : refs.offerWall;
  if (cap !== undefined && cap > entryHigh && cap < tp1) tp1 = tickDown(cap);
  tp1 = clamp(tp1);

  const pct = sig.style === 'exit' ? cfg.risk.pct.day : cfg.risk.pct[sig.style];
  const riskIdr = (ctx.cash ?? cfg.risk.fixedIdr) * pct;
  const plan: TradePlan = {
    action: sig.action,
    entryLow,
    entryHigh,
    stop,
    tp1,
    tp2,
    rr: r > 0 ? Math.round(((tp1 - entryHigh) / r) * 10) / 10 : 0,
    lots: 0,
    riskIdr,
    lotBasis: ctx.cash === undefined ? 'fixed' : 'balance',
    ...(waitPrice === undefined ? {} : { waitPrice: entryHigh }),
  };
  if (r <= 0) return { ...plan, note: 'Stop terlalu dekat; tentukan sendiri' };
  const caps = [riskIdr / (r * 100)];
  if (ctx.cash !== undefined) caps.push(ctx.cash / (entryHigh * 100));
  if (ctx.value5m !== undefined && ctx.value5m > 0) caps.push((cfg.risk.liquidityShare * ctx.value5m) / (entryHigh * 100));
  const lots = Math.max(0, Math.floor(Math.min(...caps)));
  return lots > 0 ? { ...plan, lots } : { ...plan, note: 'Risiko per trade terlalu kecil untuk 1 lot' };
}
