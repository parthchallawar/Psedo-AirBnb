# Phase 5 — Notification Microservice (Message Queue with BullMQ)

## 1. Goal

Send emails ("booking confirmed", "booking cancelled", "new review on your listing") from a
**separate service**. The main app puts a job on a queue and responds immediately. The
notification service picks the job up and sends the email, retrying if it fails.

## 2. Problem this solves

If the main app sent emails itself, inside the request:
- Every booking would wait for the SMTP server (often 1–3 s).
- If the email provider is down, the booking request fails or hangs, even though the booking itself worked.
- Emails would be lost if the app crashed mid-send.

## 3. Concepts (keep to these)

| Concept | One-line explanation |
|---|---|
| **Microservice** | A small, independently deployable service with one responsibility (here: notifications). |
| **Message queue** | A durable list of jobs between services. The producer adds jobs and the consumer (worker) processes them. |
| **Producer / consumer** | The main app is the producer. The notification service is the consumer. |
| **Asynchronous processing** | The user doesn't wait for the email. It happens in the background. |
| **Retry with exponential backoff** | A failed job is retried after 2 s, 4 s, 8 s… so it doesn't hammer a struggling provider. |
| **Loose coupling** | The main app doesn't know or care how emails are sent. It only knows the job format. |

## 4. Scope

**In scope:** a queue in Redis (BullMQ), a producer in the main app for 3 events, a separate
`notification-service/` Node project with a worker that sends email through **Ethereal** (a
free fake SMTP inbox, no API key), retries, and a Docker Compose service.
**Out of scope:** SMS or push, email templates engine, user notification preferences, a queue dashboard UI.

## 5. Design

### 5.1 Queue
- Library: **BullMQ** (stores jobs in Redis, which we already run).
- Queue name: `notifications`.
- Default job options (set by the producer):
  `attempts: 3`, `backoff: { type: "exponential", delay: 2000 }`,
  `removeOnComplete: 100` (keep the last 100), `removeOnFail: 500`.
  Jobs that fail all 3 attempts stay in the **failed** set, where they can be inspected or retried
  manually. This works as a simple dead-letter queue.

### 5.2 Job contract (the only thing both services share)

Every job is **self-contained**: it carries all the data needed to send the email, so the
notification service **never reads the main app's database**. That's what keeps it independent.

| Job name | Data |
|---|---|
| `booking.confirmed` | `{ bookingId, guestEmail, guestName, hostEmail, hostName, listingTitle, checkIn, checkOut, guests, totalPrice }` |
| `booking.cancelled` | `{ bookingId, guestEmail, guestName, hostEmail, listingTitle, checkIn, checkOut }` |
| `review.created` | `{ hostEmail, hostName, listingTitle, reviewerName, rating, comment }` |

Dates are ISO strings. Write the contract in `notification-service/README.md` too.

### 5.3 Producer (main app) — new file `queues/notificationQueue.js`
- Creates `new Queue("notifications", { connection })`, where the connection options come from `REDIS_URL`.
- Exports `publishNotification(name, data)`:
  - Calls `queue.add(name, data)`.
  - **Wraps it in try/catch and only logs errors.** A queue failure must never fail the user's
    request. The booking is already saved.
- Called **after** the DB write succeeds in:

| Where | Job |
|---|---|
| `controllers/bookings.js` `createBooking` (after save, after the lock is released) | `booking.confirmed` (populate the listing owner to get the host email) |
| `controllers/bookings.js` `cancelBooking` (load the booking with listing and owner **before** deleting it) | `booking.cancelled` |
| `controllers/reviews.js` `postReview` (skip if the reviewer is the owner) | `review.created` |

### 5.4 Notification service — new folder `notification-service/`

```
notification-service/
  package.json        (bullmq, ioredis, nodemailer, dotenv) — its own dependencies
  worker.js           entry point
  mailer.js           nodemailer transport + send function
  templates.js        one function per job name → { to, subject, text, html }
  Dockerfile
  README.md           job contract + how to run
```

**worker.js**
1. Create the mail transport (see below).
2. `new Worker("notifications", processor, { connection, concurrency: 5 })`.
3. `processor(job)`: look up `templates[job.name]`. If there isn't one, throw (the job goes to failed).
   For bookings, send one email to the guest and one to the host. Log the Ethereal preview URL.
