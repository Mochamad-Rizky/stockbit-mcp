import { appendFileSync, createReadStream, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createGunzip, createGzip, type Gzip } from 'node:zlib';

// Records every datafeed frame of a day so the rules can be replayed and tuned on real data.
// File: <dir>/<date>.bin.gz, a gzip stream of [u32 BE length][f64 BE receive ms][frame bytes]. Each
// run appends its own gzip member; gunzip reads the members back to back.
// A disk error (full disk, bad path) stops the recording, is reported once, and never stops the bot.
export class Recorder {
  private readonly gzip: Gzip;
  private readonly file: WriteStream;
  private readonly alertsPath: string;
  private broken = false;
  private closed: Promise<void>;

  constructor(dir: string, date: string, private readonly onError: (e: Error) => void = () => {}) {
    mkdirSync(dir, { recursive: true });
    this.file = createWriteStream(join(dir, `${date}.bin.gz`), { flags: 'a' });
    this.gzip = createGzip();
    this.closed = new Promise((resolve) => this.file.once('close', () => resolve()));
    const fail = (e: Error) => {
      if (this.broken) return;
      this.broken = true;
      this.gzip.unpipe(this.file);
      this.onError(e);
    };
    this.file.on('error', fail);
    this.gzip.on('error', fail);
    this.gzip.pipe(this.file);
    this.alertsPath = join(dir, `${date}.alerts.ndjson`);
  }

  write(raw: Uint8Array, at: number): void {
    if (this.broken) return;
    const head = Buffer.alloc(12);
    head.writeUInt32BE(raw.length, 0);
    head.writeDoubleBE(at, 4);
    this.gzip.write(head);
    if (raw.length > 0) this.gzip.write(Buffer.from(raw));
  }

  alert(record: object): void {
    try {
      appendFileSync(this.alertsPath, `${JSON.stringify(record)}\n`);
    } catch (error) {
      this.onError(error as Error);
    }
  }

  close(): Promise<void> {
    if (this.broken) {
      this.file.destroy();
      return Promise.resolve();
    }
    this.gzip.end();
    return this.closed;
  }
}

const isTruncation = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === 'Z_DATA_ERROR' ||
    code === 'Z_BUF_ERROR' ||
    (error instanceof Error && /unexpected end of file|incorrect header check/i.test(error.message))
  );
};

// Reads a recording back in order. A file cut off mid-way (a crash, a full disk, or a day the bot is
// still writing) yields the records before the cut and then stops. Zlib drops its unflushed output
// when it meets the bad bytes, so input goes in small slices with a small output buffer: at most
// about 1 KB of records just before the cut is lost.
export async function* readRecording(file: string): AsyncIterable<{ raw: Uint8Array; at: number }> {
  const gunzip = createReadStream(file, { highWaterMark: 1024 }).pipe(createGunzip({ chunkSize: 1024 }));
  const queue: Buffer[] = [];
  let done = false;
  let failure: unknown;
  let wake: (() => void) | undefined;
  const notify = () => {
    const w = wake;
    wake = undefined;
    w?.();
  };
  gunzip.on('data', (c: Buffer) => {
    queue.push(c);
    if (queue.length > 256) gunzip.pause();
    notify();
  });
  gunzip.on('end', () => {
    done = true;
    notify();
  });
  gunzip.on('error', (error) => {
    if (!isTruncation(error)) failure = error;
    done = true;
    notify();
  });

  let buf: Buffer = Buffer.alloc(0);
  for (;;) {
    const chunk = queue.shift();
    if (!chunk) {
      if (done) break;
      gunzip.resume();
      await new Promise<void>((r) => {
        wake = r;
      });
      continue;
    }
    if (queue.length < 64) gunzip.resume();
    buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
    let offset = 0;
    while (buf.length - offset >= 12) {
      const len = buf.readUInt32BE(offset);
      if (buf.length - offset < 12 + len) break;
      const at = buf.readDoubleBE(offset + 4);
      const raw = new Uint8Array(buf.subarray(offset + 12, offset + 12 + len));
      offset += 12 + len;
      yield { raw, at };
    }
    buf = buf.subarray(offset);
  }
  if (failure) throw failure;
}
