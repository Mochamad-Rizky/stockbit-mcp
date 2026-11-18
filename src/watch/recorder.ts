import { appendFileSync, createReadStream, createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createGunzip, createGzip, type Gzip } from 'node:zlib';

// Records every datafeed frame of a day so the rules can be replayed and tuned on real data.
// File: <dir>/<date>.bin.gz, a gzip stream of [u32 BE length][f64 BE receive ms][frame bytes]. Each
// run appends its own gzip member; gunzip reads the members back to back.
export class Recorder {
  private readonly gzip: Gzip;
  private readonly file: WriteStream;
  private readonly alertsPath: string;

  constructor(dir: string, date: string) {
    mkdirSync(dir, { recursive: true });
    this.file = createWriteStream(join(dir, `${date}.bin.gz`), { flags: 'a' });
    this.gzip = createGzip();
    this.gzip.pipe(this.file);
    this.alertsPath = join(dir, `${date}.alerts.ndjson`);
  }

  write(raw: Uint8Array, at: number): void {
    const head = Buffer.alloc(12);
    head.writeUInt32BE(raw.length, 0);
    head.writeDoubleBE(at, 4);
    this.gzip.write(head);
    if (raw.length > 0) this.gzip.write(Buffer.from(raw));
  }

  alert(record: object): void {
    appendFileSync(this.alertsPath, `${JSON.stringify(record)}\n`);
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.file.once('close', () => resolve());
      this.gzip.end();
    });
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
