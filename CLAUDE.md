# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Wanderlust ("Pseudo-AirBnb") — a server-rendered Express + MongoDB app for property
listings with authentication, reviews, image uploads, and map display. Views are EJS
templates rendered on the server; there is no separate frontend/API layer.

## Commands

There is no build step, linter, or test suite (the `npm test` script is a placeholder
that exits with an error).

```bash
node app.js          # Start the server on http://localhost:8080 (PORT env var overrides)
node init/index.js   # Seed the DB — WIPES the listings collection, then re-inserts sample data
docker run -d --name wanderlust-redis -p 6379:6379 redis:7-alpine   # Redis for caching + rate limiting

docker compose up --build -d   # Full stack: Nginx + 3 app instances + Redis, on http://localhost (port 80)
docker compose down            # Stop the stack

node scripts/race-test.js [listingId] [--n=10] [--base=http://localhost:8080] [--keep]
                      # Fires N concurrent bookings for the same listing/dates and
                      # verifies the booking lock via the actual row count in MongoDB.
                      # Needs TEST_USER/TEST_PASS in .env (a real signed-up user).

node scripts/chat-test.js [--base=http://localhost:8080] [--keep] [--cleanup]
                      # End-to-end guest<->host chat test (auth, cross-instance delivery,
                      # authorization, validation, history). Creates/removes a temporary
                      # [TEST]-titled listing. Needs TEST_USER/TEST_PASS (host) and
                      # TEST_USER2/TEST_PASS2 (guest) in .env.

cd notification-service && npm start
                      # Start the notification microservice worker locally.

node scripts/notification-test.js [--base=http://localhost:8080] [--redis=redis://127.0.0.1:6379] [--status] [--keep]
                      # End-to-end notification microservice test (booking confirmed/cancelled,
                      # review notifications, Ethereal preview URLs, retry/idempotency).
                      # Use --status to inspect queue job counts.

node scripts/cassandra-test.js [--live]
                      # Tests Phase 6 Cassandra chat storage integration, schema CQL validity,
                      # dynamic store switching, TimeUuid generation, and live queries if running.
```

No auto-reload is configured; restart `node app.js` manually after changes (or run it
under `nodemon` if installed globally).

## Required environment (.env, loaded unless NODE_ENV=production)

The app will not start or function without these:

- `ATLASDB_URL` — MongoDB connection string (also used for the session store)
- `SECRET` — express-session + connect-mongo secret
- `CLOUD_NAME`, `CLOUD_API_KEY`, `CLOUD_API_SECRET` — Cloudinary (image uploads)
- `MAP_TOKEN` — Mapbox token (geocoding on create + map rendering on show page)

Optional:

- `REDIS_URL` — Redis connection string, defaults to `redis://127.0.0.1:6379`. Backs
  the listings cache and rate limiters (see below). The app runs without Redis; caching
  and rate limiting just fail open (skip themselves) until it's reachable.
- `PORT` — defaults to `8080`.
- `INSTANCE_ID` — defaults to the OS hostname. Shown in the `X-Instance-Id` response
  header and startup/shutdown logs; set per-container in `docker-compose.yml` (`app1`,
  `app2`, `app3`) so load balancing across instances is visible.
- `TEST_USER2`/`TEST_PASS2` — a second real signed-up user (the guest), used by
  `scripts/chat-test.js` alongside `TEST_USER`/`TEST_PASS` (the host).
- `MESSAGE_STORE` — `mongo` (default) or `cassandra`. Selects the chat message storage backing database.
- `CASSANDRA_CONTACT_POINTS` — comma-separated Cassandra contact points, defaults to `127.0.0.1`.
- `CASSANDRA_DC` — Cassandra local data center name, defaults to `datacenter1`.
- `CASSANDRA_KEYSPACE` — Cassandra keyspace name, defaults to `wanderlust`.

`init/index.js` falls back to `mongodb://127.0.0.1:27017/wanderlust` if `ATLASDB_URL`
is unset, but `app.js` has no such fallback.

## Architecture

Standard Express MVC. Request flow: `app.js` → router (`routes/`) → controller
(`controllers/`) → Mongoose model (`models/`) → EJS view (`views/`).

