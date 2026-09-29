# Phase 5 — Implementation Plan: Notification Microservice (BullMQ)

Spec: [docs/specs/phase-5-notification-microservice.md](../specs/phase-5-notification-microservice.md)
Estimated time: ~1 day. There are 9 steps.

---

## Decisions made while planning (read first)

These come from **running BullMQ, ioredis and nodemailer on this machine against your Redis container**
(BullMQ 6.3.9, ioredis 6.0.0, nodemailer 10.0.12, checked 2026-09-29).

| # | Decision | Why |
|---|---|---|
| D1 | Use **BullMQ 6**, and install **`ioredis` alongside it** in both the main app (already there) and the notification service | BullMQ 6 supports several backends (ioredis, node-redis, Postgres), so `ioredis` is now an *optional peer dependency* that you install yourself. It needs `>=5`, and our ioredis 6 works (tested: queue, worker, retries). |
| D2 | The producer's connection uses **`enableOfflineQueue: false`** | Tested with Redis stopped: using BullMQ's defaults, `queue.add()` was **still pending after 15 s**, so a booking request would hang indefinitely waiting to enqueue its email. With `enableOfflineQueue: false`, it **rejects in 2 ms**, and the booking completes without the email (logged). |
| D3 | The producer's `add()` is wrapped in try/catch and **never fails the user's request** | The booking or review is already saved by then. A lost email is bad, but failing a successful booking because of an email would be worse. The outbox pattern closes this gap and is noted as a limitation. |
| D4 | Every job has a **deterministic job ID**: `booking.confirmed-<bookingId>`, `booking.cancelled-<bookingId>`, `review.created-<reviewId>` | Tested: adding the same `jobId` twice keeps **one** job, so a retried request or a double click can't enqueue two emails (idempotent enqueue). It also lets the test script find the exact job. Tested too: BullMQ **rejects `:` in custom IDs** ("Custom Id cannot contain :"), so the separator is `-`. |
| D5 | Queue defaults: `attempts: 3`, `backoff: { type: 'exponential', delay: 2000 }`, `removeOnComplete: 100`, `removeOnFail: 500` | Tested: failed attempts are retried with doubling delays (0.5 s, then 1 s with a 500 ms base). Jobs that fail all 3 attempts stay in the *failed* set, which works as a simple dead-letter queue. |
| D6 | The worker's connection uses `maxRetriesPerRequest: null` | BullMQ requires it for workers: a worker blocks waiting for jobs and must keep waiting through a Redis outage instead of erroring. |
| D7 | The worker **returns the Ethereal preview URLs** (`{ previews: [...] }`) as the job's result | BullMQ stores return values on the completed job, so the automated test can read the URLs and open each email, proving it was actually sent, not just that the job ran. |
| D8 | Email via **Ethereal** by default (tested: account created in under 1 s, message sent, preview page loads). Real SMTP only if `SMTP_HOST` is set | Free, no API key, and **nothing is ever delivered**, so test addresses like `racetest@example.com` are safe. It also means the service can't spam real people during development. |
| D9 | The notification service gets **only `REDIS_URL`** (plus optional `SMTP_*` / `FAIL_RATE`), **not** the main `.env` | Least privilege: the service never needs MongoDB, Cloudinary or the session secret, so it isn't given them. Jobs carry all the data they need (the spec's "self-contained jobs"). |
| D10 | The Compose Redis is published on **`127.0.0.1:6380`** (localhost only) | The test script runs on your machine and has to inspect the queue. 6379 is taken by `wanderlust-redis`, and binding to `127.0.0.1` keeps it private to this machine. |
| D11 | HTML emails **escape** user-supplied text (listing titles, usernames, review comments) | The same XSS rule as the chat UI (Phase 4): user data is never trusted as HTML, including in an email body. |
| D12 | Missing recipient emails are **skipped**, not errors | Some seeded listings belong to a hardcoded owner ID that may have no user record. A booking on those listings should still email the guest. |

Redis side note: your Redis uses `maxmemory-policy noeviction` (checked), which BullMQ requires. Queued jobs are never silently evicted under memory pressure.

---

## Step 0 — Prerequisites (10 min)

1. Branch: `git checkout -b phase-5-notifications` (from `phase-4-realtime-chat`).
2. Main app: `npm install bullmq@6` (`ioredis@6` is already installed, D1).
3. Test users from Phases 3–4 (`racetest` = host, `racetest2` = guest) are already in `.env`.

## Step 1 — Producer: `queues/notificationQueue.js` (new) (30 min)

