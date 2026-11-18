import type { AuthService } from '../../core/auth.js';
import type { Logger } from '../../core/logger.js';
import type { Channels, FeedEvent } from '../types.js';
import { decodeFrame, encodePing, encodeSubscribe } from './codec.js';

// Stockbit's realtime datafeed. Unlike the exodus REST API it is not behind Cloudflare's browser
// check, so plain Node's WebSocket reaches it.
export const DATAFEED_URL = 'wss://wss-jkt.trading.stockbit.com/ws';
export const PING_MS = 15_000;
export const PONG_TIMEOUT_MS = 5_000;
const MAX_BACKOFF_MS = 30_000;
// A connection that stayed up this long resets the backoff.
const STABLE_MS = 60_000;

export interface DatafeedOptions {
  url?: string;
  userId: string;
  tokens: Pick<AuthService, 'token' | 'refresh'>;
  WebSocketImpl?: typeof WebSocket;
  logger: Logger;
  onEvent(ev: FeedEvent, raw: Uint8Array, at: number): void;
  now?: () => number;
}

export class DatafeedClient {
  private ws: WebSocket | undefined;
  private channels: Channels = { runningTradeBatch: [], orderBook: [], livePrice: [] };
  private token: string | undefined;
  private subscribed = false;
  private stopped = true;
  private connections = 0;
  private attempt = 0;
  private openedAt = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private pongTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;

  constructor(private readonly o: DatafeedOptions) {
    this.now = o.now ?? Date.now;
  }

  get connected(): boolean {
    return this.subscribed;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    clearTimeout(this.reconnectTimer);
    const ws = this.ws;
    this.ws = undefined;
    this.subscribed = false;
    ws?.close();
  }

  setChannels(ch: Channels): void {
    this.channels = { runningTradeBatch: [...ch.runningTradeBatch], orderBook: [...ch.orderBook], livePrice: [...ch.livePrice] };
    if (this.subscribed && this.ws && this.token) {
      this.ws.send(encodeSubscribe(this.o.userId, this.token, this.channels));
    }
  }

  private connect(): void {
    const Impl = this.o.WebSocketImpl ?? WebSocket;
    const ws = new Impl(`${this.o.url ?? DATAFEED_URL}?_s=dfctx_v2_${this.connections}`, ['desktop']);
    this.connections += 1;
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      void this.onOpen(ws);
    };
    ws.onmessage = (e: MessageEvent) => this.onMessage(ws, e.data as ArrayBuffer);
    ws.onclose = () => this.onClose(ws);
    ws.onerror = () => {
      this.o.logger.debug('datafeed socket error');
    };
  }

  private async onOpen(ws: WebSocket): Promise<void> {
    this.openedAt = this.now();
    const token = await this.o.tokens.token('exodus');
    if (ws !== this.ws) return;
    if (!token) {
      this.o.logger.warn('datafeed: no Stockbit session (AUTH_REQUIRED); run stockbit-mcp login');
      ws.close();
      return;
    }
    this.token = token;
    ws.send(encodeSubscribe(this.o.userId, token, this.channels));
    this.subscribed = true;
    this.o.logger.info('datafeed connected', { connection: this.connections - 1 });
    this.pingTimer = setInterval(() => {
      if (ws !== this.ws) return;
      ws.send(encodePing());
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        this.o.logger.warn('datafeed: no pong, reconnecting');
        ws.close();
      }, PONG_TIMEOUT_MS);
    }, PING_MS);
  }

  private onMessage(ws: WebSocket, data: ArrayBuffer): void {
    if (ws !== this.ws) return;
    const raw = new Uint8Array(data);
    const ev = decodeFrame(raw);
    if (ev.kind === 'pong') clearTimeout(this.pongTimer);
    if (ev.kind === 'error') {
      this.o.logger.warn('datafeed error', { code: ev.code, message: ev.message });
      if (ev.code === 401 && this.token) {
        const rejected = this.token;
        void this.o.tokens
          .refresh('exodus', rejected)
          .catch(() => false)
          .finally(() => {
            if (ws === this.ws) ws.close();
          });
      }
    }
    if (ev.kind === 'unknown' && ev.field === -1) this.o.logger.debug('datafeed: unparsed frame');
    this.o.onEvent(ev, raw, this.now());
  }

  private onClose(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.clearTimers();
    this.subscribed = false;
    this.ws = undefined;
    if (this.stopped) return;
    if (this.openedAt && this.now() - this.openedAt >= STABLE_MS) this.attempt = 0;
    this.openedAt = 0;
    const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    this.attempt += 1;
    this.o.logger.info('datafeed closed, reconnecting', { inMs: delay });
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }
}
