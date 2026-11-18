// Indonesian number formats for alert text.

const ID0 = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 0 });
const ID1 = new Intl.NumberFormat('id-ID', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const idNum = (n: number) => ID0.format(Math.round(n));
export const dec1 = (n: number) => ID1.format(n);

// Rp120rb, Rp450jt, Rp2,1 M, Rp1,2 T.
export function rupiahShort(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? '−' : '';
  if (a >= 1e12) return `${sign}Rp${dec1(a / 1e12)} T`;
  if (a >= 1e9) return `${sign}Rp${dec1(a / 1e9)} M`;
  if (a >= 1e6) return `${sign}Rp${idNum(a / 1e6)}jt`;
  if (a >= 1e3) return `${sign}Rp${idNum(a / 1e3)}rb`;
  return `${sign}Rp${idNum(a)}`;
}

// +3,8% / −2,9% from a fraction (0.038).
export function signedPct(fraction: number): string {
  const v = fraction * 100;
  return `${v >= 0 ? '+' : '−'}${dec1(Math.abs(v))}%`;
}

// 91% from 0.91.
export const pct0 = (fraction: number) => `${idNum(fraction * 100)}%`;