```js
const { Queue } = require('bullmq');

const QUEUE_NAME = 'notifications';

// BullMQ takes ioredis connection options (it creates its own client).
const { hostname, port } = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const queue = new Queue(QUEUE_NAME, {
  connection: {
    host: hostname,
    port: Number(port) || 6379,
    // Fail fast when Redis is down. With BullMQ's defaults, add() waits
    // indefinitely (tested), which would hang the user's booking request.
    enableOfflineQueue: false,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }, // retry after 2s, then 4s
    removeOnComplete: 100,                         // keep the last 100 for inspection
    removeOnFail: 500,                             // failed jobs stay: a simple dead-letter queue
  },
});

// Without a listener BullMQ prints a full stack trace on every reconnect
// attempt during a Redis outage (tested). Log at most once a minute instead.
let lastErrorLog = 0;
queue.on('error', (err) => {
  if (Date.now() - lastErrorLog > 60_000) {
    console.log('Notification queue unavailable:', err.message);
    lastErrorLog = Date.now();
  }
});

// Enqueue a notification. Never throws: the booking/review is already saved,
// so a queue problem must not turn a success into an error for the user.
// `jobId` makes enqueueing idempotent: the same id twice is one job.
module.exports.publishNotification = async (name, data, jobId) => {
  try {
    await queue.add(name, data, { jobId });
  } catch (err) {
    console.log(`Could not enqueue ${name} (${jobId}):`, err.message);
  }
};

module.exports.closeNotificationQueue = () => queue.close().catch(() => {});
module.exports.QUEUE_NAME = QUEUE_NAME;
```

## Step 2 — Publish from the controllers (45 min)

Jobs are **self-contained** (D9): they carry emails, names, titles and dates, so the worker never reads MongoDB.

**`controllers/bookings.js` → `createBooking`**
- Load the listing with its owner: `Listing.findById(listingId).populate('owner', 'username email')`.
- After the success check (`if (outcome.clash)` returned already), **before** the flash and redirect:
  ```js
  const { booking } = outcome;
  await publishNotification('booking.confirmed', {
    bookingId: booking._id.toString(),
    guestEmail: req.user.email,
    guestName: req.user.username,
    hostEmail: listing.owner?.email || null,
    hostName: listing.owner?.username || null,
    listingTitle: listing.title,
    checkIn: checkIn.toISOString(),
    checkOut: checkOut.toISOString(),
    guests,
    totalPrice,
  }, `booking.confirmed-${booking._id}`);
  ```
  This runs **after** the lock is released (Phase 3), so email work never lengthens the time the lock is held.

**`controllers/bookings.js` → `cancelBooking`**
- Load **before** deleting, since the data is gone afterwards:
  ```js
  const booking = await Booking.findById(bookingId)
    .populate('user', 'username email')
    .populate({ path: 'listing', select: 'title owner', populate: { path: 'owner', select: 'username email' } });
  ```
- Delete, then `publishNotification('booking.cancelled', { bookingId, guestEmail, guestName, hostEmail, listingTitle, checkIn, checkOut }, \`booking.cancelled-${bookingId}\`)`.

**`controllers/reviews.js` → `postReview`**
- `Listing.findById(id).populate('owner', 'username email')`. Saving a document with a populated path is fine, because Mongoose stores the ID.
- After the saves and the cache invalidation, **skip** if the reviewer is the owner (`listing.owner?._id.equals(req.user._id)`) or the owner has no email. Otherwise:
  ```js
  await publishNotification('review.created', {
    reviewId: newreview._id.toString(),
    hostEmail: listing.owner.email,
    hostName: listing.owner.username,
    listingTitle: listing.title,
    reviewerName: req.user.username,
    rating: newreview.rating,
    comment: newreview.comment,
  }, `review.created-${newreview._id}`);
  ```

**`app.js` shutdown**: add `await closeNotificationQueue();` next to the other connection closes.

