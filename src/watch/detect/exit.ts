import { ceilTick, floorTick, tickDown } from '../../core/ticks.js';
import type { WatchConfig } from '../config.js';
import { idNum } from '../fmt.js';
import type { SymbolTape } from '../market/tape.js';
import type { Holding } from '../rest.js';
import type { PlanRefs, Signal } from '../types.js';
import { isDistribution } from './intraday.js';

// Warnings for stocks the user holds: stop broken, first target reached, distribution on the tape.

export interface HoldingLevels {
  stop: number;
  tp1: number;
  tp2: number;
}

// Stop: whichever is nearer below the price of (average −holdingStopPct) and a holding bid wall
// (one tick under). The day's low is not used: it trails the price by construction, so a stop under
// it would never be hit. Targets: 1.5R and 2.5R from the average price. The caller computes this once
// per holding per day and keeps it.
export function holdingPlan(h: Holding, refs: PlanRefs, cfg: WatchConfig): HoldingLevels {
  const byPct = floorTick(h.avgPrice * (1 - cfg.risk.holdingStopPct));
  const structure = [refs.bidWall].filter((x): x is number => x !== undefined && x > 0);
  const candidates = [byPct, ...(structure.length ? [tickDown(Math.max(...structure))] : [])];
  const below = candidates.filter((c) => c < refs.last);
  const stop = Math.max(...(below.length ? below : candidates));
  const r = h.avgPrice - stop > 0 ? h.avgPrice - stop : h.avgPrice * cfg.risk.holdingStopPct;
  return { stop, tp1: ceilTick(h.avgPrice + 1.5 * r), tp2: ceilTick(h.avgPrice + 2.5 * r) };
}

// Stop and target fire when the price crosses them since the previous look (`prevLast`), so a level
// a holding was already past when the bot started does not alert; the first look only records.
export function detectExit(
  h: Holding,
  tape: SymbolTape,
  plan: HoldingLevels,
  now: number,
  cfg: WatchConfig,
  prevLast: number | undefined,
): Signal[] {
  const last = tape.day().last;
  if (!last) return [];
  const held = `Kamu pegang ${idNum(h.lots)} lot, rata-rata ${idNum(h.avgPrice)}`;
  const refs: PlanRefs = { last, dayLow: tape.day().low };
  const base = { style: 'exit' as const, symbol: h.symbol, components: [], at: now, refs };
  const out: Signal[] = [];
  if (prevLast !== undefined && prevLast > plan.stop && last <= plan.stop) {
    out.push({ ...base, setup: 'exit_stop', title: 'Tembus stop', action: 'JUAL', facts: [held, `Harga ${idNum(last)} ≤ stop ${idNum(plan.stop)}`] });
  } else if (prevLast !== undefined && prevLast < plan.tp1 && last >= plan.tp1) {
    out.push({
      ...base, setup: 'exit_target', title: 'Target tercapai', action: 'AMANKAN',
      facts: [held, `Harga ${idNum(last)} ≥ TP1 ${idNum(plan.tp1)} (TP2 ${idNum(plan.tp2)})`],
    });
  }
  if (isDistribution(tape, now, cfg)) {
    out.push({ ...base, setup: 'exit_distribution', title: 'Distribusi di saham kamu', action: 'AMANKAN', facts: [held, 'HAKI lot besar mendominasi 15 menit terakhir'] });
  }
  return out;
}
