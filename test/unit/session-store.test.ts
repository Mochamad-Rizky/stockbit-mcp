import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileSessionStore, isExpiring } from '../../src/core/session-store.js';
import { capArrays } from '../../src/core/json.js';

describe('file session store', () => {
  it('writes the session readable by the owner only and reads it back', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sbmcp-'));
    const store = createFileSessionStore(join(home, 'nested'));
    expect(await store.read()).toEqual({ version: 1 });

    const session = {
      version: 1 as const,
      exodus: { access: { token: 'a' }, savedAt: '2026-10-28T00:00:00Z' },
    };
    await store.write(session);

    expect(await store.read()).toEqual(session);
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(store.path, 'utf8'))).toEqual(session);
  });

  it('treats an unreadable file as no session', async () => {
    const home = await mkdtemp(join(tmpdir(), 'sbmcp-'));
    const store = createFileSessionStore(home);
    await writeFile(store.path, JSON.stringify({ version: 99 }));
    expect(await store.read()).toEqual({ version: 1 });
  });
});

describe('isExpiring', () => {
  it('is false without an expiry and true within the skew', () => {
    const now = Date.parse('2026-10-28T00:00:00Z');
    expect(isExpiring({ token: 't' }, now)).toBe(false);
    expect(isExpiring({ token: 't', expiresAt: '2026-10-28T00:00:30Z' }, now)).toBe(true);
    expect(isExpiring({ token: 't', expiresAt: '2026-10-28T01:00:00Z' }, now)).toBe(false);
  });
});

describe('capArrays', () => {
  it('cuts long lists at any depth and reports each cut', () => {
    const { value, cuts } = capArrays({ a: [1, 2, 3], b: { c: [[1, 2, 3]] } }, 2);
    expect(value).toEqual({ a: [1, 2], b: { c: [[1, 2]] } });
    expect(cuts).toEqual(['$.a: kept 2 of 3 items', '$.b.c[0]: kept 2 of 3 items']);
  });
});
