import { dec1, idNum, rupiahShort } from '../fmt.js';
import type { Tape } from '../market/tape.js';
import type { Bandar, DailyBarData } from '../rest.js';
import { comp, POINTS } from '../score.js';
import type { WatchConfig } from '../config.js';
import type { Signal } from '../types.js';
import type { StockInfo, Universe } from '../universe.js';

// Swing scan: run a few times a day over a short list, from daily bars, the bandar detector and
// foreign flow.

export type DailyBar = DailyBarData;

// Holdings first, then the accumulation shortlist, the watchlists, then the day's biggest names on
// the tape (value × RVOL), deduplicated and capped.
export function swingList(
  tape: Tape,
  universe: Universe,
  holdings: string[],
  watchlist: string[],
  accumulation: string[],
  cfg: WatchConfig,
): string[] {
  const leaders = tape
    .symbols()
    .map((s) => {
      const value = tape.get(s)!.day().value;
      const ma = universe.get(s)?.valueMa20 ?? 0;
      return { s, rank: ma > 0 ? (value * value) / ma : value };
    })
    .sort((a, b) => b.rank - a.rank)
    .slice(0, cfg.swing.topByTape)
    .map((x) => x.s);
  const out: string[] = [];
  for (const s of [...holdings, ...accumulation, ...watchlist, ...leaders]) {
    if (out.length >= cfg.swing.maxSymbols) break;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export const SWING_POINTS = { base: 35, nearHigh: 10, volume: 10, volumeStrong: 15, bigAcc: 5 } as const;

export function detectSwing(
  symbol: string,
  ctx: { bars: DailyBar[]; bandar?: Bandar; foreign?: number; info?: StockInfo },
  now: number,
): Signal | undefined {
  const { bars, bandar, foreign } = ctx;
  if (bars.length < 15 || !bandar?.accdist || !/^(Big )?Acc$/.test(bandar.accdist)) return undefined;
  const last = bars[bars.length - 1]!;
  const last20 = bars.slice(-20);
  const nDayHigh = Math.max(...last20.map((b) => b.high));
  if (last.close < nDayHigh * 0.97) return undefined;
  const recent = avg(bars.slice(-3).map((b) => b.volume));
  const before = avg(bars.slice(-13, -3).map((b) => b.volume));
  const volRatio = before > 0 ? recent / before : 0;
  if (volRatio < 1.5) return undefined;
  const swingLow = Math.min(...bars.slice(-10).map((b) => b.low));
  const ma20 = avg(last20.map((b) => b.close));
  const buyers = bandar.topBuyers.slice(0, 3).map((b) => b.code);
  const facts = [
    `Bandar detector 7 hari: ${bandar.accdist}`,
    ...(buyers.length ? [`Top buyer: ${buyers.join(', ')}`] : []),
    ...(foreign === undefined ? [] : [`Asing 7 hari: net ${foreign >= 0 ? 'beli' : 'jual'} ${rupiahShort(Math.abs(foreign))}`]),
    `Volume 3 hari ${dec1(volRatio)}x rata-rata 10 hari sebelumnya`,
    `Dekat high 20 hari ${idNum(nDayHigh)}`,
  ];
  return {
    style: 'swing',
    symbol,
    setup: 'swing_accumulation',
    title: 'Akumulasi bandar (swing)',
    action: 'BELI',
    facts,
    components: [
      ...comp('akumulasi swing', SWING_POINTS.base),
      ...comp('dekat high', SWING_POINTS.nearHigh),
      ...comp('volume', volRatio >= 2.5 ? SWING_POINTS.volumeStrong : SWING_POINTS.volume),
      ...comp('broker', POINTS.brokerAcc + (bandar.accdist === 'Big Acc' ? SWING_POINTS.bigAcc : 0)),
      ...comp('asing', foreign !== undefined && foreign > 0 ? POINTS.foreignBuy : 0),
    ],
    at: now,
    refs: { last: last.close, swingLow, ma20, nDayHigh },
  };
}
