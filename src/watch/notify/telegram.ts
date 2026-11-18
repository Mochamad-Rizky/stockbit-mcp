import type { Sender } from './notifier.js';

// Telegram Bot API: the user makes a bot with @BotFather, sends it /start, and setupTelegram finds
// the chat to post to. Plain text, no parse mode (nothing to escape).

const API = 'https://api.telegram.org';

export function telegramSender(token: string, chatId: string, fetchImpl: typeof fetch = fetch): Sender {
  const post = async (message: string) => {
    const res = await fetchImpl(`${API}/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, disable_web_page_preview: true }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { description?: string };
      throw new Error(`Telegram ${res.status}: ${body.description ?? res.statusText}`);
    }
  };
  return {
    name: 'telegram',
    send: (_a, text) => post(text.telegram),
    text: post,
  };
}

type Chat = { chat?: { id?: number } };
interface Update {
  update_id: number;
  message?: Chat;
  edited_message?: Chat;
  channel_post?: Chat;
  my_chat_member?: Chat;
  callback_query?: { message?: Chat };
}

const chatOf = (u: Update) =>
  (u.message ?? u.edited_message ?? u.channel_post ?? u.my_chat_member ?? u.callback_query?.message)?.chat?.id;

async function call<T>(fetchImpl: typeof fetch, token: string, method: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetchImpl(`${API}/bot${token}/${method}`, { signal: AbortSignal.timeout(timeoutMs) });
  const body = (await res.json()) as { ok?: boolean; description?: string; result?: T };
  if (!body.ok) throw new Error(`Telegram: ${body.description ?? 'token ditolak'}`);
  return body.result as T;
}

export interface SetupOptions {
  // Called with the bot's username when no message has arrived yet and the setup starts waiting.
  onWaiting?: (username: string) => void;
  // Long-poll rounds of up to 50 s each while waiting (default 3, about 2.5 minutes).
  rounds?: number;
}

// Finds the chat to post to: the most recent chat that wrote to the bot, waiting for one if needed.
// The bot is named in every message so a /start sent to @BotFather (a common slip) is easy to spot.
export async function setupTelegram(token: string, fetchImpl: typeof fetch = fetch, opts: SetupOptions = {}): Promise<string> {
  const me = await call<{ username?: string }>(fetchImpl, token, 'getMe');
  const username = me.username ?? 'bot kamu';
  const hook = await call<{ url?: string }>(fetchImpl, token, 'getWebhookInfo');
  if (hook.url) {
    throw new Error(
      `Bot @${username} memakai webhook (${hook.url}), jadi pesannya tidak bisa dibaca di sini. Pakai bot lain, atau hapus webhook-nya dulu (deleteWebhook).`,
    );
  }
  const latest = (updates: Update[]) =>
    updates.filter((u) => chatOf(u) !== undefined).sort((a, b) => b.update_id - a.update_id)[0];
  let found = latest(await call<Update[]>(fetchImpl, token, 'getUpdates'));
  if (!found) {
    opts.onWaiting?.(username);
    for (let i = 0; i < (opts.rounds ?? 3) && !found; i += 1) {
      found = latest(await call<Update[]>(fetchImpl, token, 'getUpdates?timeout=50', 60_000));
    }
  }
  if (!found) {
    throw new Error(
      `Belum ada pesan ke @${username}. Buka https://t.me/${username}, tekan Start (atau kirim /start) di chat bot itu — bukan di @BotFather — lalu ulangi.`,
    );
  }
  return String(chatOf(found));
}
