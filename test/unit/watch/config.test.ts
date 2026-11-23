import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWatchConfig, saveWatchConfig } from '../../../src/watch/config.js';

const home = () => mkdtempSync(join(tmpdir(), 'watchcfg-'));

describe('watch config', () => {
  it('fills defaults for a missing file', async () => {
    const cfg = await loadWatchConfig(home());
    expect(cfg.macos).toBe(true);
    expect(cfg.telegram).toEqual({});
    expect(cfg.styles).toEqual({ scalp: true, day: true, swing: true, exit: true });
    expect(cfg.risk).toEqual({ pct: { scalp: 0.01, day: 0.01, swing: 0.01 }, fixedIdr: 10_000_000, holdingStopPct: 0.05, liquidityShare: 0.05 });
    expect(cfg.alerts).toEqual({ cooldownSec: 600, rescoreJump: 15, dailyCap: 30, minValue5m: 50_000_000, distributionScope: 'relevant' });
    expect(cfg.thresholds).toEqual({ scalp: 70, day: 65, swing: 60 });
    expect(cfg.scanner).toEqual({ size: 5, recomputeSec: 30, enterMargin: 0.1, minStaySec: 120 });
    expect(cfg.scalp).toEqual({ sweepWindowSec: 10, sweepMinLevels: 2, sweepMinValueX: 2, thinWindowSec: 60, thinDrop: 0.5, bigLotPct: 0.99, bigLotCount: 3, bigLotWindowSec: 30 });
    expect(cfg.day).toEqual({ rvolMin: 3, hakaMin: 0.6, breakoutMinRvol: 2, accumRangeTicks: 3, accumRvolMin: 2, accumHakiMin: 0.55, distHakiMin: 0.65, extendedPct: 0.04 });
    expect(cfg.book).toEqual({ wallFactor: 5, wallPersistSec: 20, accumWallPersistSec: 60 });
    expect(cfg.swing).toEqual({ maxSymbols: 60, topByTape: 30, minGapMs: 1500 });
    expect(cfg.liquidity).toEqual({ liquidMin: 20_000_000_000, thinMax: 1_000_000_000, rvolScale: 1.5, hakaShift: 0.1, shortlist: 5 });
    expect(cfg.feed).toEqual({ staleSec: 90 });
  });

  it('keeps user values and fills the rest', async () => {
    const h = home();
    writeFileSync(join(h, 'watch.json'), JSON.stringify({ alerts: { dailyCap: 10 }, risk: { pct: { scalp: 0.005 } } }));
    const cfg = await loadWatchConfig(h);
    expect(cfg.alerts.dailyCap).toBe(10);
    expect(cfg.alerts.cooldownSec).toBe(600);
    expect(cfg.risk.pct).toEqual({ scalp: 0.005, day: 0.01, swing: 0.01 });
  });

  it('writes the file private', async () => {
    const h = home();
    const cfg = await loadWatchConfig(h);
    await saveWatchConfig(h, { ...cfg, telegram: { token: 't', chatId: '1' } });
    expect(statSync(join(h, 'watch.json')).mode & 0o777).toBe(0o600);
    expect((await loadWatchConfig(h)).telegram).toEqual({ token: 't', chatId: '1' });
  });

  it('rejects a negative risk pct with a message naming the key', async () => {
    const h = home();
    writeFileSync(join(h, 'watch.json'), JSON.stringify({ risk: { pct: { day: -0.01 } } }));
    await expect(loadWatchConfig(h)).rejects.toThrow(/risk\.pct\.day/);
  });
});
