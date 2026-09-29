# Phase 4 — Implementation Plan: Real-Time Guest ↔ Host Chat (Socket.IO)

Spec: [docs/specs/phase-4-realtime-chat.md](../specs/phase-4-realtime-chat.md)
Estimated time: ~1.5 days. There are 11 steps.

---

## Decisions made while planning (read first)

D1 and D2 come from **running the Socket.IO Redis adapter against your Redis container**
(Socket.IO 4.8.4, `@socket.io/redis-adapter` 8.3.0, ioredis 6.0.0). They change the spec.

| # | Decision | Why |
|---|---|---|
| D1 | The adapter gets **its own two Redis clients**: a subscriber with `maxRetriesPerRequest: null` (no command timeout) and a publisher with `enableOfflineQueue: false`. **Don't** reuse or `duplicate()` the Phase 1 client | Tested: with the Phase 1 client's `commandTimeout: 500`, the adapter's `psubscribe` timed out on the first (slow) Docker connection. The subscription silently never happened, and **cross-instance messages were lost even with Redis up**. A subscriber with no timeout waits for Redis instead, and ioredis re-subscribes automatically after a reconnect (tested: Redis stop → start → delivery resumed). |
| D2 | Wrap the publisher's `publish` so a failure is **logged, never thrown** | Tested: the adapter calls `pubClient.publish(...)` with no `.catch()` (checked in its source). With Redis down, every chat message would be an **unhandled promise rejection, which crashes the whole Node 22 process**. With the wrapper, a Redis outage means cross-instance delivery pauses, but the app stays up, same-instance delivery keeps working (tested), and messages are still saved to MongoDB. This is fail open, matching Phase 1. |
| D3 | **WebSocket-only transport** (`io({ transports: ['websocket'] })`) instead of Nginx `ip_hash` sticky sessions | The spec planned `ip_hash`, but locally every browser tab reaches Nginx from the **same IP** (Docker's gateway). `ip_hash` would pin every socket to one instance, so cross-instance delivery could never be demonstrated. Stickiness is only needed because Socket.IO's HTTP long-polling fallback makes several requests per connection. With WebSocket only, a connection is one upgraded TCP stream that stays on one instance by nature, so plain round robin works. The trade-off is no polling fallback for networks that block WebSockets, which is rare today. Explain both in interviews. |
| D4 | Client and server talk with **acknowledgements** (`emitWithAck`): `chat:join` returns `{ ok, messages, instance }` and `chat:send` returns `{ ok }` or `{ ok: false, error }`. Only `chat:message` is broadcast | This replaces the spec's separate `chat:history` / `chat:error` events. Request → reply is simpler to code and test. `instance` in the join reply shows which app instance a socket landed on (the socket equivalent of `X-Instance-Id`). |
| D5 | Every socket handler catches its own errors | An exception thrown inside an async Socket.IO handler is an unhandled rejection, which crashes the process (same reason as D2). A bad ID or a DB hiccup must return `{ ok: false }`, not take the server down. |
| D6 | The client **re-joins its conversation on every `connect` event**, not just the first | When an instance dies, Socket.IO auto-reconnects to another one, but room membership lived on the dead instance. Re-joining on reconnect restores the room and reloads history, so failover is seamless. |
| D7 | Graceful shutdown calls **`io.close()`** (it closes all sockets, then the HTTP server) instead of `server.close()` | `server.close()` waits for open connections, and an open WebSocket never ends by itself, so shutdown would always hit the 8 s force-exit. |
| D8 | Messages go through a **message store module** (`services/messageStore/`) with 3 functions. Nothing else touches the `Message` model | Phase 6 swaps MongoDB for Cassandra by adding one file. This phase only has the Mongo implementation. |
| D9 | The automated test (`scripts/chat-test.js`) creates a **temporary `[TEST]` listing owned by the test user**, and deletes it afterwards | Your seeded listings belong to an account whose password we don't know, so the test needs a listing whose host we can log in as. A second test user plays the guest. |
| D10 | `socket.io-client` is a **devDependency** | Only the test script needs it. Browsers load the client from `/socket.io/socket.io.js`, served by the server, and the Docker image (`npm ci --omit=dev`) stays lean. |

---

## Step 0 — Prerequisites (15 min)

1. Branch: `git checkout -b phase-4-realtime-chat` (from `phase-3-safe-bookings`).
2. Install:
   ```bash
   npm install socket.io@4 @socket.io/redis-adapter@8
   npm install --save-dev socket.io-client@4
   ```
3. **A second test user** (the guest): sign up `racetest2` (through the UI, or `curl -X POST -d "username=racetest2&email=racetest2@example.com&password=..." localhost:8080/signup`). Add to `.env`:
   ```
   TEST_USER2=racetest2
   TEST_PASS2=<password>
   ```
   `racetest` (Phase 3) plays the host.

## Step 1 — Message model: `models/message.js` (new) (15 min)

Fields: `conversationId` (String, required), `listing` (ObjectId → Listing, required), `guest` (ObjectId → User, required), `sender` (ObjectId → User, required), `senderName` (String), `text` (String, required, maxlength 1000), `sentAt` (Date, default `Date.now`).

Indexes:
```js
messageSchema.index({ conversationId: 1, sentAt: -1 }); // "latest N messages of a conversation"
messageSchema.index({ listing: 1, sentAt: -1 });        // "which guests messaged this listing"
```

## Step 2 — Message store: `services/messageStore/` (new) (30 min)

**`services/messageStore/mongoStore.js`**: the only file that uses the `Message` model.

| Function | Implementation | Returns |
|---|---|---|
| `saveMessage({ conversationId, listingId, guestId, senderId, senderName, text })` | `Message.create(...)` | `toDTO(doc)` |
| `getRecentMessages(conversationId, limit = 50)` | `find({ conversationId }).sort({ sentAt: -1 }).limit(limit).lean()`, then `.reverse()` | oldest → newest |
| `listConversations(listingId)` | `aggregate([{ $match: { listing } }, { $group: { _id: '$guest', lastMessageAt: { $max: '$sentAt' } } }, { $sort: { lastMessageAt: -1 } }])` | `[{ guestId, lastMessageAt }]` |

Every function returns **plain objects** in one shape (a "DTO"), so the socket code never sees
Mongoose documents or ObjectIds:
```js
{ conversationId, senderId: String, senderName, text, sentAt: ISO string }
```

**`services/messageStore/index.js`**:
```js
// Storage for chat messages. Everything goes through this module so the
// backing database can change (Phase 6: Cassandra) without touching callers.
module.exports = require('./mongoStore.js');
```

## Step 3 — Socket server: `socket/index.js` (new) (45 min)

Exports `createSocketServer(httpServer, { sessionMiddleware, instanceId })` and `closeSocketServer()`.

```js
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Redis } = require('ioredis');
const passport = require('passport');
const registerChatHandlers = require('./chat.js');

let pubClient;
let subClient;

// Run a middleware only on the connection handshake, not on every later request.
const onlyForHandshake = (middleware) => (req, res, next) => {
  const isHandshake = req._query.sid === undefined;
  if (isHandshake) middleware(req, res, next);
  else next();
};

module.exports.createSocketServer = (httpServer, { sessionMiddleware, instanceId }) => {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
  // Dedicated clients for the adapter (D1), NOT the shared Phase 1 client:
  // the subscriber must never time out, or its subscription silently fails.
  subClient = new Redis(url, { maxRetriesPerRequest: null });
  pubClient = new Redis(url, { enableOfflineQueue: false });
  subClient.on('error', () => {}); // outages are already logged by config/redis.js
  pubClient.on('error', () => {});
  // The adapter doesn't catch publish failures; without this, a Redis outage
  // would crash the process with an unhandled rejection (D2).
  const publish = pubClient.publish.bind(pubClient);
  pubClient.publish = (...args) =>
    publish(...args).catch((err) => console.log('Socket.IO publish failed:', err.message));

  const io = new Server(httpServer, { adapter: createAdapter(pubClient, subClient) });

  // Reuse the Express login session: the browser sends the same session
  // cookie on the WebSocket handshake, so socket.request.user is the user.
  io.engine.use(onlyForHandshake(sessionMiddleware));
  io.engine.use(onlyForHandshake(passport.session()));
  io.engine.use(onlyForHandshake((req, res, next) => {
    if (req.user) return next();
    res.writeHead(401);
    res.end();
  }));

  io.on('connection', (socket) => registerChatHandlers(io, socket, { instanceId }));
  return io;
};

module.exports.closeSocketServer = () => {
  subClient?.disconnect();
  pubClient?.disconnect();
};
```

Notes
- `disconnect()` rather than `quit()`: the subscriber may still have a queued subscribe (Redis down), and `quit()` would wait behind it forever.
- Handshake without login → HTTP 401 → the client gets `connect_error`.

## Step 4 — Chat handlers: `socket/chat.js` (new) (1.5 h)

```js
const mongoose = require('mongoose');
const Listing = require('../models/listing.js');
const messageStore = require('../services/messageStore');

const MAX_LENGTH = 1000;
const HISTORY_LIMIT = 50;

// An error whose message is safe to show the user.
class ChatError extends Error {}

const conversationIdFor = (listingId, guestId) => `${listingId}_${guestId}`;

// Only the guest themself or the listing's owner may read/write a conversation.
// The sender is ALWAYS the logged-in user from the session, never an ID from the client.
async function authorize(user, { listingId, guestId } = {}) {
  if (!mongoose.isValidObjectId(listingId) || !mongoose.isValidObjectId(guestId)) {
    throw new ChatError('Invalid conversation.');
  }
  const listing = await Listing.findById(listingId).select('owner');
  if (!listing) throw new ChatError('Listing not found.');
  const ownerId = listing.owner?.toString();
  const userId = user._id.toString();
  if (guestId === ownerId) throw new ChatError("Hosts can't message their own listing.");
  if (userId !== guestId && userId !== ownerId) throw new ChatError('Not allowed.');
  return conversationIdFor(listingId, guestId);
}

// Handlers never throw (D5): errors become { ok: false, error } replies.
const reply = (ack, payload) => { if (typeof ack === 'function') ack(payload); };
const fail = (ack, err) => {
  if (!(err instanceof ChatError)) console.error('Chat error:', err);
  reply(ack, { ok: false, error: err instanceof ChatError ? err.message : 'Something went wrong.' });
};

module.exports = (io, socket, { instanceId }) => {
  const user = socket.request.user;

  socket.on('chat:join', async (payload, ack) => {
    try {
      const conversationId = await authorize(user, payload);
      // One open conversation per socket: leave any previous one.
      for (const room of socket.rooms) if (room !== socket.id) socket.leave(room);
      socket.join(conversationId);
      const messages = await messageStore.getRecentMessages(conversationId, HISTORY_LIMIT);
      reply(ack, { ok: true, messages, instance: instanceId });
    } catch (err) {
      fail(ack, err);
    }
  });

  socket.on('chat:send', async (payload, ack) => {
    try {
      // Re-check on every message, not just on join.
      const conversationId = await authorize(user, payload);
      const text = String(payload?.text ?? '').trim();
      if (!text) throw new ChatError('Message is empty.');
      if (text.length > MAX_LENGTH) throw new ChatError(`Message is longer than ${MAX_LENGTH} characters.`);

      // Save BEFORE broadcasting: pub/sub is fire-and-forget, so a missed
      // live event is recovered from history on the next join.
      const message = await messageStore.saveMessage({
        conversationId,
        listingId: payload.listingId,
        guestId: payload.guestId,
        senderId: user._id,
        senderName: user.username,
        text,
      });
      io.to(conversationId).emit('chat:message', message);
      reply(ack, { ok: true });
    } catch (err) {
      fail(ack, err);
    }
  });
};
```

## Step 5 — Wire into `app.js` (30 min)

1. Imports: `const { createSocketServer, closeSocketServer } = require('./socket/index.js');`, and add `let io;` next to `let server;`.
2. In `main().then`, keep the session middleware in a variable so Socket.IO can reuse it:
   ```js
   const sessionMiddleware = session(sessionOptions);
   app.use(sessionMiddleware);
   ```
3. After `server = app.listen(...)`:
   ```js
   io = createSocketServer(server, { sessionMiddleware, instanceId: INSTANCE_ID });
   ```
4. In `shutdown`, replace the `server.close` line (D7):
   ```js
   // io.close() disconnects every socket, then closes the HTTP server. A plain
   // server.close() would wait forever on open WebSockets.
   if (io) await new Promise((resolve) => io.close(resolve));
   else if (server) await new Promise((resolve) => server.close(resolve));
   closeSocketServer();
   ```

✅ `node app.js` starts. `curl -i "localhost:8080/socket.io/?EIO=4&transport=polling"` without a cookie → `401`.

## Step 6 — Owner's conversation list: `controllers/listing.js` `showListing` (20 min)

When `isOwnerViewing`:
```js
const threads = await messageStore.listConversations(listing._id);
const guests = await User.find({ _id: { $in: threads.map((t) => t.guestId) } }).select('username');
const nameById = new Map(guests.map((g) => [g._id.toString(), g.username]));
conversations = threads.map((t) => ({ ...t, guestName: nameById.get(t.guestId) || 'guest' }));
```
Pass `conversations` (or `null` for non-owners) to the view. Imports: `messageStore` and the `User` model.

## Step 7 — UI: `views/listings/show.ejs`, `public/js/chat.js`, `public/css/style.css` (2 h)

**`show.ejs`**: add a chat section **between** the owner/reserve block and the reviews `<hr>`:

| Viewer | Shows |
|---|---|
| Owner | "Guest messages": a button per conversation (`@guestName`, `data-guest-id`), or "No guest messages yet." Clicking one opens the chat panel. |
| Logged-in guest | "Message the host": the chat panel opens directly, with `guestId = currUser._id` |
| Logged out | "Log in to message the host" → `/login` |

The chat panel is one shared block:
```html
<div id="chat" class="chat-panel" hidden
     data-listing-id="<%= listing._id %>"
     data-user-id="<%= currUser._id %>"
     data-guest-id="<%= isOwnerViewing ? '' : currUser._id %>">
  <ul class="chat-messages" aria-live="polite"></ul>
  <p class="chat-error text-danger" hidden></p>
  <form class="chat-form">
    <input class="form-control" name="text" maxlength="1000" autocomplete="off" placeholder="Write a message…" required>
    <button class="btn btn-dark" type="submit">Send</button>
  </form>
</div>
```
Scripts at the bottom, **only when logged in**: `<script src="/socket.io/socket.io.js"></script>` then `<script src="/js/chat.js"></script>`.

**`public/js/chat.js`** (new):
1. Reads `data-*` from `#chat`. Guests start with `guestId` from the attribute, and owners start with none until they click a guest.
2. `const socket = io({ transports: ['websocket'] });` (D3).
3. `join(guestId)`: `emitWithAck('chat:join', { listingId, guestId })`. On `ok`, clear the list, render `messages`, unhide the panel, and scroll to the bottom. Otherwise show `error`.
4. `socket.on('connect', () => { if (currentGuestId) join(currentGuestId); })` handles reconnect and failover (D6).
5. `socket.on('chat:message', render)` appends one message.
6. Form submit: `emitWithAck('chat:send', { listingId, guestId, text })`. On `ok`, clear the input (the message arrives through the broadcast, like everyone else's). Otherwise show the error.
7. `render(msg)` builds `<li>` elements with **`textContent` only** (never `innerHTML`, which prevents XSS), shows `senderName` and the local time of `sentAt`, and adds class `mine` when `msg.senderId === userId`.
8. Owner guest buttons: on click, set `currentGuestId`, mark the button active, and `join()`.

**`style.css`**: `.chat-panel` (card background `var(--card)`, `var(--border)`, max-height with scrolling messages), `.chat-messages li` bubbles, and `.mine` aligned right with `var(--brand-gradient)`. Match the existing dusk theme tokens and work at phone width.

## Step 8 — Nginx: `nginx/nginx.conf` (10 min)

Add inside `server { }`, **before** `location /`:
```nginx
    # Socket.IO: WebSocket-only (D3), so plain round robin works, no sticky sessions.
    location /socket.io/ {
      proxy_pass http://wanderlust_app;
      proxy_http_version 1.1;
      proxy_set_header Upgrade    $http_upgrade;   # WebSocket handshake
      proxy_set_header Connection "upgrade";
      proxy_set_header Host       $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_read_timeout 60s;   # Socket.IO pings every 25s, so the connection is never idle this long
    }
```

## Step 9 — Automated test: `scripts/chat-test.js` (new) (1.5 h)

```bash
node scripts/chat-test.js [--base=http://localhost:8080] [--keep] [--cleanup]
```

1. Connects to MongoDB and finds both test users (`TEST_USER` = host, `TEST_USER2` = guest).
2. Creates a temporary listing: `title: '[TEST] Chat test listing'`, owner = host, price 1, location/country `'Test'`, `geometry: { type: 'Point', coordinates: [0, 0] }`.
3. Logs both users in over HTTP and keeps their cookies (as in `race-test.js`).
4. Connects sockets with `io(base, { transports: ['websocket'], extraHeaders: { Cookie } })`. Through Nginx, it reconnects the host socket (up to 10 tries) until it lands on a **different instance** from the guest, using the `instance` from the join reply.
5. Checks, printing ✅/❌ for each:

| # | Check |
|---|---|
| 1 | A socket with no cookie fails with `connect_error` |
| 2 | Guest joins their conversation → `ok`, empty history |
| 3 | Host joins the same conversation → `ok` (prints both instances) |
| 4 | Guest sends → host receives `chat:message` within 2 s, with the right text and sender |
| 5 | Host replies → guest receives it |
| 6 | Guest tries to join a conversation with **someone else's** `guestId` → `Not allowed.` |
| 7 | Host tries to be the guest on their own listing → rejected |
| 8 | Empty message and 1001-character message → rejected. Nothing saved |
| 9 | `<script>alert(1)</script>` round-trips as the exact literal text (stored as data, not changed) |
| 10 | A fresh guest socket that joins gets **history** with the earlier messages, oldest first |
| 11 | `listConversations(listing)` includes the guest |

6. Cleanup (unless `--keep`): delete the listing's messages, delete the listing with `findByIdAndDelete` (triggers the review cascade hook), and `invalidateListingsCache()`. `--keep` leaves them for a manual browser check and prints the listing URL. `--cleanup` only removes leftover `[TEST]` listings owned by the host, plus their messages.
7. Exit code 0 if all checks pass, otherwise 1.

## Step 10 — Verify (1 h)

| # | Criterion | How | Expected |
|---|---|---|---|
| 1 | Automated checks, single instance | `node app.js`, then `node scripts/chat-test.js` | 11 × ✅ |
| 2 | **Automated, across instances** | `docker compose up --build -d`, then `node scripts/chat-test.js --base=http://localhost` | 11 × ✅, with guest and host on **different** instances. This proves the Redis adapter |
| 3 | Real browsers | `chat-test.js --keep`. Log in as `racetest` (host) in Chrome and `racetest2` (guest) in an incognito window, both at the printed listing URL on `http://localhost` | messages appear instantly both ways, the host sees "@racetest2" in Guest messages |
| 4 | XSS in the browser | guest sends `<img src=x onerror=alert(1)>` | shown as plain text, no alert |
| 5 | History on reload | reload either page | the last messages reappear in order |
| 6 | **Failover** | while chatting, `docker compose stop` the instance one side is on (find it in `docker compose logs`) | within a couple of seconds that side reconnects to another instance, history reloads, and messages keep flowing |
| 7 | **Redis outage** | `docker compose stop redis` and keep chatting | no crash (`docker compose ps` shows all apps up). Same-instance messages still arrive, cross-instance ones don't until `docker compose start redis`. All messages are saved (visible after a reload) |
| 8 | Graceful shutdown with open sockets | with both browsers connected, `docker compose stop app1` and check its logs | `Shutdown complete` in about 1 s, **not** "Graceful shutdown timed out" (D7) |
| 9 | Logged-out view | open the listing logged out | "Log in to message the host", and no socket connection in DevTools → Network → WS |
| 10 | Existing features | booking, reviews, `/listings` cache, `scripts/race-test.js` | unchanged |

Afterwards: `node scripts/chat-test.js --cleanup`, then `docker compose down`.

## Step 11 — Docs (15 min)

- `CLAUDE.md` → Architecture: `socket/` (server + chat handlers), `services/messageStore/`, `models/message.js`, and `public/js/chat.js`.
- `CLAUDE.md` → Cross-cutting patterns: **Real-time chat**, covering conversation ID `<listingId>_<guestId>`, authorization on every event, sender always taken from the session, WebSocket-only transport, the Redis adapter with its own clients (D1/D2), and messages saved before broadcast.
- `CLAUDE.md` → Commands: `node scripts/chat-test.js [--base=…] [--keep] [--cleanup]`, which needs `TEST_USER2`/`TEST_PASS2`.

## Suggested commits

1. `Add Message model and message store` (Steps 1–2)
2. `Add Socket.IO server with session auth and Redis adapter` (Steps 3, 5)
3. `Add guest-host chat handlers` (Step 4)
4. `Add chat UI to listing page` (Steps 6–7)
5. `Route WebSocket traffic through Nginx` (Step 8)
6. `Add automated chat test script` (Step 9)
7. `Document real-time chat` (Step 11)

---

## Files touched (summary)

| File | Status |
|---|---|
| `models/message.js` | new |
| `services/messageStore/index.js`, `mongoStore.js` | new |
| `socket/index.js`, `socket/chat.js` | new |
| `public/js/chat.js` | new |
| `scripts/chat-test.js` | new |
| `app.js` | edited: session middleware variable, Socket.IO setup, shutdown |
| `controllers/listing.js` | edited: `showListing` passes `conversations` |
| `views/listings/show.ejs` | edited: chat section and scripts |
| `public/css/style.css` | edited: chat styles |
| `nginx/nginx.conf` | edited: `/socket.io/` location |
| `package.json` | `socket.io`, `@socket.io/redis-adapter`; dev: `socket.io-client` |
| `CLAUDE.md` | edited |
| `.env` | `TEST_USER2`, `TEST_PASS2` (local only) |

## Known limitations (be ready to mention them in an interview)

- **Pub/sub is fire-and-forget.** A message published while an instance is briefly disconnected from Redis isn't redelivered live. It's saved first, so it shows up on the next join or reload. Guaranteed delivery needs a durable log (Redis Streams, Kafka).
- **No WebSocket fallback.** Networks that block WebSockets can't chat (D3). The alternative is polling plus sticky sessions.
- **The host's guest list doesn't update live.** A brand-new conversation appears after a page reload. Only the open conversation is live.
- **No per-socket rate limit.** The HTTP rate limiter doesn't see WebSocket messages, so a logged-in user could spam messages. The fix is a small per-socket counter in Redis.
- **Authorization costs one DB read per message** (`Listing.findById`). That's fine at this scale. Caching the listing owner per socket would remove it.
