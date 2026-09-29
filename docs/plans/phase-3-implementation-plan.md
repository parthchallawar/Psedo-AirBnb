# Phase 3 — Implementation Plan: Safe Bookings (Fixing the Double-Booking Race)

Spec: [docs/specs/phase-3-safe-bookings.md](../specs/phase-3-safe-bookings.md)
Estimated time: ~half a day. There are 7 steps.

The order is deliberate: **prove the bug first, then fix it, then prove the fix** with the
same script. That before/after result is the core of the interview story.

---

## Decisions made while planning (read first)

| # | Decision | Why |
|---|---|---|
| D1 | Write and run the race-test script **before** touching the booking code (Step 1) | You get a real "before" number (for example, "7 of 10 requests created a booking") from your own app. Recreating the bug later with `git stash` is fiddly. |
| D2 | The script picks **random far-future dates** on every run, and **deletes the bookings it created** at the end | The test hits your real Atlas database. Random dates mean runs never collide with each other or with real bookings, and cleanup leaves no junk behind. Pass `--keep` to skip cleanup and inspect the rows yourself. |
| D3 | The script classifies each response by its **redirect `Location`**, and uses the **database count** as the real verdict | Every outcome is a `302`: success redirects to `/bookings`, and every rejection redirects back to `/listings/:id`. The status code alone can't tell them apart. Counting the rows in MongoDB is the ground truth. |
| D4 | Keep the HTTP response **outside** the lock. The locked function returns an outcome (`{ clash }` or `{ booking }`), and the controller flashes and redirects after the lock is released | The lock should be held only for the overlap check and the insert, a few milliseconds of DB work. Holding it while building a response makes other requests wait longer. |
| D5 | Waiting requests retry for **up to about 3 s** (30 × 100 ms plus a little random jitter) before giving up | The critical section is two Atlas round trips, about 0.5 s on your network. With 10 simultaneous requests, the last one waits about 10 × 0.5 s in the worst case. A 3 s wait lets most of them get the lock and receive the accurate "Those dates are already booked" message instead of a vague "try again". The jitter stops all waiters from retrying in the same millisecond. |
| D6 | Two error classes in `utils/lock.js`: `LockBusyError` (someone else holds the lock) and `LockUnavailableError` (Redis is down) | The controller turns "busy" into a friendly flash message and a redirect. "Unavailable" becomes a 503 error page (fail closed). They're different situations and deserve different messages. |
| D7 | **Fail closed** only for bookings. The cache and rate limiter keep failing open | This is deliberate, and a good interview point: a missed cache costs speed, but a skipped lock costs a double booking. |
| D8 | Lock TTL is 5 s | That's roughly 10× the measured critical section (about 0.5 s), so it won't expire mid-work, yet a crashed instance only blocks that one listing for 5 s. |
| D9 | Release the lock with a Lua **compare-and-delete** through `redis.eval` | A plain `DEL` could delete another request's lock if ours had already expired. Lua runs atomically inside Redis. If the release itself fails, just log it: the TTL cleans up. |
| D10 | Add the indexes `{ listing, checkIn, checkOut }` and `{ user }` to the Booking model | The overlap query runs *inside* the lock, so making it fast shortens how long everyone waits. `{ user }` serves the My Trips and profile pages. Mongoose creates both at startup (`autoIndex`). |

---

## Step 0 — Prerequisites (10 min)

1. Branch: `git checkout -b phase-3-safe-bookings` (from `phase-2-load-balancing`).
2. Redis is running: `docker ps` shows `wanderlust-redis`.
3. **A test user.** Sign up once through the UI (for example username `racetest`, any email and password).
   The script logs in as this user. It doesn't create users, so no junk accounts pile up.
4. Add to `.env` (local only, not committed):
   ```
   TEST_USER=racetest
   TEST_PASS=<the password you chose>
   ```

## Step 1 — Race-test script, run against the CURRENT code (45 min)

New file: **`scripts/race-test.js`**. Usage:

```bash
node scripts/race-test.js [listingId] [--n=10] [--base=http://localhost:8080] [--keep]
```

What it does, in order:

1. Loads `.env` (dotenv) and connects to MongoDB with `ATLASDB_URL` (Mongoose + the `Booking` and `Listing` models).
2. **Listing:** uses the `listingId` argument, or else the first listing in the DB. Prints its title.
3. **Dates:** check-in is a random day 300–700 days from today, and check-out is 2 days later. Both are
   formatted as `YYYY-MM-DD`, exactly like the `<input type="date">` form fields.
4. **Log in:** `POST {base}/login` with `username`/`password`, `redirect: 'manual'`. Reads the
   session cookie from `res.headers.getSetCookie()` (Node 20+). If the response doesn't redirect to
   `/listings` (a failed login redirects back to `/login`), prints "login failed, check TEST_USER/TEST_PASS" and exits.
5. **Fire N concurrent bookings** with `Promise.all`: each is a `POST {base}/bookings/{listingId}` with body
   `booking[checkIn]=…&booking[checkOut]=…&booking[guests]=1` (urlencoded), the session `Cookie`
   header, and `redirect: 'manual'`. Record each response's `Location`, the instance that answered
   (`X-Instance-Id`), and the time taken.
6. **Report:**
   ```
   Listing:   Cozy Beachfront Cottage (65f…)
   Dates:     2027-11-03 → 2027-11-05
   Sent:      10 concurrent requests to http://localhost:8080
   Responses: 7 → /bookings (success)   3 → /listings/… (rejected)
   Instances: app1 ×4, app2 ×3, app3 ×3        (only through Nginx)
   DB check:  7 bookings exist for these dates  ❌ DOUBLE BOOKING
   ```
   The DB check counts `Booking.countDocuments({ listing, checkIn, checkOut })` with the same `Date` values the controller builds (`new Date('YYYY-MM-DD')`).
   It prints `✅ SAFE` if the count is exactly 1, and `❌ DOUBLE BOOKING` if it's more.
7. **Cleanup** (unless `--keep`): `Booking.deleteMany` for that listing, user and those dates. Disconnect and exit with code 0 if safe, 1 if not.

Rate limits aren't a problem: 1 login (auth limit 10/15 min) plus 10 bookings (global limit 100/min).

**Run it now, before any fix:**
```bash
node app.js                                  # terminal 1
node scripts/race-test.js                    # terminal 2
```
✅ Expected: **more than 1 booking** (most likely all 10). Write the number down. It's your "before" result.

> Commit the script on its own now (`Add booking race-condition test script`), so the history clearly shows the bug being reproduced before it's fixed.

## Step 2 — Lock helper: `utils/lock.js` (new) (40 min)

```js
const crypto = require('crypto');
const { redis, isRedisReady } = require('../config/redis.js');

// Someone else holds the lock and it didn't free up in time.
class LockBusyError extends Error {}
// Redis is down: we can't guarantee mutual exclusion, so we refuse (fail closed).
class LockUnavailableError extends Error {}

// Delete the key only if it still holds OUR token. Runs atomically in Redis, so we
// can never delete a lock another request took after ours expired.
const RELEASE_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Try once to take the lock. Returns our token, or null if someone else holds it.
const acquireLock = async (key, ttlMs) => {
  if (!isRedisReady()) throw new LockUnavailableError('Redis is not available');
  const token = crypto.randomUUID();
  try {
    // NX = only set if the key doesn't exist (take the lock atomically)
    // PX = auto-expire after ttlMs, so a crashed instance can't hold it forever
    const result = await redis.set(key, token, 'PX', ttlMs, 'NX');
    return result === 'OK' ? token : null;
  } catch (err) {
    throw new LockUnavailableError(err.message);
  }
};

const releaseLock = async (key, token) => {
  try {
    await redis.eval(RELEASE_SCRIPT, 1, key, token);
  } catch (err) {
    // Not fatal: the TTL will expire the lock anyway.
    console.log('Lock release failed:', err.message);
  }
};

// Run fn() while holding the lock `key`. Waits up to ~retries × retryDelayMs for it.
const withLock = async (key, fn, { ttlMs = 5000, retries = 30, retryDelayMs = 100 } = {}) => {
  for (let attempt = 0; attempt < retries; attempt++) {
    const token = await acquireLock(key, ttlMs);
    if (token) {
      try {
        return await fn();
      } finally {
        await releaseLock(key, token);
      }
    }
    // Small random jitter so waiting requests don't all retry at the same instant.
    await sleep(retryDelayMs + Math.floor(Math.random() * 50));
  }
  throw new LockBusyError(`Timed out waiting for lock ${key}`);
};

module.exports = { withLock, acquireLock, releaseLock, LockBusyError, LockUnavailableError };
```

