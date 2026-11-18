import { tickDistance, tickUp } from '../../core/ticks.js';
import type { WatchConfig } from '../config.js';
import { dec1, idNum, pct0, rupiahShort } from '../fmt.js';
import type { SymbolBook } from '../market/book.js';
import type { SymbolTape } from '../market/tape.js';
import { accumulationScore } from '../scanner.js';
import { comp, hakaPoints, POINTS, rvolPoints, sweepPoints } from '../score.js';
import type { Action, PlanRefs, Setup, Signal, Style } from '../types.js';
import type { StockInfo } from '../universe.js';

// Scalping and day-trading setups, read from the tape and (for focus stocks) the order book. The
// thresholds come from watch.json; the reasoning behind each rule is in the design doc.

export interface IntradayInput {
  symbol: string;
  tape: SymbolTape;
  book?: SymbolBook;
  info: StockInfo;
  expectedPerMin: number;
  cfg: WatchConfig;
  // When the accumulation setup last fired on this stock, and the top of its range then.
  accumulatedAt?: number;
  accumulationTop?: number;
}

export const FCA_FACT = 'Papan pemantauan khusus (lelang berkala)';
const BUY_SETUPS = new Set<Setup>(['haka_sweep', 'offer_thinning', 'big_lot_burst', 'rvol_spike', 'day_high_break', 'markup']);
const MARKUP_WINDOW_MS = 30 * 60_000;

const JAKARTA_MS = 7 * 3_600_000;
// Whether the tape holds the stock's opening trades (first trade by 09:05 Jakarta). The day's open,
// high and low are only known then; a bot started mid-session must not treat "since I started" as
// "today".
export function sawOpen(tape: SymbolTape): boolean {
  if (!tape.firstTime) return false;
  const d = new Date(tape.firstTime + JAKARTA_MS);
  return d.getUTCHours() * 60 + d.getUTCMinutes() <= 9 * 60 + 5;
}

// Distribution: over 15 minutes the price held or rose while big seller-initiated lots dominated,
// on a stock that has already run at least 3 ticks above its open (distribution follows a markup).
export function isDistribution(tape: SymbolTape, now: number, cfg: WatchConfig): boolean {
  const w = tape.window(900, now);
  if (w.trades === 0) return false;
  const haki = 1 - tape.hakaShare(900, now);
  return (
    sawOpen(tape) && w.last >= w.first && haki >= cfg.day.distHakiMin && w.bigSells >= 3 && tickDistance(tape.day().open, w.last) >= 3
  );
}

