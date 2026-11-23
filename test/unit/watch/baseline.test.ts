import { flatBaseline, isLiquid, marketBaseline, profileMinutes } from '../../../src/watch/baseline.js';
import { volumeProfileAt } from '../../../src/watch/clock.js';
import { parseWatchConfig } from '../../../src/watch/config.js';
import { liquidityComponents } from '../../../src/watch/score.js';
import { Universe } from '../../../src/watch/universe.js';
import { info } from './tape-helpers.js';

const cfg = parseWatchConfig({});
const J = (s: string) => Date.parse(`${s}+07:00`);

describe('intraday volume profile', () => {
  it('weights the open and the close above the midday lull (Mon-Thu)', () => {
    expect(volumeProfileAt(J('2026-11-19T09:02:00'))).toBe(5);
    expect(volumeProfileAt(J('2026-11-19T09:10:00'))).toBe(3);
    expect(volumeProfileAt(J('2026-11-19T09:17:00'))).toBe(2);
    expect(volumeProfileAt(J('2026-11-19T09:30:00'))).toBe(1.3);
    expect(volumeProfileAt(J('2026-11-19T10:30:00'))).toBe(0.75);
    expect(volumeProfileAt(J('2026-11-19T11:30:00'))).toBe(0.5);
    expect(volumeProfileAt(J('2026-11-19T13:40:00'))).toBe(0.9);
    expect(volumeProfileAt(J('2026-11-19T14:30:00'))).toBe(0.75);
    expect(volumeProfileAt(J('2026-11-19T15:10:00'))).toBe(1.4);
    expect(volumeProfileAt(J('2026-11-19T15:40:00'))).toBe(1.8);
  });

  it('follows the Friday session times', () => {
    expect(volumeProfileAt(J('2026-11-20T11:20:00'))).toBe(0.5);
    expect(volumeProfileAt(J('2026-11-20T14:10:00'))).toBe(0.9);
    expect(volumeProfileAt(J('2026-11-20T15:40:00'))).toBe(1.8);
  });

  it('is neutral outside the continuous sessions', () => {
    expect(volumeProfileAt(J('2026-11-19T12:30:00'))).toBe(1);
    expect(volumeProfileAt(J('2026-11-19T15:55:00'))).toBe(1);
    expect(volumeProfileAt(J('2026-11-22T10:00:00'))).toBe(1);
  });

  it('profile minutes integrate the profile over a window', () => {
    expect(profileMinutes(300, J('2026-11-19T09:05:00'))).toBeCloseTo(25);
    expect(profileMinutes(300, J('2026-11-19T10:30:00'))).toBeCloseTo(3.75);
    // 09:03:30-09:08:30: 1.5 min at 5, 3.5 min at 3
    expect(profileMinutes(300, J('2026-11-19T09:08:30'))).toBeCloseTo(1.5 * 5 + 3.5 * 3);
  });
});

describe('liquidity tiers', () => {
  it('liquid from 20 B a day, thin under 1 B', () => {
    expect(isLiquid(info('BRPT', 192_800_000_000), cfg)).toBe(true);
    expect(isLiquid(info('MIDL', 5_000_000_000), cfg)).toBe(false);
    expect(liquidityComponents(info('BRPT', 192_800_000_000), cfg)).toEqual([{ label: 'likuid', points: 10 }]);
    expect(liquidityComponents(info('MIDL', 5_000_000_000), cfg)).toEqual([]);
    expect(liquidityComponents(info('GRNG', 400_000_000), cfg)).toEqual([{ label: 'tipis', points: -10 }]);
  });

  it('a volume-only cue (rvol spike) earns no liquid bonus: it has no price trigger', () => {
    expect(liquidityComponents(info('BRPT', 192_800_000_000), cfg, 'rvol_spike')).toEqual([]);
    expect(liquidityComponents(info('BRPT', 192_800_000_000), cfg, 'day_high_break')).toEqual([{ label: 'likuid', points: 10 }]);
    expect(liquidityComponents(info('GRNG', 400_000_000), cfg, 'rvol_spike')).toEqual([{ label: 'tipis', points: -10 }]);
  });

  it('a stock without a 20-day average is not called thin', () => {
    expect(liquidityComponents(info('NEWX', 0), cfg)).toEqual([]);
  });
});

describe('baselines', () => {
  it('a flat baseline is the per-minute value times the window', () => {
    expect(flatBaseline(10_000_000)(300, 0)).toBe(50_000_000);
  });

  it('the market baseline follows the profile and eases liquid stocks by rvolScale', () => {
    const u = Universe.of([info('BRPT', 192_800_000_000), info('MIDL', 3_200_000_000), info('NEWX', 0)]);
    const at = J('2026-11-19T10:30:00');
    expect(marketBaseline(u, cfg, 'MIDL')!(300, at)).toBeCloseTo(10_000_000 * 3.75);
    expect(marketBaseline(u, cfg, 'BRPT')!(300, at)).toBeCloseTo(((192_800_000_000 / 320) * 3.75) / cfg.liquidity.rvolScale);
    expect(marketBaseline(u, cfg, 'NEWX')).toBeUndefined();
  });
});