Notes
- ioredis: `redis.set(key, value, 'PX', ms, 'NX')` returns `'OK'` or `null`. `redis.eval(script, numKeys, ...keysAndArgs)`.
- `config/redis.js` has `commandTimeout: 500`, so a hung Redis becomes an error in 0.5 s. That turns into `LockUnavailableError`, and the request fails closed quickly instead of hanging.

✅ Quick check in a Node REPL with the Redis container running: `withLock('t', async () => 42)` → `42`, and afterwards `redis-cli GET t` → `(nil)`.

## Step 3 — Use the lock: `controllers/bookings.js` `createBooking` (30 min)

Keep everything before the clash check exactly as it is (listing lookup, date parsing, past-date and
order checks, all outside the lock). Replace the section from `const clash = …` through `await booking.save()` with:

```js
  const nights = Math.ceil((checkOut - checkIn) / (1000 * 60 * 60 * 24));
  const totalPrice = nights * listing.price;

  // Check-then-insert must be atomic per listing: without the lock, two
  // concurrent requests can both see "no clash" and both insert. The lock is
  // in Redis (not memory) so it holds across all app instances.
  let outcome;
  try {
    outcome = await withLock(`lock:booking:listing:${listingId}`, async () => {
      const clash = await Booking.findOne({
        listing: listingId,
        checkIn: { $lt: checkOut },
        checkOut: { $gt: checkIn },
      });
      if (clash) return { clash: true };

      const booking = new Booking({
        listing: listingId,
        user: req.user._id,
        checkIn,
        checkOut,
        guests,
        totalPrice,
      });
      await booking.save();
      return { booking };
    });
  } catch (err) {
    if (err instanceof LockBusyError) {
      req.flash('error', 'Someone else is booking this listing right now. Please try again.');
      return res.redirect(`/listings/${listingId}`);
    }
    if (err instanceof LockUnavailableError) {
      // Fail closed: without the lock we can't rule out a double booking.
      throw new ExpressError(503, 'Booking is temporarily unavailable. Please try again shortly.');
    }
    throw err;
  }

  if (outcome.clash) {
    req.flash('error', 'Those dates are already booked.');
    return res.redirect(`/listings/${listingId}`);
  }

  req.flash('success', 'Booking confirmed!');
  res.redirect('/bookings');
```

Imports at the top:
```js
const ExpressError = require('../utils/ExpressError.js');
const { withLock, LockBusyError, LockUnavailableError } = require('../utils/lock.js');
```

- The lock key is **per listing**, so bookings for different listings never wait on each other.
- The 503 goes through the existing error middleware and renders `error.ejs` with status 503.

## Step 4 — Indexes: `models/booking.js` (5 min)

Before `module.exports`:
```js
// The overlap check in createBooking runs inside a Redis lock, so it must be fast.
bookingSchema.index({ listing: 1, checkIn: 1, checkOut: 1 });
// My Trips and profile pages look up bookings by user.
bookingSchema.index({ user: 1 });
```

✅ After restarting the app, `db.bookings.getIndexes()` in mongosh (or Atlas → Collections → Indexes) lists both.

