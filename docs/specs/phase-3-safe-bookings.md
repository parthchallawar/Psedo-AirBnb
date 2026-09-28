# Phase 3 — Safe Bookings: Fixing the Double-Booking Race Condition

## 1. Goal

Guarantee that **two guests can never book overlapping dates on the same listing**, even when
both click "Reserve" at the same moment and their requests land on different app instances.

## 2. Problem today (real bug in the current code)

[controllers/bookings.js](../../controllers/bookings.js) `createBooking` does:

```
1. clash = Booking.findOne({ listing, checkIn < newCheckOut, checkOut > newCheckIn })
2. if (clash) → reject
3. booking.save()
```

This is a **check-then-act race condition**. Timeline with two simultaneous requests:

```
Request A (app1)                 Request B (app2)
findOne → no clash
                                 findOne → no clash     (A hasn't saved yet)
save()  ✅
                                 save()  ✅   ← DOUBLE BOOKING
```

The gap between step 1 and step 3 is small but real, and gets bigger under load.

## 3. Concepts (keep to these)

| Concept | One-line explanation |
|---|---|
| **Race condition** | The result depends on the timing of concurrent operations. |
| **Critical section** | Code that only one request at a time may run (here: check + insert for one listing). |
| **Distributed lock** | A lock stored in a shared system (Redis) so it works across **all** instances, not just one process. |
| **Lock TTL** | The lock expires automatically, so a crashed instance can't block the listing forever. |
| **Lock token** | A random value per lock holder, so you only release **your own** lock. |

## 4. Why not the simpler options?

| Option | Why not |
|---|---|
| A JS variable or in-process mutex | Only works inside one process. With 3 instances (Phase 2), app1 and app2 each have their own. |
| A unique index in MongoDB | Unique indexes match exact values. They can't express "date ranges must not overlap". |
| A MongoDB transaction | Possible, but a transaction doesn't stop two concurrent *reads* both seeing "no clash" unless you also write to a shared document. It's more moving parts. A Redis lock is simpler and easy to reason about. |

## 5. Scope

**In scope:** Redis lock helper, locking inside `createBooking`, an index for the overlap query, a race-test script.
**Out of scope:** payments, holding dates during checkout, per-date locking.

## 6. Design

### 6.1 Lock helper — new file `utils/lock.js`

```
acquireLock(key, ttlMs) -> token | null
  token = crypto.randomUUID()
  result = SET key token NX PX ttlMs
     NX  = only set if the key does not exist   → atomic "take the lock"
     PX  = expire after ttlMs milliseconds       → auto-release if we crash
  return result === "OK" ? token : null

releaseLock(key, token)
  Run this Lua script (atomic in Redis):
    if redis.call("GET", KEYS[1]) == ARGV[1] then
      return redis.call("DEL", KEYS[1])
    end
    return 0

withLock(key, { ttlMs = 5000, retries = 5, retryDelayMs = 100 }, fn)
  for attempt 1..retries:
     token = acquireLock(key, ttlMs)
     if token: try { return await fn() } finally { await releaseLock(key, token) }
     wait retryDelayMs
  throw new ExpressError(409, "This listing is being booked by someone else. Please try again.")
```

**Why compare-and-delete in Lua?** Suppose request A's lock expires (A was slow), request B
takes the lock, and then A finishes and calls a plain `DEL`. A would delete **B's** lock. Checking
the token first, atomically, prevents that.

