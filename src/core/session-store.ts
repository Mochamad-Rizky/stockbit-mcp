import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

// The tokens `stockbit-mcp login` saves. They grant full access to the Stockbit account, so the
// file is readable by its owner only and nothing in the server ever logs or returns them.
const TokenSchema = z.object({
  token: z.string().min(1),
  // ISO time, when Stockbit said; absent when it did not.
  expiresAt: z.string().optional(),
});

export const SessionSchema = z.object({
  version: z.literal(1),
  exodus: z
    .object({
      access: TokenSchema,
      refresh: TokenSchema.optional(),
      userId: z.string().optional(),
      username: z.string().optional(),
      savedAt: z.string(),
    })
    .optional(),
  trading: z
    .object({
      access: TokenSchema,
      refresh: TokenSchema.optional(),
      // Regular, margin or syariah, as carina names it. The account number is never stored.
      accountType: z.string().optional(),
      savedAt: z.string(),
    })
    .optional(),
  // A stable id for this install, sent where Stockbit asks for a device id.
  deviceId: z.string().optional(),
});

export type Session = z.infer<typeof SessionSchema>;
export type StoredToken = z.infer<typeof TokenSchema>;

export interface SessionStore {
  read(): Promise<Session>;
  write(session: Session): Promise<void>;
  clear(): Promise<void>;
  readonly path: string;
}

const EMPTY: Session = { version: 1 };

export function createFileSessionStore(home: string): SessionStore {
  const path = join(home, 'session.json');
  return {
    path,
    async read() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return { ...EMPTY };
        }
        throw error;
      }
      const parsed = SessionSchema.safeParse(JSON.parse(text));
      // A file this version cannot read is treated as no session: logging in again rewrites it.
      return parsed.success ? parsed.data : { ...EMPTY };
    },
    async write(session) {
      await mkdir(home, { recursive: true, mode: 0o700 });
      const tmp = `${path}.${process.pid}.tmp`;
      await writeFile(tmp, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
      await rename(tmp, path);
      // rename keeps the mode of tmp, but an older file may have been looser.
      await chmod(path, 0o600);
    },
    async clear() {
      await rm(path, { force: true });
    },
  };
}

export function createMemorySessionStore(initial: Session = { ...EMPTY }): SessionStore {
  let current: Session = structuredClone(initial);
  return {
    path: ':memory:',
    async read() {
      return structuredClone(current);
    },
    async write(session) {
      current = structuredClone(session);
    },
    async clear() {
      current = { ...EMPTY };
    },
  };
}

// True when the token is known to expire within `skewMs` (default one minute).
export function isExpiring(token: StoredToken | undefined, now = Date.now(), skewMs = 60_000): boolean {
  if (!token?.expiresAt) {
    return false;
  }
  const at = Date.parse(token.expiresAt);
  return Number.isFinite(at) && at - skewMs <= now;
}
