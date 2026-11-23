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
// While the session cannot be refreshed, reconnect this rarely (and tell the user once).
const AUTH_BACKOFF_MS = 5 * 60_000;
// A connection that stayed up this long resets the backoff.
const STABLE_MS = 60_000;

export interface DatafeedOptions {
  url?: string;
  userId: string;
  tokens: Pick<AuthService, 'token' | 'refresh'>;
  WebSocketImpl?: typeof WebSocket;
  logger: Logger;
  onEvent(ev: FeedEvent, raw: Uint8Array, at: number): void;
  // Called once when the session is rejected and cannot be refreshed (the user must log in again).
  onAuthFailed?: () => void;
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
  private authBroken = false;
  private authNotified = false;
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
    ws.onclose = (e: CloseEvent) => this.onClose(ws, e);
    ws.onerror = () => {
      this.o.logger.debug('datafeed socket error');
    };
  }

  private async onOpen(ws: WebSocket): Promise<void> {
    this.openedAt = this.now();
    let token: string | undefined;
    try {
      token = await this.o.tokens.token('exodus');
    } catch (error) {
      this.o.logger.warn('datafeed: could not read the session', { error: error instanceof Error ? error.message : String(error) });
      this.drop(ws);
      return;
    }
    if (ws !== this.ws) return;
    if (!token) {
      this.o.logger.warn('datafeed: no Stockbit session (AUTH_REQUIRED); run stockbit-mcp login');
      this.drop(ws);
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
        // On a dead link close() never completes, so do not wait for onclose.
        this.o.logger.warn('datafeed: no pong, reconnecting');
        this.drop(ws);
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
          .then((ok) => {
            if (ok) {
              this.authBroken = false;
              this.authNotified = false;
            } else {
              this.authBroken = true;
              if (!this.authNotified) {
                this.authNotified = true;
                this.o.onAuthFailed?.();
              }
            }
            if (ws === this.ws) this.drop(ws);
          });
      }
    }
    if (ev.kind === 'unknown' && ev.field === -1) this.o.logger.debug('datafeed: unparsed frame');
    this.o.onEvent(ev, raw, this.now());
  }

  private onClose(ws: WebSocket, e?: { code?: number; reason?: string }): void {
    if (ws !== this.ws) return;
    this.detach(ws);
    this.scheduleReconnect({ ...(e?.code === undefined ? {} : { code: e.code }), ...(e?.reason ? { reason: e.reason } : {}) });
  }

  // Forget a socket without waiting for its close handshake, then reconnect.
  private drop(ws: WebSocket): void {
    if (ws !== this.ws) return;
    this.detach(ws);
    try {
      ws.close();
    } catch {
      // already closing
    }
    this.scheduleReconnect();
  }

  private detach(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    this.clearTimers();
    this.subscribed = false;
    this.ws = undefined;
  }

  // `close` says why the server closed the socket (absent when the bot dropped it itself). A socket
  // that keeps closing after a few seconds may be another session of the same account (the Stockbit
  // app or web) taking the realtime connection over; the code and uptime in the log tell.
  private scheduleReconnect(close: { code?: number; reason?: string } = {}): void {
    if (this.stopped) return;
    const upMs = this.openedAt ? this.now() - this.openedAt : 0;
    if (this.openedAt && upMs >= STABLE_MS) this.attempt = 0;
    this.openedAt = 0;
    const delay = this.authBroken ? AUTH_BACKOFF_MS : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** this.attempt);
    this.attempt += 1;
    this.o.logger.info('datafeed closed, reconnecting', { inMs: delay, upMs, ...close });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearTimers(): void {
    clearInterval(this.pingTimer);
    clearTimeout(this.pongTimer);
  }
}