- **`app.js`** — Entry point. Connects Mongoose, configures ejs-mate as the EJS engine,
  sets up session (stored in Mongo via connect-mongo), connect-flash, and Passport.
  Mounts three routers and defines the final error-handling middleware that renders
  `views/error.ejs`. Also exposes `GET /health` (used by Docker/Nginx), sets
  `X-Instance-Id` on every response, creates the Socket.IO server (`socket/index.js`),
  and handles SIGTERM/SIGINT for graceful shutdown (closes Socket.IO — which also
  closes the HTTP server — then both MongoDB clients, Cassandra client if enabled, and Redis, before exiting).
- **`socket/index.js`** — Creates the Socket.IO server: reuses the Express session
  middleware (via `io.use()` with a throwaway response object — see the code comment
  for why `io.engine.use()` isn't used) so `socket.request.user` is the logged-in user,
  and wires the `@socket.io/redis-adapter` so events reach sockets on other app
  instances. Uses its own two Redis clients, deliberately separate from
  `config/redis.js`'s (see the code comment on the command-timeout gotcha this avoids).
- **`socket/chat.js`** — `chat:join`/`chat:send` handlers for guest↔host chat.
  Authorizes on every event (never trusts client-sent IDs for who's sending), rejects
  invalid/empty/over-length messages, and saves each message before broadcasting it.
- **`Dockerfile`**, **`docker-compose.yml`**, **`nginx/nginx.conf`** — containerize the
  app and run 3 instances behind Nginx for local load balancing (round robin,
  passive health checks). See Phase 2 docs under `docs/`.
- **`routes/`** — `listing.js` (`/listings`), `review.js` (`/listings/:id/reviews`,
  uses `mergeParams`), `user.js` (`/signup`, `/login`, `/logout`). Routers wire
  middleware (auth, upload, validation) to controller methods.
- **`controllers/`** — `listing.js`, `reviews.js`, `users.js`. Business logic lives here.
- **`models/`** — Mongoose schemas: `Listing`, `Review`, `User`.
- **`middleware.js`** — Auth/authorization guards: `isLoggedIn`, `isOwner`,
  `isReviewAuthor`, plus `saveRedirectUrl`.
- **`middleware/rateLimit.js`** — Redis-backed `authLimiter` and `globalLimiter`
  (`express-rate-limit` + `rate-limit-redis`).
- **`config/redis.js`** — Shared ioredis client + `isRedisReady()`.
- **`config/cassandra.js`** — Shared `cassandra-driver` client + `connectCassandra()`,
  `isCassandraReady()`, and `closeCassandra()`. Bootstraps `cassandra/schema.cql` on startup.
- **`cassandra/schema.cql`** — CQL schema defining keyspace `wanderlust` and query-first tables:
  `messages_by_conversation` (partition: `conversation_id`, cluster: `sent_at` timeuuid DESC) and
  `conversations_by_listing` (partition: `listing_id`, cluster: `guest_id`).
- **`views/`** — `layouts/boilerplate.ejs` is the ejs-mate layout; `includes/` holds
  navbar/footer/flash partials; `listings/` and `users/` hold page templates.
- **`public/`** — Static assets. `js/map.js` reads Mapbox config + listing GeoJSON from
  data attributes injected into the show page and renders the map.
- **`utils/`** — `wrapAsync.js` (wraps async route handlers so rejections reach the
  error middleware), `ExpressError.js` (custom error with `statusCode`), `cache.js`
  (Redis cache-aside helpers used by the listings cache), and `lock.js` (Redis
  distributed lock used by booking creation).
- **`scripts/race-test.js`** — fires N concurrent booking requests for the same
  listing/dates and checks the actual row count in MongoDB; used to verify the booking
  lock. Needs `TEST_USER`/`TEST_PASS` in `.env` (a real signed-up user).
- **`scripts/chat-test.js`** — end-to-end chat test: auth, cross-instance delivery via
  the Redis adapter, authorization rules, input validation, and history. Needs
  `TEST_USER`/`TEST_PASS` (host) and `TEST_USER2`/`TEST_PASS2` (guest) in `.env`.
- **`scripts/notification-test.js`** — end-to-end notification microservice test: verifies
  booking and review email dispatch, Ethereal preview URLs, idempotency, and owner review filtering.
- **`scripts/cassandra-test.js`** — integration test verifying Cassandra schema, interface
  conformance, dynamic store selection, TimeUuid ordering, and live queries when available.
- **`services/messageStore/`** — chat message storage behind one interface
  (`saveMessage`, `getRecentMessages`, `listConversations`), with interchangeable backends:
  `mongoStore.js` (MongoDB fallback) and `cassandraStore.js` (Apache Cassandra polyglot store).
- **`queues/notificationQueue.js`** — BullMQ producer: pushes self-contained notification jobs
  to Redis (`notifications` queue) with `enableOfflineQueue: false` and exponential backoff.
- **`notification-service/`** — standalone notification microservice: independent Node.js
  project (its own `package.json`, Dockerfile, BullMQ worker, Nodemailer) that consumes
  jobs from Redis and sends emails (via Ethereal test inbox or real SMTP) without connecting
  to MongoDB.

### Data model relationships

- `Listing` has an `owner` (ref `User`), an array of `reviews` (ref `Review`), an
  `image` `{ url, filename }`, a `category` (enum), and GeoJSON `geometry`
  (`{ type: "Point", coordinates: [lng, lat] }`).
- `Listing` has a `post('findOneAndDelete')` hook that cascade-deletes its reviews —
  so **delete listings via `findByIdAndDelete` / `findOneAndDelete`** to keep reviews
  from being orphaned.
- `User` uses `passport-local-mongoose`, which adds `username`/hashed password fields;
  the schema itself only declares `email`.

### Cross-cutting patterns

- **Auth**: Passport local strategy. `res.locals.currUser`, `success`, and `error`
  (flash) are set globally in `app.js` and available in every view.
- **Authorization**: `isOwner` (listings) and `isReviewAuthor` (reviews) compare the
  resource's owner/author to `res.locals.currUser._id`.
- **Post-login redirect**: `isLoggedIn` stashes `req.originalUrl` in
  `req.session.redirectUrl`; `saveRedirectUrl` promotes it to `res.locals` before the
  login POST so the user returns to where they were.
- **Validation**: Joi schemas live in `schema.js` (`listingSchema`, `reviewSchema`).
  Note both wrap the payload under a top-level key (`listing` / `review`), matching the
  `listing[field]` form input naming.
- **Image uploads**: multer + `multer-storage-cloudinary` (`cloudConfig.js`). The file
  form field is `listing[image][url]`; the uploaded Cloudinary URL/filename overwrite
  the model's `image` object in the controller. Cloudinary folder: `wanderlust_DEV`.
- **Geocoding**: On create, the listing's `location` string is forward-geocoded via the
  Mapbox SDK and stored as `geometry`.
- **Redis caching**: `GET /listings` (`controllers/listing.js` `index`) is cached in Redis
  for 60s via `utils/cache.js` `getOrSet`, keyed by the normalized filters (search, category,
  price range, sort). Every listing/review create, update or delete calls
  `invalidateListingsCache()` so the cache reflects changes immediately. Responses carry
  an `X-Cache: HIT|MISS` header.
- **Rate limiting**: `middleware/rateLimit.js` exports `authLimiter` (10 req / 15 min per IP,
  on `POST /login` and `POST /signup`) and `globalLimiter` (100 req / min per IP, mounted
  on every request in `app.js`). Both store counters in Redis (`rate-limit-redis`) so all
  app instances share one count. `app.set('trust proxy', 1)` makes the real client IP
  visible once Nginx sits in front.
- **Fail open**: every Redis-backed feature (`config/redis.js`) degrades gracefully —
  if Redis is down or slow (`commandTimeout: 500`), caching and rate limiting are skipped
  rather than breaking the request.
- **Booking concurrency**: `createBooking` (`controllers/bookings.js`) wraps the
  overlap check and insert in `withLock('lock:booking:listing:<id>')` (`utils/lock.js`,
  Redis `SET NX PX` + a Lua compare-and-delete release), so two concurrent requests for
  the same listing can't both pass the overlap check. The lock is per listing (different
  listings never block each other), waits up to ~3s if busy, and — unlike the cache and
  rate limiter — **fails closed**: if Redis is down, booking returns 503 rather than
  risking a double booking. Verified with `scripts/race-test.js`.
- **Real-time chat**: guest↔host chat over Socket.IO (`socket/`). One conversation per
  (listing, guest) pair, id'd as `<listingId>_<guestId>` — a guest and the listing's
  owner are the only two allowed in it, checked on **every** `chat:join`/`chat:send`,
  not just once. The sender is always read from the session (`socket.request.user`),
  never from client-sent data. Client uses **WebSocket-only** transport (`public/js/chat.js`),
  so each connection stays pinned to one app instance and plain Nginx round robin
  works — no sticky sessions needed (contrast with a polling-capable client, which
  would need `ip_hash`). Messages are saved to MongoDB (`services/messageStore/`)
  *before* being broadcast, since Redis pub/sub delivery is fire-and-forget; a message
  missed during a brief Redis blip is recovered from history on the next join/reload.
  Verified with `scripts/chat-test.js`.
- **Notifications**: asynchronous email delivery via BullMQ message queue in Redis
  (`queues/notificationQueue.js`) and a standalone consumer (`notification-service/`).
  Three event types (`booking.confirmed`, `booking.cancelled`, `review.created`) are
  published with deterministic job IDs (`<type>-<id>`) for enqueue idempotency. Jobs are
  self-contained (worker never touches MongoDB). Producer uses `enableOfflineQueue: false`
  and is try/caught so Redis delays or outages never fail user requests. Worker retries failed
  jobs up to 3 times with exponential backoff (2s, 4s...) and moves persistent failures
  to the failed set (dead-letter queue). Verified with `scripts/notification-test.js`.
- **Polyglot Persistence & Cassandra Chat Storage**: listings, bookings, reviews, and users
  remain in MongoDB (which supports relational lookups, joins, and complex queries), whereas
  high-throughput, append-only chat messages can be stored in Apache Cassandra (`MESSAGE_STORE=cassandra`).
  Cassandra tables are modeled query-first: `messages_by_conversation` (partitioned by
  `conversation_id` and clustered by `sent_at` timeuuid descending for sequential history reads) and
  `conversations_by_listing` (tracking active conversations for the host). Both tables are
  written atomically via a single logged batch query. The app defaults to `MESSAGE_STORE=mongo`
  for zero-dependency local development and fallback. Verified with `scripts/cassandra-test.js`.

## Known quirks / gotchas

Be careful — this codebase has redundant and inconsistent middleware that is easy to
misread:

- **Listing validation is effectively disabled.** `validateListing` is defined multiple
  times: the real Joi-backed versions live in `app.js` and `middleware.js`, but the copy
  used by `routes/listing.js` (line ~22) is a **no-op that just logs and calls `next()`**.
  Creating a listing does not actually validate against `listingSchema`. If you need
  real validation, wire in the `middleware.js` `validateListing` (and note it also needs
  `listingSchema`/`ExpressError` imported there).
- `routes/review.js` defines an unused `validateListing` that references an undefined
  `listingSchema` — dead code; don't call it.
- Middleware order on the listing PUT/DELETE routes lists `isOwner` before `isLoggedIn`
  in places. Since `isOwner` reads `res.locals.currUser._id`, it depends on an
  authenticated user; prefer `isLoggedIn, isOwner` ordering when editing these routes.
- `Review`'s `createdAt` default is `Date.now()` (called once at module load), not
  `Date.now` — all reviews get the server's start time, not their creation time.
- `init/index.js` hardcodes a single `owner` ObjectId (`686a259adc83c042a4761937`) for
  all seeded listings; that user must exist for owner-based views to resolve.
- The server port (8080) and the error-render middleware ignore `statusCode` — every
  error renders `error.ejs` with a 200. Change `app.js` if you need proper status codes.
- Several handlers `console.log` request bodies and listings; these are debug leftovers.

## Conventions

- CommonJS (`require`/`module.exports`) throughout; Node engine pinned to v22.14.0.
- Controllers export methods as `module.exports.name = async (req, res) => {...}` and
  are attached to routes via `router.route(...)` chains wrapped in `wrapAsync`.
- Form inputs use bracket-nested names (`listing[title]`, `review[rating]`) so
  `express.urlencoded({ extended: true })` parses them into nested objects.
