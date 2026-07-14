import { describe, it, expect, beforeEach } from 'vitest';
import { io, buildWsUrl } from './index.js';

// Minimal WebSocket mock: capture sent frames, drive open/message/close by hand.
class MockWS {
  static instances: MockWS[] = [];
  static readonly OPEN = 1;
  url: string;
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  emitOpen() {
    this.readyState = 1;
    this.onopen?.();
  }
  emitMessage(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

beforeEach(() => {
  MockWS.instances = [];
  (globalThis as unknown as { WebSocket: typeof MockWS }).WebSocket = MockWS;
});

describe('MoroSocket', () => {
  it('buffers emits before open, then flushes on connect', () => {
    const s = io('http://localhost:3000/ns', { reconnection: false });
    const ws = MockWS.instances[0]!;
    s.emit('ping', { a: 1 });
    expect(ws.sent).toHaveLength(0);
    ws.emitOpen();
    expect(ws.sent).toEqual([JSON.stringify({ event: 'ping', data: { a: 1 } })]);
  });

  it('dispatches inbound { event, data } to on() handlers', () => {
    const s = io('http://localhost:3000/ns', { reconnection: false });
    const ws = MockWS.instances[0]!;
    ws.emitOpen();
    const seen: unknown[] = [];
    s.on('pong', (d: unknown) => seen.push(d));
    ws.emitMessage({ event: 'pong', data: 42 });
    expect(seen).toEqual([42]);
  });

  it('fires connect / disconnect lifecycle and tracks connected', () => {
    const s = io('http://localhost:3000/ns', { reconnection: false });
    const ws = MockWS.instances[0]!;
    let connected = false;
    s.on('connect', () => {
      connected = true;
    });
    s.on('disconnect', () => {
      connected = false;
    });
    ws.emitOpen();
    expect(connected).toBe(true);
    expect(s.connected).toBe(true);
    ws.close();
    expect(connected).toBe(false);
    expect(s.connected).toBe(false);
  });

  it('off() removes a handler', () => {
    const s = io('http://localhost:3000/ns', { reconnection: false });
    const ws = MockWS.instances[0]!;
    ws.emitOpen();
    const seen: unknown[] = [];
    const h = (d: unknown) => seen.push(d);
    s.on('x', h);
    ws.emitMessage({ event: 'x', data: 1 });
    s.off('x', h);
    ws.emitMessage({ event: 'x', data: 2 });
    expect(seen).toEqual([1]);
  });
});

describe('buildWsUrl', () => {
  it('converts http(s) → ws(s) and folds query + auth into the URL', () => {
    const url = buildWsUrl('https://api.example.com/command-center', {
      query: { orgId: '7' },
      auth: { token: 'abc' },
    });
    const u = new URL(url);
    expect(u.protocol).toBe('wss:');
    expect(u.pathname).toBe('/command-center');
    expect(u.searchParams.get('orgId')).toBe('7');
    expect(u.searchParams.get('token')).toBe('abc');
  });

  it('folds extraHeaders into the query (browsers cannot set WS headers)', () => {
    const url = buildWsUrl('http://localhost:9080/rt', {
      extraHeaders: { 'x-sig': 'sig123' },
    });
    const u = new URL(url);
    expect(u.protocol).toBe('ws:');
    expect(u.searchParams.get('x-sig')).toBe('sig123');
  });
});
