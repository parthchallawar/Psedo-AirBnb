# Phase 1 — Implementation Plan: Redis Caching & Rate Limiting

Spec: [docs/specs/phase-1-redis-caching-rate-limiting.md](../specs/phase-1-redis-caching-rate-limiting.md)
Estimated time: ~1 day. There are 10 steps, and each one ends in a working app.

---

## Decisions made while planning (read first)

These came from checking the actual library versions and this codebase. They refine the spec.

| # | Decision | Why |
|---|---|---|
| D1 | Versions: `ioredis@6`, `express-rate-limit@8`, `rate-limit-redis@6` | Current majors, checked 2026-09-28. `rate-limit-redis@6` needs `express-rate-limit >= 8.6`. `ioredis@6` needs Node ≥ 20 (we're on 22). |
| D2 | Import as `const { Redis } = require('ioredis')` | Named export. Works in v5 and v6. |
| D3 | Redis client option `commandTimeout: 500` | While Redis is down, ioredis **queues** commands and keeps retrying, so requests would hang. With this timeout, any command fails after 0.5 s and the code falls back. This is what makes "fail open" real. |
| D4 | Rate limiters get `skip: () => !isRedisReady()` | When Redis is known to be down, skip the limiter instantly instead of waiting 0.5 s for a timeout on every request. `passOnStoreError: true` stays as a backup. |
| D5 | Re-initialise the rate-limit store on every Redis `ready` event | `rate-limit-redis` loads its Lua scripts once, at startup. If Redis was down then, the scripts never load and rate limiting stays off until the app restarts. Reloading on reconnect fixes that. |
| D6 | Mount `globalLimiter` **after** the "safe defaults" `res.locals` middleware in `app.js` | A 429 renders `error.ejs`, whose navbar and flash partials read `currUser`, `success` and `error`. If the limiter runs before those defaults are set, rendering the 429 page throws a ReferenceError. |
| D7 | Cache stores `.lean()` results, with reviews populated as `rating` only | Plain JSON survives the Redis round-trip identically, and the index view only needs `reviews[].rating` and `.length`. That keeps cache entries small. |
| D8 | The cache key uses the **normalised** filter values (invalid category or sort → empty, `q` trimmed and cut to 100 chars) | Junk query params collapse into the same key, so random URLs can't flood Redis with keys. |
| D9 | `await invalidateListingsCache()` **before** `res.redirect(...)` | Create and update redirect straight to pages that read the cache. Invalidating first guarantees the user sees their own change. |
| D10 | Rate-limit headers use `standardHeaders: 'draft-7'` | Matches the spec (`RateLimit` + `RateLimit-Policy` headers). |

---

## Step 0 — Prerequisites (15 min)

1. Install **Docker Desktop** (WSL 2 backend) and restart the terminal. Check with `docker --version`.
2. Start Redis:
   ```bash
   docker run -d --name wanderlust-redis -p 6379:6379 redis:7-alpine
   docker exec -it wanderlust-redis redis-cli ping      # → PONG
   ```
   Later: `docker start wanderlust-redis` / `docker stop wanderlust-redis`.
3. Create a branch: `git checkout -b phase-1-redis`.

## Step 1 — Install packages (2 min)

```bash
npm install ioredis@6 express-rate-limit@8 rate-limit-redis@6
```
✅ `package.json` lists the three dependencies. `node app.js` still starts.

## Step 2 — Redis connection: `config/redis.js` (new) (15 min)

```js
const { Redis } = require('ioredis');

const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  commandTimeout: 500, // fail fast when Redis is slow or down, so callers can fall back (fail open)
});

// Log once per outage instead of on every reconnect attempt.
let reportedDown = false;
redis.on('ready', () => {
  reportedDown = false;
  console.log('Connected to Redis');
});
redis.on('error', (err) => {
  if (!reportedDown) {
    console.log('Redis unavailable:', err.message);
    reportedDown = true;
  }
});

const isRedisReady = () => redis.status === 'ready';

module.exports = { redis, isRedisReady };
```

Notes
- Without an `'error'` listener, ioredis prints an "Unhandled error event" on every retry. The listener is required.
- `app.js` loads `.env` on its first line, before any `require` that reaches this file, so `REDIS_URL` is available.

✅ `node app.js` prints `Connected to Redis`. With the container stopped, the app still starts and prints `Redis unavailable: …` once.

## Step 3 — Cache helper: `utils/cache.js` (new) (30 min)

```js
const { redis, isRedisReady } = require('../config/redis.js');

const LISTINGS_INDEX_PREFIX = 'listings:index:';

// Cache-aside: return cached JSON if present, otherwise run loader() and cache its result.
// Any Redis problem falls back to loader() — the cache must never break a page.
module.exports.getOrSet = async (key, ttlSeconds, loader) => {
  if (isRedisReady()) {
    try {
      const cached = await redis.get(key);
      if (cached) return { data: JSON.parse(cached), hit: true };
    } catch (err) {
      console.log('Cache read failed:', err.message);
    }
  }

  const data = await loader();

  if (isRedisReady()) {
    // Not awaited: the response doesn't need to wait for the cache write.
    redis.set(key, JSON.stringify(data), 'EX', ttlSeconds)
      .catch((err) => console.log('Cache write failed:', err.message));
  }
  return { data, hit: false };
};

// Delete every key starting with prefix. SCAN walks keys in small batches;
// KEYS would block Redis while it scans the whole keyspace.
const deleteByPrefix = async (prefix) => {
  if (!isRedisReady()) return;
  try {
    const stream = redis.scanStream({ match: `${prefix}*`, count: 100 });
    for await (const keys of stream) {
      if (keys.length) await redis.del(...keys);
    }
  } catch (err) {
    console.log('Cache invalidation failed:', err.message);
  }
};
module.exports.deleteByPrefix = deleteByPrefix;

module.exports.LISTINGS_INDEX_PREFIX = LISTINGS_INDEX_PREFIX;
module.exports.invalidateListingsCache = () => deleteByPrefix(LISTINGS_INDEX_PREFIX);
```

✅ Quick check in a scratch script or the Node REPL: `getOrSet('t', 10, async () => ({a:1}))` returns `hit:false`, and a second call returns `hit:true`.

## Step 4 — Cache the listings page: `controllers/listing.js` `index` (45 min)

**4a.** At the top, add:
```js
const { getOrSet, invalidateListingsCache, LISTINGS_INDEX_PREFIX } = require('../utils/cache.js');
const LISTINGS_CACHE_TTL = 60; // seconds
```

**4b.** In `index`, keep the existing parsing and query building, then change the ending:
- Cut `q` to 100 chars: `const q = (req.query.q || "").trim().slice(0, 100);`
- After `query` is built, build the normalised key (D8):
  ```js
  const cacheKey = LISTINGS_INDEX_PREFIX + [
    `q=${q.toLowerCase()}`,
    `cat=${query.category || ''}`,
    `min=${query.price?.$gte ?? ''}`,
    `max=${query.price?.$lte ?? ''}`,
    `sort=${SORT_OPTIONS[sort] ? sort : ''}`,
  ].join('|');
  ```
  (Lowercasing `q` is safe because the search regex is already case-insensitive.)
- Replace the `cursor` / `await cursor` lines with:
  ```js
  const { data: listings, hit } = await getOrSet(cacheKey, LISTINGS_CACHE_TTL, () => {
    let cursor = Listing.find(query).populate({ path: "reviews", select: "rating" }).lean();
    if (SORT_OPTIONS[sort]) cursor = cursor.sort(SORT_OPTIONS[sort]);
    return cursor;
  });
  res.set("X-Cache", hit ? "HIT" : "MISS");
  ```
- `res.render(...)` stays the same.

**4c. Safety check before relying on `.lean()`.** Lean results skip schema defaults. Confirm that
every listing has an image URL (the view reads `listing.image.url`):
```js
// mongosh or a one-off script
db.listings.countDocuments({ "image.url": { $exists: false } })   // must be 0
```
If it isn't 0, fix the data (set the default Unsplash URL) before continuing.

✅ `/listings` renders the same as before. DevTools shows `X-Cache: MISS`, then `HIT` on reload. Search, category, price and sort filters all still work.

## Step 5 — Invalidate on writes (20 min)

Add `await invalidateListingsCache();` **after the DB write and before the redirect** (D9):

| File | Function | Put it after |
|---|---|---|
| `controllers/listing.js` | `createListing` | `await newListing.save();` |
| `controllers/listing.js` | `updateListing` | the `if (cover \|\| gallery.length) {…}` block |
| `controllers/listing.js` | `destroyListing` | `await Listing.findByIdAndDelete(id);` |
| `controllers/reviews.js` | `postReview` | `await listing.save();` |
| `controllers/reviews.js` | `destroyReview` | `await Review.findByIdAndDelete(reviewId);` |

Import in `controllers/reviews.js`: `const { invalidateListingsCache } = require('../utils/cache.js');`

✅ Reload `/listings` (HIT) → add a review → back to `/listings` → `MISS`, with the new rating shown.

## Step 6 — Rate limiters: `middleware/rateLimit.js` (new) (40 min)

This is a new folder next to the existing `middleware.js` file. Existing imports use
`'../middleware.js'` with the extension, so they keep resolving to the file.

```js
const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redis, isRedisReady } = require('../config/redis.js');
const ExpressError = require('../utils/ExpressError.js');

// Counters live in Redis so every app instance shares them (Phase 2 runs three).
const makeStore = (prefix, windowMs) => {
  const store = new RedisStore({
    prefix,
    sendCommand: (...args) => redis.call(...args),
  });
  // The store loads its Lua scripts once at startup. If Redis was down then,
  // reload them whenever Redis (re)connects so rate limiting recovers by itself.
  redis.on('ready', () => store.init({ windowMs }).catch(() => {}));
  return store;
};

const createLimiter = ({ prefix, windowMs, limit }) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore(prefix, windowMs),
  skip: () => !isRedisReady(),   // fail open instantly when Redis is down
  passOnStoreError: true,        // ...and if a Redis call fails mid-request
  message: 'Too many requests, please try again later.',
  handler: (req, res, next, options) =>
    next(new ExpressError(options.statusCode, options.message)),
});

// Brute-force protection for login and signup.
module.exports.authLimiter = createLimiter({ prefix: 'rl:auth:', windowMs: 15 * 60 * 1000, limit: 10 });

// Flood protection for the whole site.
module.exports.globalLimiter = createLimiter({ prefix: 'rl:global:', windowMs: 60 * 1000, limit: 100 });
```

Notes
- The default key is the client IP (express-rate-limit v8 groups IPv6 addresses by /56 subnet). No `keyGenerator` is needed.
- The `handler` routes the 429 through the existing error middleware, so the user sees `error.ejs` with status 429.
- At startup there can be one logged "error during store initialization" if Redis is down. That's expected: D5 recovers it.

## Step 7 — Wire the auth limiter: `routes/user.js` (5 min)

```js
const { authLimiter } = require("../middleware/rateLimit.js");

router.route("/signup")
    .get(listingsController.renderSignup)
    .post(authLimiter, listingsController.signup);

router.route("/login")
    .get(listingsController.renderLogin)
    .post(authLimiter, saveRedirectUrl, passport.authenticate("local", { … }), listingsController.login);
```
Only the POSTs are limited. Viewing the forms isn't.

## Step 8 — Wire `trust proxy` and the global limiter: `app.js` (10 min)

1. Right after `const app = express();`:
   ```js
   // Behind Nginx (Phase 2), read the real client IP from X-Forwarded-For (one proxy hop).
   app.set('trust proxy', 1);
   ```
2. With the other requires: `const { globalLimiter } = require('./middleware/rateLimit.js');`
3. Mount it **directly after** the "safe defaults" middleware (the one setting `res.locals.currUser = null`, and so on). See D6:
   ```js
   app.use(globalLimiter);
   ```
   Static files are served earlier (`express.static`), so they aren't counted.

## Step 9 — Environment & docs (10 min)

- `.env`: add `REDIS_URL=redis://127.0.0.1:6379` (optional, since it's the default, but explicit is clearer).
- `CLAUDE.md`: add `REDIS_URL` under "Required environment", a line on Redis under "Cross-cutting patterns" (cache on `/listings`, rate limiters, fail-open), and the `docker run` command under "Commands".

## Step 10 — Verify against the acceptance criteria (45 min)

Run these in **Git Bash** (in PowerShell, `curl` is a different command, so use `curl.exe`).

| # | Criterion | How |
|---|---|---|
| 1 | MISS then HIT | `curl -sI localhost:8080/listings \| grep -i x-cache`, run twice |
| 2 | Filters cached separately | `curl -sI "localhost:8080/listings?category=Castles" \| grep -i x-cache` → MISS, then HIT |
| 3 | Invalidation | Browser: create, edit or delete a listing, and add or delete a review; after each, the next `/listings` is a MISS and shows the change |
| 4 | Keys + TTL visible | `docker exec -it wanderlust-redis redis-cli --scan --pattern "listings:index:*"` then `… redis-cli TTL "<key>"` |
| 5 | 429 on the 11th login | `for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code}\n" -X POST -d "username=x&password=y" localhost:8080/login; done` → ten `302`, then `429` |
| 6 | Rate-limit headers | `curl -sI localhost:8080/listings \| grep -i ratelimit` |
| 7 | Fail open | `docker stop wanderlust-redis` → `/listings` loads (always MISS), login works, no hanging. `docker start wanderlust-redis` → within seconds, X-Cache HIT works again **and** the login loop hits 429 again (proves D5) |
| 8 | Error page on 429 | Open `/login` in the browser after test 5 and submit. You see the error page with the navbar (proves D6) |

To reset the rate limit between test runs: `docker exec -it wanderlust-redis redis-cli --scan --pattern "rl:*" | xargs docker exec -i wanderlust-redis redis-cli del`
(or simply `docker restart wanderlust-redis`, since nothing important is stored yet).

## Suggested commits

1. `Add Redis client and cache helper` (steps 1–3)
2. `Cache listings index in Redis with invalidation on writes` (steps 4–5)
3. `Add Redis-backed rate limiting for auth and global traffic` (steps 6–8)
4. `Document Redis setup` (step 9)

---

## Files touched (summary)

| File | Status |
|---|---|
| `config/redis.js` | new |
| `utils/cache.js` | new |
| `middleware/rateLimit.js` | new |
| `controllers/listing.js` | edited: `index`, `createListing`, `updateListing`, `destroyListing` |
| `controllers/reviews.js` | edited: `postReview`, `destroyReview` |
| `routes/user.js` | edited: two POST routes |
| `app.js` | edited: `trust proxy`, global limiter |
| `package.json`, `package-lock.json` | edited |
| `.env`, `CLAUDE.md` | edited |

## Known limitations (be ready to mention them in an interview)

- **Stale write race:** request A misses the cache and reads Mongo, request B updates the listing and invalidates, then A writes its (old) result to the cache. That stale entry lives at most 60 s (the TTL). Acceptable for a listings page.
- **`trust proxy = 1` when running `node app.js` directly** (no Nginx) lets a client fake `X-Forwarded-For` to dodge the rate limit. In Phase 2 the app is only reachable through Nginx, which appends the real client IP as the last entry, and `trust proxy = 1` reads only that last entry, so a faked value is ignored.
- **Fixed-window limiting** allows up to 2× the limit around a window boundary.
