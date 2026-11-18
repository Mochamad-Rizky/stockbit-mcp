import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AuthService, DEFAULT_HEADERS } from '../core/auth.js';
import type { Config } from '../core/config.js';
import { StockbitMcpError } from '../core/errors.js';
import { StockbitHttp } from '../core/http.js';
import type { Logger } from '../core/logger.js';
import type { SessionStore } from '../core/session-store.js';
import { loadWatchConfig, saveWatchConfig, type WatchConfig } from '../watch/config.js';
import { macosSender } from '../watch/notify/macos.js';
import { Notifier, type Sender } from '../watch/notify/notifier.js';
import { setupTelegram, telegramSender } from '../watch/notify/telegram.js';
import { replay, WatchRunner } from '../watch/run.js';
import { askSecret } from './prompt.js';

// `stockbit-mcp watch`: the alert bot. Live by default; --dry-run prints alerts instead of sending
// them; --replay <file> runs a recording; --setup-telegram links a Telegram bot; --install writes a
// LaunchAgent that starts the bot on weekday mornings.

const LABEL = 'com.stockbit-mcp.watch';

export function launchAgentPlist(node: string, cli: string, home: string): string {
  const days = [1, 2, 3, 4, 5]
    .map((d) => `<dict><key>Weekday</key><integer>${d}</integer><key>Hour</key><integer>8</integer><key>Minute</key><integer>40</integer></dict>`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${LABEL}</string>
<key>ProgramArguments</key><array><string>${node}</string><string>${cli}</string><string>watch</string></array>
<key>StartCalendarInterval</key><array>${days}</array>
<key>StandardOutPath</key><string>${home}/watch.log</string>
<key>StandardErrorPath</key><string>${home}/watch.log</string>
</dict></plist>
`;
}

const stdoutSender: Sender = {
  name: 'stdout',
  async send(_a, text) {
    process.stdout.write(`${text.telegram}\n\n`);
  },
  async text(message) {
    process.stdout.write(`${message}\n\n`);
  },
};

function senders(cfg: WatchConfig, dryRun: boolean, logger: Logger): Sender[] {
  if (dryRun) return [stdoutSender];
  const out: Sender[] = [];
  if (cfg.telegram.token && cfg.telegram.chatId) out.push(telegramSender(cfg.telegram.token, cfg.telegram.chatId));
  if (cfg.macos) out.push(macosSender());
  if (out.length === 0) {
    logger.warn('no Telegram and macOS notifications off: alerts go to stdout');
    out.push(stdoutSender);
  }
  return out;
}

export interface WatchCommandDeps {
  config: Config;
  logger: Logger;
  store: SessionStore;
  auth: AuthService;
  fetch?: typeof fetch;
}

export async function watchCommand(args: string[], d: WatchCommandDeps): Promise<number> {
  const flags = new Set(args);
  const cfg = await loadWatchConfig(d.config.home);
  const http = new StockbitHttp({
    bases: d.config.bases, tokens: d.auth, logger: d.logger, timeoutMs: d.config.timeoutMs, defaultHeaders: DEFAULT_HEADERS,
    ...(d.fetch ? { fetch: d.fetch } : {}),
  });

  if (flags.has('--setup-telegram')) {
    const token = await askSecret('Token bot Telegram dari @BotFather: ');
    const chatId = await setupTelegram(token);
    await saveWatchConfig(d.config.home, { ...cfg, telegram: { token, chatId } });
    await telegramSender(token, chatId).text?.('stockbit-mcp watch tersambung ke Telegram ✅');
    process.stderr.write(`Telegram tersambung (chat ${chatId}); pesan tes terkirim.\n`);
    return 0;
  }

  if (flags.has('--install')) {
    const path = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
    mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(path, launchAgentPlist(process.execPath, resolve(process.argv[1] ?? 'dist/cli.js'), d.config.home));
    process.stderr.write(`Ditulis: ${path}\nAktifkan dengan: launchctl load ${path}\n`);
    return 0;
  }

  const replayAt = args.indexOf('--replay');
  if (replayAt >= 0) {
    const file = args[replayAt + 1];
    if (!file) throw new StockbitMcpError('INVALID_INPUT', 'Usage: stockbit-mcp watch --replay <file.bin.gz>');
    const notifier = new Notifier({ cfg, senders: [stdoutSender], logger: d.logger });
    const alerts = await replay(file, { http, cfg, logger: d.logger, notifier });
    process.stderr.write(`${alerts.length} alert(s) from ${file}\n`);
    return 0;
  }

  const session = await d.store.read();
  const userId = session.exodus?.userId;
  if (!session.exodus?.access.token || !userId) {
    throw new StockbitMcpError('AUTH_REQUIRED', 'No Stockbit session.', { hint: 'Run `stockbit-mcp login` first.' });
  }
  const notifier = new Notifier({ cfg, senders: senders(cfg, flags.has('--dry-run'), d.logger), logger: d.logger });
  return new Promise<number>((resolveExit) => {
    const finish = (code: number) => {
      void runner.stop().finally(() => resolveExit(code));
    };
    const runner: WatchRunner = new WatchRunner({
      http, cfg, home: d.config.home, logger: d.logger, notifier, userId, auth: d.auth,
      onDayEnd: () => {
        d.logger.info('trading day over, stopping');
        finish(0);
      },
    });
    process.once('SIGINT', () => finish(0));
    process.once('SIGTERM', () => finish(0));
    runner.start().then(
      () => d.logger.info('stockbit-mcp watch running', { dryRun: flags.has('--dry-run') }),
      (error: unknown) => {
        d.logger.error('watch failed to start', { error: error instanceof Error ? error.message : String(error) });
        finish(1);
      },
    );
  });
}
