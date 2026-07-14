# @morojs/client

The **MoroJS client SDK** — the browser-first, zero-dependency way for any
frontend to talk to a [MoroJS](https://morojs.com) backend. This release ships
the **realtime** module: a `socket.io-client`-compatible API over the native
engine's WebSocket protocol. Typed HTTP and shared types are next — see the
[Roadmap](#roadmap).

The MoroJS engine terminates WebSockets natively in C++ (no Engine.IO framing,
no long-polling) and routes the upgrade URL path to the matching
`app.websocket('/path', …)` namespace. This package gives the browser a familiar
`io()` / `socket.on()` / `socket.emit()` API over that protocol — so migrating an
app off `socket.io-client` is (usually) just changing an import.

## Install

```bash
npm install @morojs/client
```

## Quick start

```ts
import { io } from '@morojs/client';

const socket = io('wss://api.example.com/command-center', {
  query: { orgId: '42' }, // → handshake query (server reads socket.handshake.query.orgId)
});

socket.on('connect', () => socket.emit('subscribe'));
socket.on('event', (payload) => console.log(payload));
socket.on('disconnect', () => console.log('offline'));
```

Cookies are sent automatically on the upgrade (same-site), so cookie-based auth
works with no extra config. `query`, `auth`, and `extraHeaders` are folded into
the URL query string (browsers can't set headers on a WebSocket), so the server
can read them from the handshake.

## Migrating from `socket.io-client`

For the common case, change only the import:

```diff
- import { io, type Socket } from 'socket.io-client';
+ import { io, type Socket } from '@morojs/client';
```

Supported: `io(url, opts)`, `.on/.off/.once/.emit`, `.connected`, `.id`,
`.disconnect()/.close()`, `.io.on('reconnect', …)`, and the `connect` /
`disconnect` / `connect_error` lifecycle events. Reconnection (exponential
backoff + jitter) is built in.

Not supported (by design — the engine protocol doesn't have them): HTTP
long-polling fallback, multiplexed namespaces over one connection (each path is
its own WebSocket), and acknowledgement callbacks.

## Typed events

Pass server→client and client→server event maps for end-to-end type safety:

```ts
interface ServerEvents {
  ready: (data: { orgId: string; userId: number }) => void;
  event: (data: { type: string; payload: unknown }) => void;
}
interface ClientEvents {
  subscribe: (data?: void) => void;
}

const socket = io<ServerEvents, ClientEvents>('wss://api.example.com/command-center');

socket.on('ready', (data) => data.orgId); // data is typed
socket.emit('subscribe');                  // event name + payload checked
```

## React

`@morojs/client/react` provides hooks (React is an optional peer dependency):

```tsx
import { useSocket, useSocketEvent } from '@morojs/client/react';

function CommandCenter({ orgId }: { orgId: string }) {
  const { socket, connected } = useSocket('wss://api.example.com/command-center', {
    query: { orgId },
  });

  useSocketEvent(socket, 'event', (payload) => {
    // handle a live event; auto-unsubscribes on unmount / socket change
  });

  return <span>{connected ? 'live' : 'connecting…'}</span>;
}
```

## The wire protocol

Every frame is a UTF-8 JSON envelope:

```json
{ "event": "subscribe", "data": { "…": "…" } }
```

`socket.emit('event', data)` sends `{ event, data }`; an inbound `{ event, data }`
is dispatched to the matching `.on('event', …)` handlers with `data` as the first
argument. That's the whole protocol.

## Roadmap

`@morojs/client` is the umbrella SDK for talking to a MoroJS backend — realtime
is the first module.

- ✅ **Realtime** — `io()` / `MoroSocket`, typed events, `/react` hooks
- 🔜 **Typed HTTP client** — `createClient({ baseUrl })` over Moro's route
  convention, with credentials and normalized validation errors (`@morojs/client/http`)
- 🔜 **Shared types** — the `MoroEnvelope` wire type ships today; response,
  error, and pagination envelopes follow with the HTTP module
- ⬜ **Auth / session helpers** and additional React hooks

The surface is intentionally `0.x` while these land.

## License

MIT © Moro Framework Team