✅ `node app.js`, then book a stay: `docker exec wanderlust-redis redis-cli --scan --pattern "bull:notifications:*"` shows the job keys (a waiting job, since there's no worker yet).

## Step 3 — The notification service: `notification-service/` (new) (2 h)

```
notification-service/
  package.json       name "notification-service"; deps: bullmq@6, ioredis@6, nodemailer@10; "start": "node worker.js"
  package-lock.json  (from npm install, needed for npm ci in Docker)
  worker.js          entry point
  mailer.js          transport: SMTP_* if set, else Ethereal
  templates.js       one function per job name → list of emails
  Dockerfile
  .dockerignore      node_modules
  README.md          the job contract + how to run
```

**`templates.js`**: each job name maps to a function returning an array of `{ to, subject, text, html }`:

| Job | Emails |
|---|---|
| `booking.confirmed` | guest: "Your stay at {title} is confirmed" (dates, guests, total ₹). Host: "New booking for {title}" (guest name, dates) |
| `booking.cancelled` | guest: "Your booking at {title} was cancelled". Host: "A booking for {title} was cancelled" |
| `review.created` | host: "New {rating}★ review on {title}" (reviewer, comment) |

- Recipients with no email are filtered out (D12).
- A small `escapeHtml()` is applied to every value put into `html` (D11). `text` needs no escaping.
- Dates are formatted with `toDateString()`, and money with `toLocaleString('en-IN')`, matching the site.

**`mailer.js`**
```js
// Returns { send(email) -> previewUrl | null }.
// SMTP_HOST set → real SMTP (e.g. a Gmail app password). Otherwise Ethereal:
// a free fake inbox that never delivers, so development can't email real people.
```
- Ethereal: `nodemailer.createTestAccount()` once at startup, then `createTransport({ host, port, secure, auth })`.
- `send()` returns `nodemailer.getTestMessageUrl(info)` (a URL for Ethereal, `false` for real SMTP, which we normalise to `null`).
- From address: `Wanderlust <no-reply@wanderlust.test>`.

**`worker.js`**
1. `const mailer = await createMailer();`. If Ethereal is unreachable, log and `process.exit(1)` (Docker's restart policy retries).
2. `new Worker('notifications', processor, { connection: { host, port, maxRetriesPerRequest: null }, concurrency: 5 })` (D6), with the connection parsed from `REDIS_URL` like the producer.
3. `processor(job)`:
   - `FAIL_RATE` (0–1): `if (Math.random() < FAIL_RATE) throw new Error('Simulated email provider failure')`. This is for the retry demo only.
   - `const build = templates[job.name]`. If there's no template, throw `Unknown job type` (the job goes to failed).
   - Send each email and collect the preview URLs.
   - `return { previews }` (D7).
4. Log `completed` (job ID and preview URLs) and `failed` (`job.attemptsMade`/`job.opts.attempts` and the reason). Say "gave up" when `attemptsMade >= attempts`.
5. Graceful shutdown on SIGTERM/SIGINT: `await worker.close()` (finishes the jobs in progress), then exit. Force-exit after 8 s, same as the main app.

**`README.md`**: the job contract table from the spec (names, fields, ISO date strings), the environment variables (`REDIS_URL`, `SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`, `FAIL_RATE`), and how to run it locally and in Docker.

**`Dockerfile`**: same shape as the main app's: `node:22-alpine`, `npm ci --omit=dev`, `USER node`, `CMD ["node", "worker.js"]`. No `EXPOSE`, because it serves no HTTP.

✅ Locally: `cd notification-service && npm install && npm start` (uses `wanderlust-redis` on 6379). The job waiting from Step 2 is processed at once, and the log prints 2 preview URLs.

## Step 4 — Main app image excludes the service (2 min)

Add `notification-service` to the root **`.dockerignore`**, so the app image doesn't include another service's code.

## Step 5 — Docker Compose (15 min)

```yaml
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    ports:
      - "127.0.0.1:6380:6379"   # localhost only: lets scripts on this machine inspect the queue (D10)

  notification:
    build: ./notification-service
    restart: unless-stopped
    depends_on:
      - redis
    environment:
      REDIS_URL: redis://redis:6379
      FAIL_RATE: ${FAIL_RATE:-0}   # e.g. FAIL_RATE=0.7 docker compose up -d notification
    # Deliberately no env_file: this service never needs MongoDB/Cloudinary secrets (D9).
```

## Step 6 — Automated test: `scripts/notification-test.js` (new) (1.5 h)

```bash
node scripts/notification-test.js [--base=http://localhost:8080] [--redis=redis://127.0.0.1:6379] [--status]
```
Through Compose: `--base=http://localhost --redis=redis://127.0.0.1:6380`.

`--status` prints the queue's job counts (`waiting`, `active`, `completed`, `failed`, `delayed`) and exits. It's handy for the durability demo.

Otherwise:
1. Connect to MongoDB and open a BullMQ `Queue('notifications')` on `--redis`.
2. Create a temporary listing `'[TEST] Notification test listing'` owned by `TEST_USER` (host). Log in `TEST_USER2` (guest) and `TEST_USER` (host) over HTTP.
3. Run the checks (✅/❌ each):

| # | Check |
|---|---|
| 1 | Guest books random far-future dates → `booking.confirmed-<id>` completes within 30 s |
| 2 | Its result has **2** preview URLs (guest + host), and both return **200** from Ethereal |
| 3 | Guest cancels (`POST /bookings/<id>?_method=DELETE`) → `booking.cancelled-<id>` completes with 2 previews |
| 4 | Guest posts a review → `review.created-<reviewId>` completes with **1** preview (host) |
| 5 | Host reviews their **own** listing → **no** `review.created` job exists for that review |
| 6 | Enqueuing `booking.confirmed-<id>` again with the same ID doesn't create a second job (D4) |

4. Cleanup: delete the listing with `findByIdAndDelete` (which cascades its reviews), delete leftover bookings, and remove the test jobs (`job.remove()`).
5. Exit code 0 if all checks pass.

Waiting: poll `queue.getJob(id)` then `job.getState()` every 500 ms, up to 30 s, and read `job.returnvalue` once it's `completed`.

## Step 7 — Verify (1 h)

| # | Criterion | How | Expected |
|---|---|---|---|
| 1 | End to end, locally | `node app.js`, `cd notification-service && npm start`, `node scripts/notification-test.js` | 6 × ✅ |
| 2 | End to end, Compose | `docker compose up --build -d`, then `node scripts/notification-test.js --base=http://localhost --redis=redis://127.0.0.1:6380` | 6 × ✅ |
| 3 | Emails are readable | open a preview URL from the worker log (`docker compose logs notification`) | a formatted email with the right title, dates and price |
| 4 | **Booking isn't slowed down** | `node scripts/race-test.js --n=1` and compare its timing with Phase 3 | about the same, because the enqueue is ~1 ms and email sending happens elsewhere |
| 5 | **Durability** | `docker compose stop notification`, book a stay in the browser (it succeeds), `--status` shows `waiting: 1`, then `docker compose start notification` | the job is processed on startup, and the email preview appears in the logs |
| 6 | **Retries** | `FAIL_RATE=0.7 docker compose up -d notification`, then book a few stays | logs show failed attempts, then success. Some jobs give up after 3 attempts, and `--status` shows them under `failed` |
| 7 | **Main app isolated from the service** | `docker compose stop notification`: browse, book, review, chat | everything works. Jobs just queue up |
| 8 | **Redis down at enqueue time** | `docker compose stop redis`, then book | the booking still succeeds with no delay (D2), the app logs "Could not enqueue…" once, and nothing crashes |
| 9 | Worker survives a Redis outage | `docker compose stop redis` for about 10 s, then `start redis`, then book | the worker reconnects on its own and processes the new job |
| 10 | Least privilege | `docker compose exec notification env` | only `REDIS_URL`/`FAIL_RATE` (and Node's own variables): no `ATLASDB_URL`, no `SECRET` |
| 11 | Graceful shutdown | `docker compose stop notification`, then check its logs | "shutting down" then a clean exit, well under 10 s |
| 12 | Earlier phases unchanged | `scripts/race-test.js`, `scripts/chat-test.js` | still pass (the race test now also enqueues confirmation emails, which is harmless because Ethereal never delivers) |

Reset afterwards: `FAIL_RATE` back to 0 (`docker compose up -d notification`), then `docker compose down`.

## Step 8 — Docs (15 min)

- `CLAUDE.md` → Architecture: `queues/notificationQueue.js` and `notification-service/` (a separate Node project, its own `package.json`, no DB access).
- `CLAUDE.md` → Cross-cutting patterns: **Notifications**, covering the 3 job types, deterministic job IDs, fail-fast enqueue that never fails the request, retries, and the self-contained job contract.
- `CLAUDE.md` → Commands: `cd notification-service && npm start`, and `node scripts/notification-test.js [--status]`.

## Suggested commits

1. `Add notification queue producer` (Step 1)
2. `Publish notifications for bookings and reviews` (Step 2)
3. `Add notification microservice (BullMQ worker + email)` (Steps 3–4)
4. `Run notification service in Docker Compose` (Step 5)
5. `Add notification end-to-end test script` (Step 6)
6. `Document notification service` (Step 8)

---

## Files touched (summary)

| File | Status |
|---|---|
| `queues/notificationQueue.js` | new |
| `notification-service/` (package.json, package-lock.json, worker.js, mailer.js, templates.js, Dockerfile, .dockerignore, README.md) | new |
| `scripts/notification-test.js` | new |
| `controllers/bookings.js` | edited: `createBooking`, `cancelBooking` |
| `controllers/reviews.js` | edited: `postReview` |
| `app.js` | edited: close the queue on shutdown |
| `docker-compose.yml` | edited: `notification` service, Redis on `127.0.0.1:6380` |
| `.dockerignore` | edited: exclude `notification-service` |
| `package.json` | `bullmq` |
| `CLAUDE.md` | edited |

## Known limitations (be ready to mention them in an interview)

- **Redis down at enqueue time means a lost email.** The booking is saved but the job isn't. The fix is the **transactional outbox**: write the event to MongoDB in the same operation as the booking, and have a small poller move it into the queue.
- **At-least-once delivery.** If the worker crashes after sending but before BullMQ records completion, the job reruns and the email goes twice. The deterministic job ID prevents duplicate *enqueues*, not duplicate *sends*. Guarding sends would need a "sent" record per job ID.
- **Emails are generated from the data at enqueue time.** If a listing is renamed before the job runs, the email shows the old title. That's intentional: the email describes the moment the event happened.
- **One queue for all notification types.** A slow email provider delays review emails behind booking emails. Separate queues or job priorities would fix it.
