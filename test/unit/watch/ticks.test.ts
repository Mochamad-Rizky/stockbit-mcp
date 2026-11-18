import { ceilTick, floorTick, nearestTicks, onTick, tickDown, tickSize, tickUp } from '../../../src/core/ticks.js';

describe('IDX tick grid', () => {
  it('moves along the IDX grid across band edges', () => {
    expect(tickUp(199)).toBe(200);
    expect(tickUp(200)).toBe(202);
    expect(tickDown(200)).toBe(199);
    expect(tickUp(498, 2)).toBe(505);
    expect(tickDown(5000)).toBe(4990);
    expect(tickUp(5000)).toBe(5025);
    expect(floorTick(1003)).toBe(1000);
    expect(ceilTick(1003)).toBe(1005);
    expect(floorTick(201)).toBe(200);
    expect(onTick(201)).toBe(false);
    expect(onTick(tickUp(4975, 3))).toBe(true);
  });

  it('never loops on a non-finite price', () => {
    expect(floorTick(Number.NaN)).toBeNaN();
    expect(ceilTick(Number.NaN)).toBeNaN();
    expect(tickUp(Number.NaN)).toBeNaN();
    expect(tickDown(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
  });

  it('snaps an off-grid price before stepping', () => {
    expect(tickUp(1003)).toBe(1005);
    expect(tickDown(1003)).toBe(1000);
    expect(tickSize(150)).toBe(1);
    expect(tickSize(200)).toBe(2);
    expect(nearestTicks(9512)).toEqual([9500, 9525]);
  });
});
