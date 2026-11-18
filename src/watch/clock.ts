// IDX trading phases in Jakarta time (UTC+7, no daylight saving). Holidays are not known here: on
// one the feed simply carries no trades.

export type Phase = 'closed' | 'preopen' | 'session1' | 'break' | 'session2' | 'preclose' | 'after';

const JAKARTA_MS = 7 * 3_600_000;
const hm = (h: number, m: number) => h * 60 + m;

interface DaySchedule {
  preopen: number;
  open1: number;
  close1: number;
  open2: number;
  close2: number;
  end: number;
}

const MON_THU: DaySchedule = { preopen: hm(8, 45), open1: hm(9, 0), close1: hm(12, 0), open2: hm(13, 30), close2: hm(15, 50), end: hm(16, 0) };
const FRIDAY: DaySchedule = { ...MON_THU, close1: hm(11, 30), open2: hm(14, 0) };

function local(nowMs: number): { day: number; minute: number; midnight: number } {
  const d = new Date(nowMs + JAKARTA_MS);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const midnight = nowMs - (minute * 60_000 + d.getUTCSeconds() * 1000 + d.getUTCMilliseconds());
  return { day: d.getUTCDay(), minute, midnight };
}

function schedule(day: number): DaySchedule | undefined {
  if (day === 0 || day === 6) return undefined;
  return day === 5 ? FRIDAY : MON_THU;
}

export function phaseAt(nowMs: number): Phase {
  const { day, minute } = local(nowMs);
  const s = schedule(day);
  if (!s || minute < s.preopen) return 'closed';
  if (minute < s.open1) return 'preopen';
  if (minute < s.close1) return 'session1';
  if (minute < s.open2) return 'break';
  if (minute < s.close2) return 'session2';
  if (minute < s.end) return 'preclose';
  return 'after';
}

// Lunch break start + 5 min, 15:00 and 16:10 of the Jakarta day of `dateMs`; none on weekends.
export function swingTimes(dateMs: number): number[] {
  const { day, midnight } = local(dateMs);
  const s = schedule(day);
  if (!s) return [];
  return [s.close1 + 5, hm(15, 0), hm(16, 10)].map((m) => midnight + m * 60_000);
}

export const jakartaDate = (ms: number) => new Date(ms + JAKARTA_MS).toISOString().slice(0, 10);