export function detectIntraday(input: IntradayInput, now: number): Signal[] {
  const { tape, book, info, expectedPerMin: e, cfg } = input;
  const w5 = tape.window(300, now);
  if (w5.value < cfg.alerts.minValue5m || e <= 0) return [];
  const w15 = tape.window(900, now);
  const day = tape.day();
  const last = w5.last || day.last;
  const rvol5 = w5.value / (5 * e);
  const haka5 = tape.hakaShare(300, now);
  const haka15 = tape.hakaShare(900, now);

  const solidBids = book?.walls('bid', cfg.book.wallPersistSec, now) ?? [];
  const solidOffers = book?.walls('offer', cfg.book.wallPersistSec, now) ?? [];
  const bidWall = solidBids.filter((w) => w.price <= last).sort((a, b) => b.price - a.price)[0];
  const offerWall = solidOffers.filter((w) => w.price > last).sort((a, b) => a.price - b.price)[0];
  const refs: PlanRefs = { last, vwap: day.vwap, dayLow: day.low };
  if (bidWall) refs.bidWall = bidWall.price;
  if (offerWall) refs.offerWall = offerWall.price;

  const fiveMinFact = `5 menit: ${rupiahShort(w5.value)} (RVOL ${dec1(rvol5)}x), HAKA ${pct0(haka5)}`;
  const bidNear = bidWall && tickDistance(bidWall.price, last) <= 3 ? bidWall : undefined;
  const bidFact = bidNear
    ? `Bid tebal di ${idNum(bidNear.price)}: ${idNum(bidNear.shares / 100)} lot, bertahan ${ageText(now - bidNear.since)}`
    : undefined;
  const thin = book ? book.offerThinning(3, cfg.scalp.thinWindowSec, now) : 0;
  const extended = day.vwap > 0 && last > day.vwap * (1 + cfg.day.extendedPct);

  const out: Signal[] = [];
  const add = (style: Style, setup: Setup, title: string, action: Action, facts: (string | undefined)[], components: Signal['components']) => {
    if (!cfg.styles[style]) return;
    let act = action;
    if (BUY_SETUPS.has(setup) && act === 'BELI' && extended) act = 'TUNGGU';
    const f = facts.filter((x): x is string => Boolean(x));
    if (info.fca) f.push(FCA_FACT);
    out.push({ style, symbol: input.symbol, setup, title, action: act, facts: f, components, at: now, refs: { ...refs } });
  };

  if (!info.fca) {
    // HAKA sweep: buyers take out several offer levels within seconds, on real money.
    const ws = tape.window(cfg.scalp.sweepWindowSec, now);
    const levels = book?.bestOffer() ? book.levelsTakenAbove(ws.first) : ws.buyValue > ws.sellValue ? tickDistance(ws.first, ws.last) : 0;
    if (ws.trades > 0 && ws.buyValue >= cfg.scalp.sweepMinValueX * e && levels >= cfg.scalp.sweepMinLevels) {
      const to = book?.bestOffer()?.price ?? ws.last;
      add('scalp', 'haka_sweep', 'HAKA sapu offer', 'BELI',
        [fiveMinFact, `Sapu ${levels} level offer ${idNum(ws.first)}→${idNum(to)}, lot terbesar ${idNum(ws.maxLot)}`,
          thin >= cfg.scalp.thinDrop ? `Offer 3 level teratas −${pct0(thin)} dalam ${cfg.scalp.thinWindowSec} detik` : undefined, bidFact],
        [...comp('RVOL', rvolPoints(rvol5)), ...comp('HAKA', hakaPoints(haka5)), ...comp('sapu', sweepPoints(levels)),
          ...comp('bid', bidNear ? POINTS.bidWall : 0), ...comp('offer tipis', thin >= cfg.scalp.thinDrop ? POINTS.offerThin : 0)]);
    }

    // Offer thinning: the offers just above the price melt away while the price does not fall.
    const wt = tape.window(cfg.scalp.thinWindowSec, now);
    if (book && thin >= cfg.scalp.thinDrop && wt.trades > 0 && wt.last >= wt.first) {
      add('scalp', 'offer_thinning', 'Offer menipis', 'BELI',
        [fiveMinFact, `Offer 3 level teratas −${pct0(thin)} dalam ${cfg.scalp.thinWindowSec} detik`, bidFact],
        [...comp('offer tipis', POINTS.offerThin), ...comp('RVOL', rvolPoints(rvol5)), ...comp('HAKA', hakaPoints(haka5)),
          ...comp('bid', bidNear ? POINTS.bidWall : 0)]);
    }

    // Big-lot burst: several of the day's biggest buy lots in a short span.
    const wb = tape.window(cfg.scalp.bigLotWindowSec, now);
    if (wb.bigBuys >= cfg.scalp.bigLotCount) {
      add('scalp', 'big_lot_burst', 'Lot besar beruntun', 'BELI',
        [fiveMinFact, `${wb.bigBuys} lot besar beli dalam ${cfg.scalp.bigLotWindowSec} detik (≥${idNum(tape.lotPercentile(cfg.scalp.bigLotPct))} lot)`, bidFact],
        [...comp('lot besar', POINTS.bigLots), ...comp('RVOL', rvolPoints(rvol5)), ...comp('HAKA', hakaPoints(haka5)),
          ...comp('bid', bidNear ? POINTS.bidWall : 0)]);
    }
  }

  // RVOL spike: unusual money, buyers in control, price up.
  if (rvol5 >= cfg.day.rvolMin && haka15 >= cfg.day.hakaMin && last > w15.first) {
    add('day', 'rvol_spike', 'Volume meledak', 'BELI', [fiveMinFact, `HAKA 15 menit ${pct0(haka15)}`, bidFact],
      [...comp('RVOL', rvolPoints(rvol5)), ...comp('HAKA', hakaPoints(haka15)), ...comp('bid', bidNear ? POINTS.bidWall : 0)]);
  }

  if (!info.fca) {
    // Day-high break on volume.
    const before = tape.highBefore(60, now);
    if (sawOpen(tape) && before > 0 && last > before && rvol5 >= cfg.day.breakoutMinRvol) {
      add('day', 'day_high_break', 'Tembus high harian', 'BELI', [fiveMinFact, `Tembus high harian ${idNum(before)} → ${idNum(last)}`, bidFact],
        [...comp('high baru', POINTS.dayHigh), ...comp('RVOL', rvolPoints(rvol5)), ...comp('HAKA', hakaPoints(haka5)),
          ...comp('bid', bidNear ? POINTS.bidWall : 0)]);
    }

    // Accumulation: heavy trading held in a narrow range, sellers absorbed by a bid wall that stays.
    const accWall = (book?.walls('bid', cfg.book.accumWallPersistSec, now) ?? []).filter((w) => w.price <= last).sort((a, b) => b.price - a.price)[0];
    if (accWall && accumulationScore(tape, e, now, cfg) > 0) {
      const rvol15 = w15.value / (15 * e);
      add('day', 'accumulation', 'Akumulasi', 'TUNGGU',
        [`15 menit: ${rupiahShort(w15.value)} (RVOL ${dec1(rvol15)}x) di rentang ${idNum(w15.low)}–${idNum(w15.high)}, HAKI ${pct0(1 - haka15)} diserap`,
          `Bid tebal di ${idNum(accWall.price)}: ${idNum(accWall.shares / 100)} lot, bertahan ${ageText(now - accWall.since)}`],
        [...comp('akumulasi', POINTS.accumulation), ...comp('RVOL', rvolPoints(rvol15)), ...comp('bid', POINTS.bidWall)]);
      out[out.length - 1]!.refs.bidWall = accWall.price;
    }

    // Markup: an accumulated stock breaks out of its range with buyers lifting offers.
    if (input.accumulatedAt !== undefined && input.accumulationTop !== undefined && now - input.accumulatedAt <= MARKUP_WINDOW_MS &&
      haka5 >= 0.7 && last >= tickUp(input.accumulationTop, 2)) {
      add('day', 'markup', 'Markup mulai', 'BELI',
        [fiveMinFact, `Keluar dari rentang akumulasi (atas ${idNum(input.accumulationTop)}), HAKA 5 menit ${pct0(haka5)}`, bidFact],
        [...comp('markup', POINTS.markup), ...comp('RVOL', rvolPoints(rvol5)), ...comp('HAKA', hakaPoints(haka5))]);
    }
  }

  // Distribution, unless the same tape reads as accumulation (a holding bid wall).
  if (!out.some((s) => s.setup === 'accumulation') && isDistribution(tape, now, cfg)) {
    add('day', 'distribution', 'Distribusi', 'HINDARI',
      [`15 menit: HAKI ${pct0(1 - haka15)} dengan ${w15.bigSells} lot jual besar, harga tertahan`, fiveMinFact],
      [...comp('distribusi', POINTS.distribution), ...comp('RVOL', rvolPoints(rvol5))]);
  }
  return out;
}

function ageText(ms: number): string {
  return ms >= 60_000 ? `${Math.floor(ms / 60_000)} menit` : `${Math.floor(ms / 1000)} detik`;
}
