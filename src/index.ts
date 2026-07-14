// @morojs/client — a browser-first WebSocket client for the MoroJS native
// engine (@morojs/engine).
//
// The engine speaks a plain JSON `{ event, data }` envelope over a raw
// WebSocket (no Engine.IO framing, no long-polling) and routes the upgrade URL
// path to the matching `app.websocket('/path', …)` namespace. This package
// exposes a socket.io-client-compatible API — `io(url, opts)` returning a
// `MoroSocket` with `.on/.off/.once/.emit`, `.connected/.id`,
// `.disconnect()/.close()`, and a minimal `.io` Manager (`'reconnect'`) — so
// apps migrating off `socket.io-client` change only their import.
//
// Zero runtime dependencies. Works in any browser (and SSR-safe: it no-ops when
// `WebSocket` is unavailable). Auth rides the upgrade via cookies automatically
// (same-site); `query`/`auth`/`extraHeaders` are folded into the URL query so
// the server can read them from the handshake. Reconnection is implemented here
// with exponential backoff + jitter.

export type Listener = (...args: any[]) => void;

/** An event → handler-signature map, for typed `.on()` / `.emit()`. */
export type EventMap = Record<string, (...args: any[]) => void>;

/**
 * The MoroJS engine wire format. Every WebSocket frame is a UTF-8 JSON envelope
 * of this shape: `emit(event, data)` sends one, and an inbound envelope is
 * dispatched to `on(event, …)` with `data` as the first argument. Exported as
 * the shared protocol contract for servers, clients, and future SDK modules.
 */
export interface MoroEnvelope<T = unknown> {
  event: string;
  data?: T;
}

/** Lifecycle events every socket emits locally, regardless of the server map. */
export interface ReservedListenEvents {
  connect: () => void;
  disconnect: (reason?: string) => void;
  connect_error: (err: Error) => void;
}

export interface MoroSocketOptions {
  /** socket.io mount path — ignored; the raw WS uses the URL path as the namespace. */
  path?: string;
  /** Cookies ride same-site upgrades automatically. Informational only. */
  withCredentials?: boolean;
  /** Ignored — always a raw WebSocket. */
  transports?: string[];
  /** Ignored — no HTTP long-polling to upgrade from. */
  upgrade?: boolean;
  /** Browsers can't set WS headers → folded into the URL query string. */
  extraHeaders?: Record<string, string | undefined>;
  /** socket.io handshake auth → folded into the URL query string. */
  auth?: Record<string, unknown> | ((cb: (data: Record<string, unknown>) => void) => void);
  /** Handshake query → URL query string. */
  query?: Record<string, unknown>;
  /** Default true. */
  reconnection?: boolean;
  /** Base backoff in ms (default 1000). */
  reconnectionDelay?: number;
  /** Max backoff in ms (default 15000). */
  reconnectionDelayMax?: number;
  /** Max reconnect attempts (default Infinity). */
  reconnectionAttempts?: number;
  /** Connect timeout in ms (default 20000). */
  timeout?: number;
  /** Connect on construction (default true). */
  autoConnect?: boolean;
}

/** Minimal event bus: add/remove/dispatch, isolated from listener throws. */
class Emitter {
  private readonly handlers = new Map<string, Set<Listener>>();

  protected add(event: string, fn: Listener): void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(fn);
  }

  protected remove(event?: string, fn?: Listener): void {
    if (!event) this.handlers.clear();
    else if (!fn) this.handlers.delete(event);
    else this.handlers.get(event)?.delete(fn);
  }

  protected dispatch(event: string, ...args: any[]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(...args);
      } catch {
        // A throwing listener must not break sibling listeners or the socket.
      }
    }
  }
}

/** socket.io's `socket.io` Manager — only reconnection events are consumed. */
export class MoroManager extends Emitter {
  on(event: string, fn: Listener): this {
    this.add(event, fn);
    return this;
  }
  off(event?: string, fn?: Listener): this {
    this.remove(event, fn);
    return this;
  }
  /** @internal */
  signal(event: string, ...args: any[]): void {
    this.dispatch(event, ...args);
  }
}

export class MoroSocket<
  ListenEvents extends EventMap = EventMap,
  EmitEvents extends EventMap = EventMap,
