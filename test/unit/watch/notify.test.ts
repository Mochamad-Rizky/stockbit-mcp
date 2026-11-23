import { createLogger } from '../../../src/core/logger.js';
import { parseWatchConfig } from '../../../src/watch/config.js';
import { formatMacos, formatTelegram } from '../../../src/watch/notify/format.js';
import { macosSender } from '../../../src/watch/notify/macos.js';
import { Notifier, type Sender } from '../../../src/watch/notify/notifier.js';
import { setupTelegram, telegramSender } from '../../../src/watch/notify/telegram.js';
import type { Alert } from '../../../src/watch/types.js';

const AT = Date.parse('2026-11-18T09:33:12+07:00');
const cfg = parseWatchConfig({});

function alert(over: Partial<Alert> = {}): Alert {
  return {
    signal: {
      style: 'scalp', symbol: 'SMRA', setup: 'haka_sweep', title: 'HAKA sapu offer', action: 'BELI', at: AT, refs: { last: 274 },
      facts: ['5 menit: Rp2,1 M (RVOL 6,2x), HAKA 91%', 'Sapu 3 level offer 274→276, lot terbesar 8.140'],
      components: [{ label: 'RVOL', points: 25 }, { label: 'HAKA', points: 20 }, { label: 'sapu', points: 20 }, { label: 'bid', points: 12 }, { label: 'ARA', points: 5 }],
    },
    score: 82,
    plan: { action: 'BELI', entryLow: 272, entryHigh: 274, stop: 266, tp1: 286, tp2: 294, rr: 1.5, lots: 150, riskIdr: 120_000, riskPct: 0.01, lotBasis: 'balance' },
    risk: { notations: [], uma: false, toAraPct: 0.18, fca: false },
    price: { last: 274, changePct: 0.038 },
    ...over,
  };
}

describe('alert text', () => {
  it('formats the scalp alert exactly', () => {
    expect(formatTelegram(alert(), AT)).toBe(
      [
        '🔥 [SCALP] SMRA 274 (+3,8%) — HAKA sapu offer',
        'AKSI: BELI 272–274 · SL 266 (−2,9%) · TP1 286 · TP2 294 · R:R 1:1,5',
        '• 5 menit: Rp2,1 M (RVOL 6,2x), HAKA 91%',
        '• Sapu 3 level offer 274→276, lot terbesar 8.140',
        'Skor 82/100: RVOL +25 · HAKA +20 · sapu +20 · bid +12 · ARA +5',
        '⚠️ Notasi: – · UMA: tidak · ke ARA: +18% · Sinyal aturan, bukan saran.',
        '09:33:12',
      ].join('\n'),
    );
    expect(formatMacos(alert())).toEqual({ title: '🔥 SMRA — HAKA sapu offer', body: 'BELI 272–274 · SL 266 · TP1 286 · skor 82' });
  });

  it('TUNGGU, HINDARI and exit layouts', () => {
    const wait = alert({ signal: { ...alert().signal, style: 'day', action: 'TUNGGU', title: 'Akumulasi' },
      plan: { ...alert().plan!, action: 'TUNGGU', waitPrice: 496, entryLow: 494, entryHigh: 496, stop: 488, tp1: 510, tp2: 520, rr: 1.8, lotBasis: 'fixed' },
      risk: { notations: ['E', 'X'], uma: true, fca: true } });
    const lines = formatTelegram(wait, AT).split('\n');
    expect(lines[0]).toBe('⚡ [DAY] SMRA 274 (+3,8%) — Akumulasi');
    expect(lines[1]).toBe('AKSI: TUNGGU di 496 · SL 488 (−1,6%) · TP1 510 · TP2 520 · R:R 1:1,8');
    expect(lines[2]).toBe('• 5 menit: Rp2,1 M (RVOL 6,2x), HAKA 91%');
    expect(lines.at(-2)).toBe('⚠️ Notasi: E, X · UMA: ya · ke ARA: ? · Sinyal aturan, bukan saran.');

    const avoid = formatTelegram(alert({ signal: { ...alert().signal, style: 'day', action: 'HINDARI', title: 'Distribusi' } }), AT).split('\n');
    expect(avoid[1]).toBe('AKSI: HINDARI');
    expect(avoid.some((l) => l.startsWith('Lot:'))).toBe(false);

    const noPlan: Alert = { ...alert() };
    delete noPlan.plan;
    const exit = formatTelegram({ ...noPlan, score: 0, signal: { ...alert().signal, style: 'exit', action: 'JUAL', title: 'Tembus stop', components: [] } }, AT).split('\n');
    expect(exit[0]).toBe('🚨 [EXIT] SMRA 274 (+3,8%) — Tembus stop');
    expect(exit[1]).toBe('AKSI: JUAL');
    expect(exit.some((l) => l.startsWith('Skor'))).toBe(false);
  });

  it('shows no portfolio, balance or lot size', () => {
    const t = formatTelegram(alert({ plan: { ...alert().plan!, lots: 0, note: 'Risiko per trade terlalu kecil untuk 1 lot' } }), AT);
    for (const word of ['Lot:', 'lot (', 'saldo', 'modal', 'risiko', 'Rp120rb', 'Risiko per trade']) expect(t).not.toContain(word);
  });

  it('keeps a plan note that is about the signal', () => {
    const t = formatTelegram(alert({ plan: { ...alert().plan!, action: 'TUNGGU', waitPrice: 274, note: 'Ruang naik ke target terlalu sempit (ARA atau tembok offer); jangan kejar' } }), AT);
    expect(t).toContain('Catatan: Ruang naik ke target terlalu sempit (ARA atau tembok offer); jangan kejar');
  });
});

