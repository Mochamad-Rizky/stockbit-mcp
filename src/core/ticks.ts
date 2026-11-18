// IDX price fractions (fraksi harga), as the app's fractionList has them. Shared by the order tools
// and the watch bot.
const TICKS = [
  { max: 200, step: 1 },
  { max: 500, step: 2 },
  { max: 2000, step: 5 },
  { max: 5000, step: 10 },
  { max: Infinity, step: 25 },
] as const;

function stepAbove(price: number): number {
  return TICKS.find((t) => price < t.max)?.step ?? 25;
}

function stepBelow(price: number): number {
  return TICKS.find((t) => price <= t.max)?.step ?? 25;
}

// The step to the next price up.
export function tickSize(price: number): number {
  return stepAbove(price);
}

// A price is on the grid when it is a multiple of the step above it and of the step below it: from
// 200 the price steps up by 2 but down by 1, so 200 is valid and 201 is not.
export function onTick(price: number): boolean {
  return Number.isInteger(price) && price % stepAbove(price) === 0 && price % stepBelow(price) === 0;
}

// The valid prices just below and above an off-grid price, for the error hint.
export function nearestTicks(price: number): [number, number] {
  const step = stepAbove(price);
  const lower = price - (price % step);
  return [lower, lower + step];
}

// The highest valid price at or below `price`.
export function floorTick(price: number): number {
  const p = Math.floor(price);
  if (onTick(p)) return p;
  let lower = p - (p % stepAbove(p));
  while (!onTick(lower)) lower -= 1;
  return lower;
}

// The lowest valid price at or above `price`.
export function ceilTick(price: number): number {
  if (onTick(price)) return price;
  const lower = floorTick(price);
  return lower + stepAbove(lower);
}

// `n` valid prices up; an off-grid start snaps up as the first step.
export function tickUp(price: number, n = 1): number {
  let p = price;
  for (let i = 0; i < n; i += 1) p = onTick(p) ? p + stepAbove(p) : ceilTick(p);
  return p;
}

// `n` valid prices down; an off-grid start snaps down as the first step.
export function tickDown(price: number, n = 1): number {
  let p = price;
  for (let i = 0; i < n; i += 1) p = onTick(p) ? Math.max(1, p - stepBelow(p)) : floorTick(p);
  return p;
}

// Signed number of grid steps from `from` to `to` (both snapped to the grid first).
export function tickDistance(from: number, to: number): number {
  const a = floorTick(Math.min(from, to));
  const b = floorTick(Math.max(from, to));
  let n = 0;
  for (let p = a; p < b && n < 100_000; p = tickUp(p)) n += 1;
  return from <= to ? n : -n;
}
