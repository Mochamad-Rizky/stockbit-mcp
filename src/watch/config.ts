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
    .object({ cooldownSec: count.default(600), rescoreJump: count.default(15), dailyCap: count.default(30), minValue5m: count.default(50_000_000) })
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