**Fail closed:** if Redis is unavailable, `withLock` throws an error (503 "Booking temporarily
unavailable"). Unlike the cache, we must not skip the lock, because a double booking is worse than
a failed request.

### 6.2 Use it — edit `controllers/bookings.js` `createBooking`
- Keep the existing input checks (past date, checkout after checkin) **outside** the lock.
- Wrap only the **overlap check + save** in:
  ```
  withLock(`lock:booking:listing:${listingId}`, {}, async () => { findOne clash … save … })
  ```
- The lock is per listing, so bookings for **different** listings never wait on each other.
- A 409 from `withLock` becomes a flash message plus a redirect back to the listing (not the error
  page). Catch that case in the controller.

### 6.3 Index — edit `models/booking.js`
`bookingSchema.index({ listing: 1, checkIn: 1, checkOut: 1 });`
keeps the overlap query fast, so the time spent inside the lock stays short.
Also add `bookingSchema.index({ user: 1 });` for the My Trips page.

### 6.4 Race test script — new file `scripts/race-test.js`
- Uses Node's built-in `fetch`.
- Logs in as a test user (from env vars `TEST_USER` / `TEST_PASS`) and keeps the session cookie.
- Fires **10 concurrent** `POST /bookings/:listingId` requests with identical future dates
  (`Promise.all`). The listing ID comes from a CLI argument.
- Prints the count of new bookings in MongoDB for that listing and those dates.
- Expected result: **exactly 1**. Run against `main` (before the fix) to show that it's usually more than 1.

## 7. Files changed / added

| File | Change |
|---|---|
| `utils/lock.js` | **new**: `acquireLock`, `releaseLock`, `withLock` |
| `controllers/bookings.js` | overlap check + save runs inside `withLock` |
| `models/booking.js` | indexes |
| `scripts/race-test.js` | **new**: concurrency test |

## 8. Acceptance criteria

- [ ] `node scripts/race-test.js <listingId>` → exactly 1 booking created, 9 rejected.
- [ ] The same test against the old code shows more than 1 booking (proves the bug existed).
- [ ] Normal single bookings still work, and overlapping dates still show "Those dates are already booked."
- [ ] Two bookings on **different** listings at the same time both succeed.
- [ ] After the request, no `lock:booking:*` key remains in Redis (`redis-cli KEYS "lock:*"`).
- [ ] If the app is killed while holding the lock, the key disappears by itself after 5 s.
- [ ] With Redis down, booking shows a "temporarily unavailable" message and creates nothing.

## 9. Demo script

1. `git stash` the fix (or check out the old commit) → run the race test → "3 bookings created" (or some number above 1).
2. Apply the fix → run the race test → "1 booking created, 9 rejected".
3. Run `redis-cli MONITOR` during the test to show the `SET lock:booking:... NX PX 5000` calls.

## 10. Interview explanation

**Two-minute version**
> "I found a real race condition in the booking flow. The code checked for overlapping bookings
> and then inserted, as two separate steps, so two simultaneous requests could both pass the check
> and both insert. I proved it with a script that fires 10 parallel requests: several succeeded.
> Because the app runs as three instances, an in-memory lock wouldn't work, so I used a distributed
> lock in Redis. `SET key token NX PX 5000` atomically takes the lock only if nobody holds it, and
> it expires after 5 seconds, so a crashed server can't block the listing forever. Each holder uses
> a random token, and release is a small Lua script that deletes the key only if the token matches,
> so a slow request can't delete someone else's lock. The lock is per listing, so unrelated
> bookings run in parallel. After the fix, the same test produces exactly one booking."

**Likely questions**

| Question | Answer |
|---|---|
| What if the work takes longer than the TTL? | The lock expires early and another request could enter. So keep the critical section tiny (one indexed query and one insert, a few ms) with a TTL far above it (5 s). For long work you'd extend the lock periodically. |
| Why not lock the whole bookings collection? | It would serialise every booking in the system. Per-listing locks only block requests competing for the same resource. |
| Is a single-Redis lock 100% safe? | If Redis crashes, locks are lost. Redlock (locks on several Redis nodes) or a DB-level constraint gives stronger guarantees. For this scale a single Redis is a reasonable trade-off. |
| Optimistic vs pessimistic locking? | This is pessimistic: take the lock first. Optimistic means writing, then detecting conflicts through a version number and retrying. Optimistic suits low-contention data, pessimistic suits hot resources. |
| Why fail closed here but open for caching? | A cache miss only costs speed. A skipped lock costs correctness, and a double booking means real money and an angry guest. |