describe('Notifier gate', () => {
  function setup(over: Record<string, unknown> = {}) {
    const sent: string[] = [];
    let now = AT;
    const sender: Sender = { name: 'test', send: async (a) => { sent.push(`${a.signal.symbol}:${a.signal.setup}:${a.score}`); } };
    const n = new Notifier({ cfg: parseWatchConfig(over), senders: [sender], logger: createLogger('silent'), now: () => now });
    return { n, sent, advance: (ms: number) => { now += ms; } };
  }

  it('cooldown drops a repeat within 10 minutes but lets a 15-point jump through', async () => {
    const { n, sent } = setup();
    const at = (ms: number, score: number) => alert({ score, signal: { ...alert().signal, at: AT + ms } });
    expect(await n.send(at(0, 82))).toBe(true);
    expect(await n.send(at(60_000, 90))).toBe(false);
    expect(await n.send(at(60_000, 97))).toBe(true);
    expect(await n.send(at(60_000 + 601_000, 70))).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it("gates and stamps on the alert's own time (replay runs faster than the clock)", async () => {
    const sent: string[] = [];
    const n = new Notifier({ cfg, senders: [{ name: 't', send: async (_a, text) => { sent.push(text.telegram); } }], logger: createLogger('silent'), now: () => AT + 3_600_000 * 5 });
    expect(await n.send(alert())).toBe(true);
    const later = alert({ signal: { ...alert().signal, at: AT + 11 * 60_000 } });
    expect(await n.send(later)).toBe(true);
    expect(sent[1]!.split('\n').at(-1)).toBe('09:44:12');
  });

  it('a changed direction passes the cooldown', async () => {
    const { n } = setup();
    await n.send(alert());
    expect(await n.send(alert({ signal: { ...alert().signal, action: 'HINDARI' } }))).toBe(true);
  });

  it('the same setup flipping between BELI and TUNGGU stays in the cooldown', async () => {
    const { n } = setup();
    await n.send(alert());
    expect(await n.send(alert({ signal: { ...alert().signal, action: 'TUNGGU' } }))).toBe(false);
    expect(await n.send(alert({ signal: { ...alert().signal, action: 'BELI' } }))).toBe(false);
  });

  it('one move is one notification: a day BELI right after a scalp BELI on the same stock stays in the cooldown', async () => {
    const { n } = setup();
    expect(await n.send(alert())).toBe(true);
    expect(await n.send(alert({ signal: { ...alert().signal, style: 'day', setup: 'day_high_break' } }))).toBe(false);
  });

  it('a new setup with a new action passes (accumulation TUNGGU, then markup BELI)', async () => {
    const { n } = setup();
    const day = { ...alert().signal, style: 'day' as const };
    expect(await n.send(alert({ signal: { ...day, setup: 'accumulation', action: 'TUNGGU' } }))).toBe(true);
    expect(await n.send(alert({ signal: { ...day, setup: 'markup', action: 'BELI' } }))).toBe(true);
  });

  it('daily cap stops non-exit alerts but not exits', async () => {
    const { n } = setup({ alerts: { dailyCap: 1 } });
    expect(await n.send(alert())).toBe(true);
    expect(await n.send(alert({ signal: { ...alert().signal, symbol: 'BBCA' } }))).toBe(false);
    const exit = alert({ signal: { ...alert().signal, symbol: 'TLKM', style: 'exit', setup: 'exit_stop', action: 'JUAL' } });
    expect(await n.send(exit)).toBe(true);
    expect(await n.send(exit)).toBe(false); // same exit again within the cooldown
  });

  it('telegram failure does not stop delivery', async () => {
    const lines: string[] = [];
    const mac = vi.fn(async () => {});
    const failing: Sender = { name: 'telegram', send: async () => { throw new Error('ETIMEDOUT'); } };
    const n = new Notifier({ cfg, senders: [failing, { name: 'macos', send: mac }], logger: createLogger('warn', (l) => lines.push(l)), now: () => AT });
    expect(await n.send(alert())).toBe(true);
    expect(await n.send(alert({ signal: { ...alert().signal, symbol: 'BBCA' } }))).toBe(true);
    expect(mac).toHaveBeenCalledTimes(2);
    expect(lines.filter((l) => l.includes('telegram'))).toHaveLength(1); // once per minute
  });

  it('records sent alerts', async () => {
    const records: object[] = [];
    const n = new Notifier({ cfg, senders: [], logger: createLogger('silent'), recorder: { alert: (r) => records.push(r) }, now: () => AT });
    await n.send(alert());
    expect(records).toHaveLength(1);
  });
});

describe('senders', () => {
  it('escapes quotes for osascript', async () => {
    const calls: string[][] = [];
    await macosSender(async (cmd, args) => { calls.push([cmd, ...args]); }).send(alert(), {
      telegram: '', macos: { title: 'say "hi"', body: 'a\\b' },
    });
    expect(calls[0]).toEqual(['osascript', '-e', 'display notification "a\\\\b" with title "say \\"hi\\""']);
  });

  it('posts to Telegram and reports an API error', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.telegram.org/botTOKEN/sendMessage');
      expect(JSON.parse(String(init?.body))).toEqual({ chat_id: '42', text: 'hello', disable_web_page_preview: true });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;
    await telegramSender('TOKEN', '42', fetchImpl).send(alert(), { telegram: 'hello', macos: { title: '', body: '' } });
    const bad = (async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch;
    await expect(telegramSender('T', '1', bad).send(alert(), { telegram: 'x', macos: { title: '', body: '' } })).rejects.toThrow(/Unauthorized/);
  });

  // Telegram API fake: answers by method name; getUpdates answers come from a queue.
  function tg(opts: { username?: string; webhook?: string; updates: unknown[][] }) {
    const calls: string[] = [];
    const f = (async (url: string | URL | Request) => {
      const u = new URL(String(url));
      const method = u.pathname.split('/').pop()!;
      calls.push(`${method}${u.search}`);
      if (method === 'getMe') return new Response(JSON.stringify({ ok: true, result: { username: opts.username ?? 'xbot' } }));
      if (method === 'getWebhookInfo') return new Response(JSON.stringify({ ok: true, result: { url: opts.webhook ?? '' } }));
      return new Response(JSON.stringify({ ok: true, result: opts.updates.shift() ?? [] }));
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('setupTelegram picks the latest chat id', async () => {
    const { f } = tg({ updates: [[
      { update_id: 1, message: { chat: { id: 111 } } }, { update_id: 3, message: { chat: { id: 333 } } }, { update_id: 2, message: { chat: { id: 222 } } },
    ]] });
    expect(await setupTelegram('T', f)).toBe('333');
  });

  it('accepts a chat from a Start-button update that is not a message', async () => {
    const { f } = tg({ updates: [[{ update_id: 5, my_chat_member: { chat: { id: 555 } } }]] });
    expect(await setupTelegram('T', f)).toBe('555');
  });

  it('names the bot and waits for /start when nothing has arrived yet', async () => {
    const { f, calls } = tg({ username: 'rizky_alert_bot', updates: [[], [], [{ update_id: 9, message: { chat: { id: 42 } } }]] });
    const waiting: string[] = [];
    expect(await setupTelegram('T', f, { onWaiting: (u) => waiting.push(u), rounds: 3 })).toBe('42');
    expect(waiting).toEqual(['rizky_alert_bot']);
    expect(calls.filter((c) => c.startsWith('getUpdates?timeout='))).toHaveLength(2);
  });

  it('says which bot to open when nothing arrives', async () => {
    const { f } = tg({ username: 'rizky_alert_bot', updates: [] });
    await expect(setupTelegram('T', f, { rounds: 2 })).rejects.toThrow(
      'Belum ada pesan ke @rizky_alert_bot. Buka https://t.me/rizky_alert_bot, tekan Start (atau kirim /start) di chat bot itu — bukan di @BotFather — lalu ulangi.',
    );
  });

  it('explains a webhook instead of waiting', async () => {
    const { f } = tg({ webhook: 'https://example.com/hook', updates: [] });
    await expect(setupTelegram('T', f)).rejects.toThrow(/webhook/);
  });
});
