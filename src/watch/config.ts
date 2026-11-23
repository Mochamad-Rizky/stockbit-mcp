import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

// ~/.stockbit-mcp/watch.json: the bot's settings. Every key has a default, so the file only needs
// what the user changes. It can hold the Telegram token, so it is written readable by the user only.

const share = z.number().min(0).max(1);
const positive = z.number().positive();
const count = z.number().int().min(0);

export const WatchConfigSchema = z.object({
  telegram: z.object({ token: z.string().min(1).optional(), chatId: z.string().min(1).optional() }).prefault({}),
  macos: z.boolean().default(true),
  styles: z
    .object({ scalp: z.boolean().default(true), day: z.boolean().default(true), swing: z.boolean().default(true), exit: z.boolean().default(true) })
    .prefault({}),
  risk: z
    .object({
      pct: z.object({ scalp: share.default(0.01), day: share.default(0.01), swing: share.default(0.01) }).prefault({}),
      fixedIdr: positive.default(10_000_000),
      holdingStopPct: share.default(0.05),
      liquidityShare: share.default(0.05),
    })
    .prefault({}),
  alerts: z
    .object({
      cooldownSec: count.default(600),
      rescoreJump: count.default(15),
      dailyCap: count.default(30),
      minValue5m: count.default(50_000_000),
      // 'relevant': distribution (HINDARI) only on watchlist stocks and stocks the bot flagged as a buy
      // today (holdings get their own exit alerts); 'all': on any stock.
      distributionScope: z.enum(['relevant', 'all']).default('relevant'),
    })
    .prefault({}),
  thresholds: z.object({ scalp: count.default(70), day: count.default(65), swing: count.default(60) }).prefault({}),
  scanner: z
    .object({ size: count.default(5), recomputeSec: positive.default(30), enterMargin: share.default(0.1), minStaySec: count.default(120) })
    .prefault({}),
  scalp: z
    .object({
      sweepWindowSec: positive.default(10),
      sweepMinLevels: count.default(2),
      sweepMinValueX: positive.default(2),
      thinWindowSec: positive.default(60),
      thinDrop: share.default(0.5),
      bigLotPct: share.default(0.99),
      bigLotCount: count.default(3),
      bigLotWindowSec: positive.default(30),
    })
    .prefault({}),
  day: z
    .object({
      rvolMin: positive.default(3),
      hakaMin: share.default(0.6),
      breakoutMinRvol: positive.default(2),
      accumRangeTicks: count.default(3),
      accumRvolMin: positive.default(2),
      accumHakiMin: share.default(0.55),
      distHakiMin: share.default(0.65),
      extendedPct: share.default(0.04),
    })
    .prefault({}),
  book: z
    .object({ wallFactor: positive.default(5), wallPersistSec: count.default(20), accumWallPersistSec: count.default(60) })
    .prefault({}),
  // Liquid stocks (20-day average value ≥ liquidMin) get their own shortlist, so the order book and
  // scalp setups reach them even when gorengan fill the momentum top 5. Their RVOL counts rvolScale
  // times and their HAKA share hakaShift higher: big caps trade two-sided all day, so 2x and 65%
  // there move more money than 3x and 75% on a thin stock. Stocks under thinMax lose points: a 5%
  // share of their tape buys only a handful of lots.
  liquidity: z
    .object({
      liquidMin: positive.default(20_000_000_000),
      thinMax: z.number().min(0).default(1_000_000_000),
      rvolScale: positive.default(1.5),
      hakaShift: share.default(0.1),
      shortlist: count.default(5),
    })
    .prefault({}),
  // The bot is blind while the feed carries no trades in a session: tell the user after staleSec.
  feed: z.object({ staleSec: positive.default(90) }).prefault({}),
  swing: z.object({ maxSymbols: count.default(60), topByTape: count.default(30), minGapMs: count.default(1500) }).prefault({}),
});

export type WatchConfig = z.infer<typeof WatchConfigSchema>;

export const watchConfigPath = (home: string) => join(home, 'watch.json');

export function parseWatchConfig(input: unknown): WatchConfig {
  const parsed = WatchConfigSchema.safeParse(input ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid watch.json: ${issues}`);
  }
  return parsed.data;
}

export async function loadWatchConfig(home: string): Promise<WatchConfig> {
  let text: string;
  try {
    text = await readFile(watchConfigPath(home), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return parseWatchConfig({});
    throw error;
  }
  return parseWatchConfig(JSON.parse(text) as unknown);
}

export async function saveWatchConfig(home: string, cfg: WatchConfig): Promise<void> {
  await mkdir(home, { recursive: true });
  const path = watchConfigPath(home);
  await writeFile(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  await chmod(path, 0o600);
}
