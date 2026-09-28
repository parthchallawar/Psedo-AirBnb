# Wanderlust — System Design Upgrade: Specifications

This folder holds one specification per phase. Each spec says **what** to build and
**why**, the concepts involved, the exact files touched, the acceptance criteria, and an
interview script. Convert each spec into an implementation plan before coding it.

## Target architecture (after all phases)

```
                        ┌─────────────────────┐
   Browser ───────────► │   Nginx  (:80)      │  load balancer
                        │  /          → round robin
                        │  /socket.io → sticky (ip_hash)
                        └─────────┬───────────┘
              ┌───────────────────┼───────────────────┐
         ┌────▼────┐         ┌────▼────┐         ┌────▼────┐
         │  app1   │         │  app2   │         │  app3   │   Express + EJS + Socket.IO
         └────┬────┘         └────┬────┘         └────┬────┘
              └─────────┬─────────┴─────────┬─────────┘
                        │                   │
                 ┌──────▼──────┐     ┌──────▼──────┐
                 │    Redis    │     │ MongoDB     │  listings, users, reviews,
                 │ cache       │     │ (Atlas)     │  bookings, sessions
                 │ rate limits │     └─────────────┘
                 │ locks       │
                 │ pub/sub     │     ┌─────────────┐
                 │ job queue ──┼────►│ notification│  separate service
                 └─────────────┘     │  -service   │  (sends emails)
                                     └─────────────┘
                 ┌─────────────┐
                 │  Cassandra  │  chat messages
                 └─────────────┘
```

## Phases

| # | Spec | Concepts | Depends on | Est. time |
|---|------|----------|-----------|-----------|
| 1 | [Redis caching & rate limiting](phase-1-redis-caching-rate-limiting.md) | Cache-aside, TTL, invalidation, rate limiting | — | 1 day |
| 2 | [Load balancing](phase-2-load-balancing.md) | Horizontal scaling, stateless servers, health checks | 1 | 0.5–1 day |
| 3 | [Safe bookings (no double booking)](phase-3-safe-bookings.md) | Race condition, distributed lock | 1 | 0.5 day |
| 4 | [Real-time chat (WebSocket)](phase-4-realtime-chat.md) | WebSocket, rooms, Redis pub/sub adapter, sticky sessions | 1, 2 | 1.5 days |
| 5 | [Notification microservice](phase-5-notification-microservice.md) | Microservice, message queue, retries | 1 | 1 day |
| 6 | [Cassandra for chat messages](phase-6-cassandra-chat-storage.md) | Wide-column DB, partition key, query-first modelling | 4 | 1 day |
| 7 | [Production basics](phase-7-production-basics.md) | Indexes, pagination, security headers | — | 0.5 day |

The order is chosen so every phase builds on the previous one. Phase 7 is independent and
can be done at any point.

## Prerequisites

- **Docker Desktop for Windows** (with WSL 2). It is currently **not installed / not on PATH**.
  Install it before Phase 1; Redis, Nginx and Cassandra all run as containers.
- Existing `.env` keys stay the same: `ATLASDB_URL`, `SECRET`, `CLOUD_NAME`,
  `CLOUD_API_KEY`, `CLOUD_API_SECRET`, `MAP_TOKEN`.
- **No new paid services or API keys.** Everything new runs locally.
- RAM: ~2 GB for Phases 1–5. Cassandra (Phase 6) needs another ~1.5 GB.

## New environment variables (all phases)

| Variable | Phase | Default | Purpose |
|---|---|---|---|
| `REDIS_URL` | 1 | `redis://127.0.0.1:6379` | Redis connection |
| `PORT` | 2 | `8080` | Port each app instance listens on |
| `INSTANCE_ID` | 2 | OS hostname | Identifies the instance in responses/logs |
| `MESSAGE_STORE` | 6 | `mongo` | `mongo` or `cassandra` — where chat messages live |
| `CASSANDRA_CONTACT_POINTS` | 6 | `127.0.0.1` | Cassandra host(s), comma separated |
| `CASSANDRA_DC` | 6 | `datacenter1` | Cassandra local data center |
| `CASSANDRA_KEYSPACE` | 6 | `wanderlust` | Keyspace name |

## New npm packages (all phases)

| Package | Phase | Why |
|---|---|---|
| `ioredis` | 1 | Redis client (also what BullMQ and the Socket.IO adapter use) |
| `express-rate-limit`, `rate-limit-redis` | 1 | Rate limiting with counters stored in Redis |
| `socket.io`, `@socket.io/redis-adapter` | 4 | WebSockets + cross-instance broadcasting |
| `bullmq` | 5 | Job queue on top of Redis |
| `nodemailer` | 5 | Email (Ethereal test inbox — no key needed) |
| `cassandra-driver` | 6 | Cassandra client |
| `helmet` | 7 | Security headers |

## Shared rules for every phase

1. **Redis is optional for correctness where possible.** If Redis is down, pages must still
   load (cache and rate limiter "fail open"). The exception is the booking lock (Phase 3), which
   must fail closed, because a double booking is worse than a failed request.
2. **No logic duplication.** New cross-cutting code goes in `config/` (connections) or
   `utils/` (helpers), and is imported by controllers.
3. **Keep the existing style.** CommonJS, `module.exports.name = async (req, res) => {}`,
   routes wrapped in `wrapAsync`.
4. Every phase ends with the acceptance criteria passing and the demo steps working.

## The one-minute project pitch (for interviews)

> "Wanderlust is an Airbnb-style app built on Node, Express and MongoDB. I took it from a
> single server to a horizontally scaled setup: Nginx load-balances three app instances, which
> works because the instances are stateless. Sessions live in MongoDB, and cache, rate-limit
> counters and locks live in Redis. I added Redis caching for the listings page, Redis-backed
> rate limiting on login and signup, and a distributed lock that fixes a real double-booking race
> condition. There's real-time guest–host chat over WebSockets, using the Redis adapter so
> messages reach users connected to any instance. Chat history is stored in Cassandra, because
> it's write-heavy, append-only, time-ordered data. Emails are sent by a separate notification
> microservice that consumes jobs from a Redis queue, so a slow email never slows down a booking."
