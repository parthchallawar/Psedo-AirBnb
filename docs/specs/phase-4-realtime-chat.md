# Phase 4 — Real-Time Guest ↔ Host Chat (WebSocket / Socket.IO)

## 1. Goal

A logged-in guest can message a listing's host from the listing page, and the host replies in
real time with no page refresh. It must work when the guest and host are connected to
**different app instances**.

## 2. Concepts (keep to these)

| Concept | One-line explanation |
|---|---|
| **WebSocket** | A long-lived, two-way connection. The server can push data to the browser (HTTP can't). |
| **Socket.IO** | Library on top of WebSocket: events, rooms, auto-reconnect. |
| **Room** | A named group of sockets. Emitting to a room reaches everyone in it. One conversation is one room. |
| **Redis adapter (pub/sub)** | When app1 emits to a room, it publishes to Redis. app2 and app3 are subscribed and deliver to their own sockets in that room. |
| **Sticky sessions** | All requests of one socket connection must reach the same instance, because the connection handshake spans several HTTP requests. |

## 3. Scope

**In scope**
- 1-to-1 chat per (listing, guest) pair between the guest and the listing owner.
- The last 50 messages load when the chat opens.
- Chat UI on the listing show page: guests see a "Message the host" box, and the owner sees the list of guests who messaged, and can open each conversation.
- Messages stored in MongoDB behind a **message store interface** (Phase 6 swaps the implementation for Cassandra).
- Redis adapter and Nginx sticky routing for `/socket.io/`.

**Out of scope:** typing indicators, read receipts, online presence, file attachments, a global
inbox page, push notifications.

## 4. Design

### 4.1 Conversation identity
- `conversationId = "<listingId>_<guestId>"`, which is deterministic, so no lookup table is needed.
- Allowed participants: `guestId`, and `listing.owner`. The owner can't start a conversation with
  their own listing.

### 4.2 Message store interface — new folder `services/messageStore/`

```
services/messageStore/index.js        → exports the implementation chosen by MESSAGE_STORE (default "mongo")
services/messageStore/mongoStore.js   → implementation for this phase
```

Every implementation exports the same three functions:

| Function | Returns |
|---|---|
| `saveMessage({ conversationId, listingId, guestId, senderId, senderName, text })` | the saved message `{ conversationId, senderId, senderName, text, sentAt }` |
| `getRecentMessages(conversationId, limit = 50)` | array, **oldest → newest** |
| `listConversations(listingId)` | array of `{ guestId, lastMessageAt }`, newest first |

Controllers and socket handlers only call these functions. Because nothing else touches the
database directly, switching to Cassandra later is a one-env-var change.

### 4.3 Mongo model — new file `models/message.js`
Fields: `conversationId` (String, indexed), `listing` (ObjectId → Listing), `guest` (ObjectId → User),
`sender` (ObjectId → User), `senderName` (String), `text` (String, max 1000), `sentAt` (Date, default `Date.now`).
Index: `{ conversationId: 1, sentAt: -1 }`, and `{ listing: 1, sentAt: -1 }` for `listConversations`
(an aggregation grouped by `guest` using `$max: sentAt`).

### 4.4 Server wiring — `app.js` + new file `socket/index.js`
1. Replace `app.listen(PORT)` with `const server = http.createServer(app); server.listen(PORT)`.
2. `const io = new Server(server)`.
3. **Share login with sockets:** keep the session middleware in a variable (`sessionMiddleware`)
   and give it to Socket.IO:
   ```
   io.engine.use(sessionMiddleware);
   io.engine.use(passport.session());
   ```
   Then `socket.request.user` is the logged-in user. **Reject connections with no user**
   (`io.use` middleware → `next(new Error("unauthorized"))`).
4. **Redis adapter:** `io.adapter(createAdapter(pubClient, subClient))`, where
   `pubClient = redis.duplicate()` and `subClient = redis.duplicate()`. Pub/sub needs dedicated
   connections: a subscribed connection can't run normal commands.
5. Socket event handlers live in `socket/chat.js`, registered from `socket/index.js`.
6. Graceful shutdown (Phase 2) also calls `io.close()`.

### 4.5 Events

| Direction | Event | Payload | Server behaviour |
|---|---|---|---|
| client → server | `chat:join` | `{ listingId, guestId }` | Load the listing. Check that the user is `guestId` or the owner (else emit `chat:error`). `socket.join(conversationId)`. Emit `chat:history` with `getRecentMessages`. |
| client → server | `chat:send` | `{ listingId, guestId, text }` | Same permission check. Trim the text and reject if it's empty or over 1000 chars. `saveMessage`. `io.to(conversationId).emit("chat:message", msg)`. |
| server → client | `chat:history` | `Message[]` | Render the list. |
| server → client | `chat:message` | `Message` | Append to the list. |
| server → client | `chat:error` | `{ message }` | Show inline. |

**Security rules**
- Never trust IDs sent by the client for *who is sending*: `senderId` always comes from `socket.request.user`.
- Re-check permission on every `chat:send`, not only on join.
- On the client, render message text with `textContent`, **never** `innerHTML`, to prevent XSS.

### 4.6 UI
- **`views/listings/show.ejs`**
  - Logged-in and **not** the owner: a "Message the host" panel with a message list, an input and a Send button. It uses `guestId = currUser._id`.
  - **Owner:** a "Guest messages" panel listing the guests from `listConversations` (the usernames come from the `User` collection in the show controller). Clicking one opens the same chat panel with that `guestId`.
  - Not logged in: a "Log in to message the host" link.
- **`public/js/chat.js`** (new): reads `listingId`, `guestId` and the current user ID from `data-` attributes, connects with `io()`, emits `chat:join`, and handles the events. The Socket.IO client script comes from `/socket.io/socket.io.js` (served automatically by the server).
- **`controllers/listing.js` `showListing`:** when the owner is viewing, pass `conversations` (from `listConversations` plus usernames) to the view.

### 4.7 Nginx — edit `nginx/nginx.conf`
Add a second upstream with **`ip_hash`** (the same client IP always goes to the same instance) and
a location for the Socket.IO path, with the WebSocket upgrade headers:

```nginx
upstream wanderlust_ws {
  ip_hash;
  server app1:8080;
  server app2:8080;
  server app3:8080;
}

location /socket.io/ {
  proxy_pass http://wanderlust_ws;
  proxy_http_version 1.1;
  proxy_set_header Upgrade    $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host       $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_read_timeout 60s;
}
```
Normal pages stay round robin. Only socket traffic is sticky.

## 5. Files changed / added

| File | Change |
|---|---|
| `app.js` | `http.createServer`, Socket.IO setup, export `sessionMiddleware` for reuse |
| `socket/index.js` | **new**: io creation, auth middleware, Redis adapter |
| `socket/chat.js` | **new**: `chat:join` / `chat:send` handlers |
| `services/messageStore/index.js`, `mongoStore.js` | **new** |
| `models/message.js` | **new** |
| `controllers/listing.js` | `showListing` passes `conversations` for the owner |
| `views/listings/show.ejs` | chat panels |
| `public/js/chat.js` | **new**: client logic |
| `public/css/style.css` | chat panel styles (match the existing theme) |
| `nginx/nginx.conf` | `/socket.io/` location + `ip_hash` upstream |
| `package.json` | `socket.io`, `@socket.io/redis-adapter` |

## 6. Acceptance criteria

- [ ] Guest (browser 1) and host (browser 2, incognito) see each other's messages instantly, with no refresh.
- [ ] Reloading the page shows the last 50 messages in order.
- [ ] Under Docker Compose, with the guest's socket on app1 and the host's on app2 (check the logs), messages are still delivered. This proves the Redis adapter works.
- [ ] Stopping the Redis adapter (comment it out) makes cross-instance delivery fail. Useful to show why it's needed.
- [ ] A third user can't join someone else's conversation by editing `guestId` in DevTools (they get `chat:error`).
- [ ] A logged-out socket connection is rejected.
- [ ] Sending `<script>alert(1)</script>` shows it as plain text.
- [ ] Messages over 1000 characters, or empty ones, are rejected.

## 7. Demo script

1. `docker compose up`. Open `http://localhost/listings/<id>` as a guest in Chrome, and as the owner in an incognito window.
2. Guest sends "Is parking available?". It appears instantly on the owner's screen.
3. `docker compose logs app1 app2 app3 | grep socket` shows the two sockets on different instances.
4. Explain: app1 received the message, published it to Redis, and app2 delivered it to the owner.

## 8. Interview explanation

**Two-minute version**
> "I added real-time guest-to-host chat with Socket.IO. HTTP is request-response, so the server
> can't push a new message to the host. A WebSocket keeps a two-way connection open. Each
> conversation is a Socket.IO room named by listing ID plus guest ID. Sockets reuse the Express
> session, so I know who's connected without a separate login, and every message is re-authorised
> on the server. The sender ID always comes from the session, never from the client.
> The interesting part is scaling. With three instances, the guest might be connected to app1 and
> the host to app2, and app1's room only knows its own sockets. The Redis adapter fixes that: every
> emit is published to Redis, and all instances deliver it to their local sockets in that room. In
> Nginx, socket traffic uses ip_hash stickiness, because a Socket.IO connection starts with HTTP
> polling requests that must all reach the same server before upgrading to a WebSocket. Normal page
> traffic stays round robin. Messages go through a storage interface, which let me later move
> them to Cassandra without touching the socket code."

**Likely questions**

| Question | Answer |
|---|---|
| WebSocket vs polling vs SSE? | Polling repeatedly asks "anything new?", which is wasteful and laggy. SSE is server-to-client only. WebSocket is full-duplex, which chat needs. |
| Why sticky sessions for sockets but not pages? | Pages are stateless requests. A socket is a stateful connection whose handshake spans several requests, and they must all hit the instance holding that connection. |
| What if an instance dies? | Its sockets disconnect and Socket.IO auto-reconnects them, usually to another instance. Messages are persisted, so history reloads on rejoin. |
| Why Redis pub/sub here? | It's lightweight, in-memory fan-out between instances, and we already run Redis. Kafka would be overkill for this. |
| Is pub/sub delivery guaranteed? | No, it's fire-and-forget. That's why the message is saved to the DB **before** broadcasting: a missed live event is recovered from history. |
| How do you stop spoofing? | The sender comes from the server-side session, and permission is checked on every send, not just on join. |
