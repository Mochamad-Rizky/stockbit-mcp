import { execFile } from 'node:child_process';
import type { Sender } from './notifier.js';

export type Exec = (cmd: string, args: string[]) => Promise<void>;

const defaultExec: Exec = (cmd, args) =>
  new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5_000 }, (error) => (error ? reject(error) : resolve()));
  });

const quote = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// A macOS notification through AppleScript.
export function macosSender(exec: Exec = defaultExec): Sender {
  return {
    name: 'macos',
    async send(_a, text) {
      await exec('osascript', ['-e', `display notification ${quote(text.macos.body)} with title ${quote(text.macos.title)}`]);
    },
    async text(message) {
      await exec('osascript', ['-e', `display notification ${quote(message)} with title ${quote('stockbit-mcp watch')}`]);
    },
  };
}