> extends Emitter {
  readonly io = new MoroManager();
  connected = false;
  id: string | undefined;

  private ws: WebSocket | undefined;
  private readonly url: string;
  private readonly opts: MoroSocketOptions;
  private readonly outbox: string[] = [];
  private attempts = 0;
  private hadConnected = false;
  private userClosed = false;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(uri: string, opts: MoroSocketOptions = {}) {
    super();
    this.opts = opts;
    this.url = buildWsUrl(uri, opts);
    if (opts.autoConnect !== false) this.connect();
  }

  /** Listen for a server event (or a lifecycle event: connect/disconnect/connect_error). */
  on<E extends keyof ListenEvents & string>(event: E, fn: ListenEvents[E]): this;
  on<E extends keyof ReservedListenEvents>(event: E, fn: ReservedListenEvents[E]): this;
  on(event: string, fn: Listener): this;
  on(event: string, fn: Listener): this {
    this.add(event, fn);
    return this;
  }

  once<E extends keyof ListenEvents & string>(event: E, fn: ListenEvents[E]): this;
  once(event: string, fn: Listener): this;
  once(event: string, fn: Listener): this {
    const wrap: Listener = (...args) => {
      this.remove(event, wrap);
      fn(...args);
    };
    this.add(event, wrap);
    return this;
  }

  off<E extends keyof ListenEvents & string>(event?: E, fn?: ListenEvents[E]): this;
  off(event?: string, fn?: Listener): this;
  off(event?: string, fn?: Listener): this {
    this.remove(event, fn);
    return this;
  }

  /** Send an event to the server. The engine envelope carries a single payload. */
  emit<E extends keyof EmitEvents & string>(event: E, ...args: Parameters<EmitEvents[E]>): this;
  emit(event: string, ...args: unknown[]): this;
  emit(event: string, ...args: unknown[]): this {
    // The engine envelope carries a single payload; extra args are ignored.
    const frame = JSON.stringify({ event, data: args[0] });
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
    else this.outbox.push(frame);
    return this;
  }

  connect(): this {
    this.userClosed = false;
    this.open();
    return this;
  }

  disconnect(): this {
    return this.close();
  }

  close(): this {
    this.userClosed = true;
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.connectTimer);
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
    }
    this.ws = undefined;
    this.connected = false;
    this.id = undefined;
    return this;
  }

  private open(): void {
    if (typeof WebSocket === 'undefined') return; // SSR / non-browser guard
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.fail(err);
      return;
    }
    this.ws = ws;
    this.connectTimer = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        this.fail(new Error('connect timeout'));
      }
    }, this.opts.timeout ?? 20000);

    ws.onopen = () => {
      clearTimeout(this.connectTimer);
      const reconnected = this.hadConnected;
      this.connected = true;
      this.hadConnected = true;
      this.attempts = 0;
      this.id = randomId();
      while (this.outbox.length) ws.send(this.outbox.shift() as string);
      this.dispatch('connect');
      if (reconnected) this.io.signal('reconnect', this.attempts);
    };

    ws.onmessage = (ev: MessageEvent) => {
      if (typeof ev.data !== 'string') return; // engine sends text envelopes
      let msg: { event?: unknown; data?: unknown };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg && typeof msg.event === 'string') this.dispatch(msg.event, msg.data);
    };

    ws.onerror = () => {
      // The browser gives no detail; surface a generic error, onclose reconnects.
      this.dispatch('connect_error', new Error('websocket error'));
    };

    ws.onclose = () => {
      clearTimeout(this.connectTimer);
      const wasConnected = this.connected;
      this.connected = false;
      this.id = undefined;
      this.ws = undefined;
      if (wasConnected) this.dispatch('disconnect');
      this.scheduleReconnect();
    };
  }

  private fail(err: unknown): void {
    this.dispatch('connect_error', err instanceof Error ? err : new Error('websocket error'));
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.userClosed || this.opts.reconnection === false) return;
    const maxAttempts = this.opts.reconnectionAttempts ?? Number.POSITIVE_INFINITY;
    if (this.attempts >= maxAttempts) return;
    const base = this.opts.reconnectionDelay ?? 1000;
    const cap = this.opts.reconnectionDelayMax ?? 15000;
    const backoff = Math.min(cap, base * 2 ** this.attempts);
    const delay = backoff * (0.5 + Math.random() * 0.5); // full jitter (0.5×–1×)
    this.attempts += 1;
    this.io.signal('reconnect_attempt', this.attempts);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}

/** socket.io-client-compatible `Socket` alias. */
export type Socket<
  ListenEvents extends EventMap = EventMap,
  EmitEvents extends EventMap = EventMap,
> = MoroSocket<ListenEvents, EmitEvents>;

/** socket.io-client-compatible factory. */
export function io<
  ListenEvents extends EventMap = EventMap,
  EmitEvents extends EventMap = EventMap,
>(uri: string, opts: MoroSocketOptions = {}): MoroSocket<ListenEvents, EmitEvents> {
  return new MoroSocket<ListenEvents, EmitEvents>(uri, opts);
}

export default io;

// ── helpers ──────────────────────────────────────────────────────────────────

/** @internal — exported for tests. */
export function buildWsUrl(uri: string, opts: MoroSocketOptions): string {
  // http(s):// → ws(s)://. Relative/protocol-less URIs resolve against the page.
  let base: URL;
  try {
    base = new URL(uri, typeof location !== 'undefined' ? location.href : undefined);
  } catch {
    base = new URL(uri);
  }
  if (base.protocol === 'http:') base.protocol = 'ws:';
  else if (base.protocol === 'https:') base.protocol = 'wss:';

  const params = base.searchParams;
  const put = (k: string, v: unknown) => {
    if (v !== undefined && v !== null) params.set(k, typeof v === 'string' ? v : String(v));
  };

  for (const [k, v] of Object.entries(opts.query ?? {})) put(k, v);
  for (const [k, v] of Object.entries(opts.extraHeaders ?? {})) put(k, v);

  const { auth } = opts;
  if (typeof auth === 'function') {
    let resolved: Record<string, unknown> = {};
    auth((d) => {
      resolved = d;
    });
    for (const [k, v] of Object.entries(resolved)) put(k, v);
  } else if (auth) {
    for (const [k, v] of Object.entries(auth)) put(k, v);
  }

  return base.toString();
}

function randomId(): string {
  try {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  } catch {
    /* noop */
  }
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