## Step 5 — Verify (45 min)

| # | Criterion | How | Expected |
|---|---|---|---|
| 1 | **Fix works (single instance)** | `node app.js`, then `node scripts/race-test.js` | DB check: **exactly 1** ✅ SAFE, 9 rejected |
| 2 | **Fix works across instances** | `docker compose up --build -d`, then `node scripts/race-test.js --base=http://localhost` | ✅ SAFE, with responses spread over app1, app2 and app3. This proves the lock is distributed, not per process |
| 3 | Bigger burst | `node scripts/race-test.js --n=25` | still exactly 1 |
| 4 | Normal booking still works | book dates in the browser | "Booking confirmed!", and it appears in My Trips |
| 5 | Overlap still rejected | book overlapping dates on the same listing | "Those dates are already booked." |
| 6 | Different listings don't block each other | run the race test on two different listing IDs at the same time (two terminals) | both ✅ SAFE, each with its own 1 booking |
| 7 | No leftover locks | after the tests: `docker exec wanderlust-redis redis-cli --scan --pattern "lock:*"` | empty |
| 8 | Lock expires by itself | `docker exec wanderlust-redis redis-cli SET lock:booking:listing:<id> fake PX 5000 NX`, then book that listing right away, then again after 5 s | first attempt: "Someone else is booking…" (after about 3 s). After 5 s: succeeds |
| 9 | **Fail closed** | `docker stop wanderlust-redis`, then book in the browser | 503 page "Booking is temporarily unavailable", and **no** booking row. Listings and login still work (they fail open). `docker start wanderlust-redis` afterwards |
| 10 | Before/after on record | compare with the Step 1 number | for example, "before: 10/10 created → after: 1/10" |

Test 8 is the "crashed instance" case: a lock nobody will ever release, cleaned up by the TTL.

## Step 6 — Docs (10 min)

- `CLAUDE.md` → Cross-cutting patterns: add **Booking concurrency**: `createBooking` wraps
  the overlap check and insert in `withLock('lock:booking:listing:<id>')` (`utils/lock.js`, Redis
  `SET NX PX` plus a Lua compare-and-delete release). It fails **closed** (503) when Redis is down,
  unlike the cache and rate limiter.
- `CLAUDE.md` → Commands: `node scripts/race-test.js [listingId] [--n=10] [--base=…] [--keep]`, which needs `TEST_USER`/`TEST_PASS` in `.env`.
- `CLAUDE.md` → Architecture: add `utils/lock.js` and `scripts/`.

## Suggested commits

1. `Add booking race-condition test script` (Step 1, **before** the fix)
2. `Add Redis distributed lock helper` (Step 2)
3. `Prevent double bookings with a per-listing distributed lock` (Steps 3–4)
4. `Document booking lock and race test` (Step 6)

---

## Files touched (summary)

| File | Status |
|---|---|
| `scripts/race-test.js` | new |
| `utils/lock.js` | new |
| `controllers/bookings.js` | edited: `createBooking` |
| `models/booking.js` | edited: indexes |
| `CLAUDE.md` | edited |
| `.env` | `TEST_USER`, `TEST_PASS` (local only) |

## Known limitations (be ready to mention them in an interview)

- **Single Redis node.** If Redis crashes and restarts while a lock is held, the lock is lost and another request could enter. Redlock (a majority of several Redis nodes) or a DB-level guarantee would close that gap. At this scale, one Redis is a reasonable trade-off.
- **TTL versus slow work.** If the critical section ever took longer than 5 s (a very slow Atlas), the lock would expire mid-work. The fix for long work is to extend the lock periodically (a "watchdog"). Ours takes about 0.5 s.
- **Waiting requests poll.** They retry every ~100 ms rather than being notified. That's simple and fine for a few concurrent bookers. A queue or Redis pub/sub notification would scale better under heavy contention.
- **Only creation is locked.** Cancelling a booking needs no lock, because deleting can't create an overlap.
