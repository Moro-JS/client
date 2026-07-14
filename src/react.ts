// @morojs/client/react — React bindings for the MoroSocket client.
//
// `react` is an optional peer dependency; this entry point is only loaded when
// you import from `@morojs/client/react`, so the core stays framework-agnostic.

import { useEffect, useRef, useState } from 'react';
import { MoroSocket, type EventMap, type MoroSocketOptions } from './index.js';

export interface UseSocketResult<L extends EventMap, E extends EventMap> {
  /** The live socket, or null before the first connect / when `url` is falsy. */
  socket: MoroSocket<L, E> | null;
  /** Whether the socket is currently connected. */
  connected: boolean;
}

/**
 * Create and manage a `MoroSocket` for a component's lifetime. The socket is
 * (re)created when `url` changes and closed on unmount. `opts` are read via a
 * ref, so changing them does not tear down the connection (pass a new `url` to
 * force a reconnect).
 */
export function useSocket<L extends EventMap = EventMap, E extends EventMap = EventMap>(
  url: string | null | undefined,
  opts?: MoroSocketOptions,
): UseSocketResult<L, E> {
  const [socket, setSocket] = useState<MoroSocket<L, E> | null>(null);
  const [connected, setConnected] = useState(false);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!url) return undefined;
    const s = new MoroSocket<L, E>(url, optsRef.current);
    setSocket(s);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    setConnected(s.connected);
    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.close();
      setSocket(null);
      setConnected(false);
    };
  }, [url]);

  return { socket, connected };
}

/**
 * Subscribe to a socket event with automatic cleanup. The latest `handler` is
 * always called without re-subscribing on every render.
 */
export function useSocketEvent<L extends EventMap, K extends keyof L & string>(
  socket: MoroSocket<L, EventMap> | null,
  event: K,
  handler: L[K],
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!socket) return undefined;
    const listener = ((...args: unknown[]) => {
      (handlerRef.current as (...a: unknown[]) => void)(...args);
    }) as unknown as L[K];
    socket.on(event, listener);
    return () => {
      socket.off(event, listener);
    };
  }, [socket, event]);
}
