import type { Logger } from '../../core/logger.js';
import type { WatchConfig } from '../config.js';
import type { Alert } from '../types.js';
import { formatMacos, formatTelegram } from './format.js';

// Decides whether an alert goes out (cooldown, rescoring, daily cap) and hands it to every sender.
// One sender failing never blocks the others.

export interface Sender {
  name: string;
  send(a: Alert, text: { telegram: string; macos: { title: string; body: string } }): Promise<void>;
  // A plain message that is not an alert (a session notice).
  text?(message: string): Promise<void>;
}

export interface NotifierOptions {
  cfg: WatchConfig;
  senders: Sender[];
  logger: Logger;
  recorder?: { alert(record: object): void };
  now?: () => number;
}

const JAKARTA_MS = 7 * 3_600_000;
const dayOf = (ms: number) => new Date(ms + JAKARTA_MS).toISOString().slice(0, 10);

export class Notifier {
  private readonly last = new Map<string, { at: number; score: number; action: string }>();
  private day = '';
  private count = 0;
  private readonly lastFailureLog = new Map<string, number>();
  private readonly now: () => number;

  constructor(private readonly o: NotifierOptions) {
    this.now = o.now ?? Date.now;
  }

  // Gated on the alert's own time, so a replay (faster than the clock) behaves like the live day.
  async send(a: Alert): Promise<boolean> {
    const now = a.signal.at || this.now();
    const exit = a.signal.style === 'exit';
    const today = dayOf(now);
    if (today !== this.day) {
      this.day = today;
      this.count = 0;
    }
    // Exits are keyed by their setup (stop, target, distribution) and never count toward the cap.
    const key = exit ? `${a.signal.symbol}|exit|${a.signal.setup}` : `${a.signal.symbol}|${a.signal.style}`;
    const prev = this.last.get(key);
    const { cooldownSec, rescoreJump, dailyCap } = this.o.cfg.alerts;
    if (prev && now - prev.at < cooldownSec * 1000 && a.score < prev.score + rescoreJump && a.signal.action === prev.action) return false;
    if (!exit && this.count >= dailyCap) return false;
    this.last.set(key, { at: now, score: a.score, action: a.signal.action });
    if (!exit) this.count += 1;

    const text = { telegram: formatTelegram(a, now), macos: formatMacos(a) };
    await this.fanOut(now, (s) => s.send(a, text));
    this.o.recorder?.alert({ at: now, ...a });
    return true;
  }

  // A message outside the alert gate (no cooldown, no cap).
  async notice(message: string): Promise<void> {
    await this.fanOut(this.now(), (s) => s.text?.(message) ?? Promise.resolve());
  }

  private async fanOut(now: number, call: (s: Sender) => Promise<void>): Promise<void> {
    await Promise.all(
      this.o.senders.map(async (s) => {
        try {
          await call(s);
        } catch (error) {
          const lastLog = this.lastFailureLog.get(s.name) ?? 0;
          if (now - lastLog >= 60_000) {
            this.lastFailureLog.set(s.name, now);
            this.o.logger.warn(`${s.name} notification failed`, { error: error instanceof Error ? error.message : String(error) });
          }
        }
      }),
    );
  }
}
