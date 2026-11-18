import { dec1, idNum, rupiahShort, signedPct } from '../fmt.js';
import type { Alert, Style } from '../types.js';

// Alert text: the full message for Telegram and a short one for the macOS notification.

const EMOJI: Record<Style, string> = { scalp: '🔥', day: '⚡', swing: '📈', exit: '🚨' };
const PCT = new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 });
const JAKARTA_MS = 7 * 3_600_000;

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;
const hhmmss = (ms: number) => new Date(ms + JAKARTA_MS).toISOString().slice(11, 19);

function actionLine(a: Alert): string {
  const { signal: s, plan: p } = a;
  if (!p || s.action === 'HINDARI' || s.action === 'JUAL' || s.action === 'AMANKAN') return `AKSI: ${s.action}`;
  const head = s.action === 'TUNGGU' ? `TUNGGU di ${idNum(p.waitPrice ?? p.entryHigh)}` : `${s.action} ${idNum(p.entryLow)}–${idNum(p.entryHigh)}`;
  const sl = `SL ${idNum(p.stop)} (${signedPct((p.stop - p.entryHigh) / p.entryHigh)})`;
  return `AKSI: ${head} · ${sl} · TP1 ${idNum(p.tp1)} · TP2 ${idNum(p.tp2)} · R:R 1:${dec1(p.rr)}`;
}

function lotLine(a: Alert): string | undefined {
  const p = a.plan;
  if (!p || a.signal.action === 'HINDARI' || a.signal.style === 'exit') return undefined;
  if (p.note) return `Lot: ${idNum(p.lots)} (${p.note})`;
  const basis = p.lotBasis === 'balance' ? 'saldo trading' : 'modal tetap';
  return `Lot: ${idNum(p.lots)} (risiko ${PCT.format(p.riskPct * 100)}% = ${rupiahShort(p.riskIdr)} dari ${basis})`;
}

export function formatTelegram(a: Alert, at: number): string {
  const s = a.signal;
  const lines = [
    `${EMOJI[s.style]} [${s.style.toUpperCase()}] ${s.symbol} ${idNum(a.price.last)} (${signedPct(a.price.changePct)}) — ${s.title}`,
    actionLine(a),
  ];
  const lot = lotLine(a);
  if (lot) lines.push(lot);
  for (const f of s.facts) lines.push(`• ${f}`);
  if (s.style !== 'exit') {
    lines.push(`Skor ${a.score}/100: ${s.components.map((c) => `${c.label} ${signed(c.points)}`).join(' · ')}`);
  }
  const ara = a.risk.toAraPct === undefined ? '?' : `${a.risk.toAraPct >= 0 ? '+' : '−'}${idNum(Math.abs(a.risk.toAraPct) * 100)}%`;
  lines.push(
    `⚠️ Notasi: ${a.risk.notations.length ? a.risk.notations.join(', ') : '–'} · UMA: ${a.risk.uma ? 'ya' : 'tidak'} · ke ARA: ${ara} · Sinyal aturan, bukan saran.`,
  );
  lines.push(hhmmss(at));
  return lines.join('\n');
}

export function formatMacos(a: Alert): { title: string; body: string } {
  const s = a.signal;
  const p = a.plan;
  const title = `${EMOJI[s.style]} ${s.symbol} — ${s.title}`;
  if (!p || s.action === 'HINDARI' || s.style === 'exit') return { title, body: s.action };
  const entry = s.action === 'TUNGGU' ? `TUNGGU di ${idNum(p.entryHigh)}` : `${s.action} ${idNum(p.entryLow)}–${idNum(p.entryHigh)}`;
  return { title, body: `${entry} · SL ${idNum(p.stop)} · TP1 ${idNum(p.tp1)} · skor ${a.score}` };
}
