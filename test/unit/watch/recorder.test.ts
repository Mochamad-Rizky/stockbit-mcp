import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, statSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Recorder, readRecording } from '../../../src/watch/recorder.js';

async function collect(file: string) {
  const out: Array<{ raw: number[]; at: number }> = [];
  for await (const r of readRecording(file)) out.push({ raw: [...r.raw], at: r.at });
  return out;
}

describe('Recorder', () => {
  it('round-trips frames in order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-'));
    const big = new Uint8Array(70_000).map((_, i) => i % 251);
    const rec = new Recorder(dir, '2026-11-18');
    rec.write(new Uint8Array(0), 1);
    rec.write(new Uint8Array([1, 2, 3]), 2.5);
    rec.write(big, 1794968455570);
    await rec.close();
    const got = await collect(join(dir, '2026-11-18.bin.gz'));
    expect(got.map((r) => r.at)).toEqual([1, 2.5, 1794968455570]);
    expect(got[0]!.raw).toEqual([]);
    expect(got[1]!.raw).toEqual([1, 2, 3]);
    expect(got[2]!.raw).toEqual([...big]);
  });

  it('appends a second run to the same day', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-'));
    const a = new Recorder(dir, '2026-11-18');
    a.write(new Uint8Array([1]), 1);
    await a.close();
    const b = new Recorder(dir, '2026-11-18');
    b.write(new Uint8Array([2]), 2);
    await b.close();
    expect((await collect(join(dir, '2026-11-18.bin.gz'))).map((r) => r.raw)).toEqual([[1], [2]]);
  });

  it('survives a truncated tail', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-'));
    const rec = new Recorder(dir, '2026-11-18');
    for (let i = 0; i < 200; i += 1) rec.write(new Uint8Array(500).fill(i), i);
    await rec.close();
    const file = join(dir, '2026-11-18.bin.gz');
    truncateSync(file, Math.floor(statSync(file).size * 0.6));
    const got = await collect(file);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(200);
    expect(got.every((r, i) => r.at === i && r.raw.every((b) => b === i))).toBe(true);
  });

  it('reads a corrupt or still-being-written tail up to the last complete record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-'));
    const rec = new Recorder(dir, '2026-11-18');
    for (let i = 0; i < 50; i += 1) rec.write(new Uint8Array(300).fill(i), i);
    await rec.close();
    const file = join(dir, '2026-11-18.bin.gz');
    // a second run's gzip member cut mid-block: header ok, deflate data garbage
    appendFileSync(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0, 0, 0, 0, 0x00, 0x03, 0x00, 0x05, 0x00, 0xff, 0xff, 0x13]));
    const got = await collect(file);
    expect(got).toHaveLength(50);
  });

  it('a disk error is reported once and does not throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-'));
    mkdirSync(join(dir, '2026-11-18.bin.gz')); // the file path is a directory: the stream errors
    const errors: string[] = [];
    const rec = new Recorder(dir, '2026-11-18', (e) => errors.push(e.message));
    rec.write(new Uint8Array([1, 2, 3]), 1);
    await rec.close();
    rec.write(new Uint8Array([4]), 2);
    expect(errors).toHaveLength(1);
  });

  it('writes alerts as NDJSON', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tape-'));
    const rec = new Recorder(dir, '2026-11-18');
    rec.alert({ symbol: 'SMRA', score: 82 });
    await rec.close();
    expect(readFileSync(join(dir, '2026-11-18.alerts.ndjson'), 'utf8')).toBe('{"symbol":"SMRA","score":82}\n');
  });
});
