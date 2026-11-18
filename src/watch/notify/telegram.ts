import type { Sender } from './notifier.js';

// Telegram Bot API: the user makes a bot with @BotFather, sends it /start, and setupTelegram finds
// the chat to post to. Plain text, no parse mode (nothing to escape).

const API = 'https://api.telegram.org';

export function telegramSender(token: string, chatId: string, fetchImpl: typeof fetch = fetch): Sender {
  return {
    name: 'telegram',
    async send(_a, text) {
      const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.telegram, disable_web_page_preview: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { description?: string };
        throw new Error(`Telegram ${res.status}: ${body.description ?? res.statusText}`);
      }
    },
  };
}

export async function setupTelegram(token: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(`${API}/bot${token}/getUpdates`, { signal: AbortSignal.timeout(10_000) });
  const body = (await res.json()) as { ok?: boolean; description?: string; result?: Array<{ update_id: number; message?: { chat?: { id?: number } } }> };
  if (!body.ok) throw new Error(`Telegram: ${body.description ?? 'token ditolak'}`);
  const latest = (body.result ?? [])
    .filter((u) => u.message?.chat?.id !== undefined)
    .sort((a, b) => b.update_id - a.update_id)[0];
  if (!latest) throw new Error('Kirim /start ke bot kamu dulu, lalu ulangi.');
  return String(latest.message!.chat!.id);
}
