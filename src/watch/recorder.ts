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

// Reads a recording back in order. A file cut off mid-way (a crash, a full disk) yields the complete
// records before the cut and then stops.
export async function* readRecording(file: string): AsyncIterable<{ raw: Uint8Array; at: number }> {
  const gunzip = createReadStream(file).pipe(createGunzip());
  let buf: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of gunzip as AsyncIterable<Buffer>) {
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
  } catch (error) {
    if (!(error instanceof Error && /unexpected end of file|incorrect header check/i.test(error.message))) throw error;
  }
}