4. Log `completed` and `failed` events (including `job.attemptsMade`).
5. Graceful shutdown on SIGTERM: `await worker.close()` (finishes current jobs).

**mailer.js**
- If `SMTP_HOST` is set, use it (real SMTP later, for example a Gmail app password).
- Otherwise, `nodemailer.createTestAccount()` creates an **Ethereal** account at startup, and each
  send logs `nodemailer.getTestMessageUrl(info)`, a link where the email can be viewed in the browser.

**Failure simulation (for the demo):** if the env var `FAIL_RATE` (0–1) is set, the processor
throws randomly at that rate, which shows retries with backoff.

### 5.5 Docker Compose — edit `docker-compose.yml`
Add service `notification` built from `notification-service/Dockerfile`, with
`REDIS_URL=redis://redis:6379`, `depends_on: redis`, and no ports. It's an internal worker only.

Locally without Docker: `cd notification-service && npm install && node worker.js`.

## 6. Files changed / added

| File | Change |
|---|---|
| `queues/notificationQueue.js` | **new**: producer |
| `controllers/bookings.js` | publish `booking.confirmed` / `booking.cancelled` |
| `controllers/reviews.js` | publish `review.created` |
| `notification-service/*` | **new** service (6 files) |
| `docker-compose.yml` | `notification` service |
| `package.json` (root) | `bullmq` |

## 7. Acceptance criteria

- [ ] Booking a stay responds as fast as before. The worker log then shows 2 preview URLs (guest and host), and both open readable emails.
- [ ] Cancelling a booking and posting a review each produce the right email.
- [ ] **Durability:** stop the worker, make a booking (it succeeds), start the worker → the email is sent then.
- [ ] **Retries:** with `FAIL_RATE=0.7`, the logs show failed attempts and a later success. A job that fails 3 times ends up in the failed set.
- [ ] **Isolation:** with the notification service stopped, every page and booking in the main app still works.
- [ ] The notification service has no MongoDB connection and no import from the main app.

## 8. Demo script

1. `docker compose stop notification` → book a stay → "Booking confirmed!" appears instantly.
2. `docker compose start notification` → the logs show the job processed and the preview URL. Open it.
3. Restart with `FAIL_RATE=0.7` → book again → the logs show attempt 1 failed, attempt 2 failed, attempt 3 succeeded.

## 9. Interview explanation

**Two-minute version**
> "Sending emails inside the booking request would make users wait on an SMTP server, and an email
> outage would break bookings. So I split notifications into a separate microservice. When a booking
> is confirmed, the main app writes it to MongoDB and adds a job to a BullMQ queue in Redis, which
> takes about a millisecond, then responds. The notification service is its own Node project with
> its own dependencies and container. It consumes jobs and sends the emails. Jobs are
> self-contained, carrying emails, titles and dates, so the service never touches the main database.
> The only contract between the two services is the job format. Failed jobs retry three times with
> exponential backoff, and jobs that still fail are kept for inspection. Because the queue is
> durable, I can stop the service, keep booking, and all the emails go out when it comes back."

**Likely questions**

| Question | Answer |
|---|---|
| Why a queue and not a direct HTTP call to the service? | With HTTP, if the service is down the call fails and the email is lost, and the caller waits. A queue buffers jobs, absorbs traffic spikes and gives retries for free. |
| Why BullMQ, not Kafka or RabbitMQ? | We already run Redis, and the volume is small. Kafka suits high-throughput event streams with replay. RabbitMQ suits complex routing. Both would be extra infrastructure here. |
| At-least-once delivery, meaning duplicates? | If the worker crashes after sending but before acknowledging, the job retries and the email could go twice. Fixing that needs idempotency (store a sent `bookingId`). For emails, a rare duplicate is acceptable. |
| What if Redis is down when you enqueue? | The booking still succeeds (the enqueue is try/caught) and the email is lost. The fix is the outbox pattern: write the event to Mongo in the same operation, and have a poller push it to the queue. |
| Why is this a microservice and not just a background function? | It's a separate codebase, process and deployment, with its own dependencies. It scales independently (run more workers) and fails independently. |
| Downsides of microservices? | More moving parts, harder debugging across services, network failures, and data duplication. That's why I only extracted one well-bounded piece. |
