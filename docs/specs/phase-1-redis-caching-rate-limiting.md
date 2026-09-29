# Phase 1 — Redis: Caching & Rate Limiting

## 1. Goal

1. Serve the listings page (`GET /listings`) from a Redis cache so repeated visits don't hit MongoDB.
2. Protect login and signup from brute-force attempts, and the whole site from request floods,
   with rate limiting whose counters live in Redis.

## 2. Problem today

- Every `GET /listings` runs `Listing.find(query).populate("reviews")` against Atlas
  ([controllers/listing.js](../../controllers/listing.js) `index`). It's the most visited page and
  its data changes rarely.
- `POST /login` and `POST /signup` accept unlimited attempts, so passwords can be brute-forced.

## 3. Concepts (keep to these)

| Concept | One-line explanation |
|---|---|
| **Redis** | In-memory key-value store. Reads and writes take well under a millisecond. |
| **Cache-aside** | App checks the cache first. On a miss it reads the DB, stores the result in the cache, and returns it. |
| **TTL** | Expiry time on a cache key. It's a safety net so stale data can't live forever. |
| **Cache invalidation** | Deleting cached entries when the underlying data changes. |
| **Rate limiting (fixed window)** | Count requests per client (IP) in a time window. Reject with `429 Too Many Requests` once the limit is passed. |
| **Fail open** | If Redis is down, skip the cache and limiter rather than breaking the site. |

## 4. Scope

**In scope**
- Redis connection module.
- Cache for `GET /listings`, including all its filter combinations.
- Invalidation on listing create, update and delete, and on review create and delete (reviews change the star rating shown on the listings page).
- Two rate limiters: `authLimiter` (login and signup POSTs) and `globalLimiter` (all routes).
- `/listings` responses carry an `X-Cache: HIT|MISS` header, for demos.

**Out of scope**
- Caching the single listing page `/listings/:id`. Its output depends on the logged-in user
  (for example, the owner sees bookings), so caching it adds complexity for little gain.
- Moving sessions to Redis. They already live in MongoDB and are already shared across instances.

## 5. Design

### 5.1 Redis connection — new file `config/redis.js`
- Uses `ioredis`, URL from `process.env.REDIS_URL` (default `redis://127.0.0.1:6379`).
- Exports one shared client: `module.exports = redis`.
- Logs `connect` and `error` events. **It must not crash the process** when Redis is unreachable
  (ioredis retries automatically).
- Exports a helper `isRedisReady()` that returns `redis.status === "ready"`.

### 5.2 Cache helper — new file `utils/cache.js`

```
getOrSet(key, ttlSeconds, loaderFn) -> { data, hit }
  1. if Redis not ready       → return { data: await loaderFn(), hit: false }
  2. cached = GET key         → if found return { data: JSON.parse(cached), hit: true }
  3. data = await loaderFn()
  4. SET key JSON.stringify(data) EX ttlSeconds
  5. return { data, hit: false }
  Any Redis error inside → log it and fall back to loaderFn() (fail open)

deleteByPrefix(prefix)
  - Iterate with SCAN (MATCH prefix*, COUNT 100) and DEL the matched keys.
  - Never use the KEYS command: it blocks Redis while it scans every key.
  - Errors are logged, not thrown.
```

### 5.3 Caching the listings page — edit `controllers/listing.js` `index`
- **Cache key:** `listings:index:` plus the normalised filters, built in a fixed order:
  `q=<lowercased q>|cat=<category>|min=<minPrice>|max=<maxPrice>|sort=<sort>`.
  The same filters must always produce the same key.
- **Loader:** the existing query, plus `.lean()`, so the result is plain JSON. The view only
  reads `_id`, `title`, `price`, `image.url` and `reviews[].rating`, so plain objects render the same.
- **TTL:** 60 seconds.
- Set the response header `X-Cache` to `HIT` or `MISS`.

### 5.4 Invalidation
Call `deleteByPrefix("listings:index:")` **after** the DB write succeeds in:

| Controller function | File |
|---|---|
| `createListing`, `updateListing`, `destroyListing` | `controllers/listing.js` |
| `postReview`, `destroyReview` | `controllers/reviews.js` |

Put the call inside a small helper `invalidateListingsCache()` in `utils/cache.js` so the prefix
is defined in one place.

### 5.5 Rate limiting — new file `middleware/rateLimit.js`
(or add to `middleware.js`, but a separate file keeps it readable)

| Limiter | Applies to | Window | Max requests | Key |
|---|---|---|---|---|
| `authLimiter` | `POST /login`, `POST /signup` | 15 min | 10 | client IP |
| `globalLimiter` | every request (mounted in `app.js` before the routers) | 1 min | 100 | client IP |

- Library: `express-rate-limit` with store `rate-limit-redis`, where
  `sendCommand: (...args) => redis.call(...args)`.
- Different Redis key prefixes per limiter: `rl:auth:` and `rl:global:`.
- `standardHeaders: 'draft-7'` and `legacyHeaders: false`, so responses include the standard `RateLimit` headers.
- `passOnStoreError: true`, so the site fails open if Redis is down.
- **Handler on limit:** `next(new ExpressError(429, "Too many requests, please try again later."))`
  so the existing error page renders with status 429.
- Skip static files in the global limiter by mounting it **after** `express.static`.
- Wire `authLimiter` in [routes/user.js](../../routes/user.js) as the first middleware on the two POST routes.

### 5.6 `trust proxy`
Add `app.set('trust proxy', 1)` in `app.js`. Without it, once Nginx sits in front (Phase 2),
every request would appear to come from Nginx's IP and all users would share one rate-limit bucket.

## 6. Files changed / added

| File | Change |
|---|---|
| `config/redis.js` | **new**: Redis client |
| `utils/cache.js` | **new**: `getOrSet`, `deleteByPrefix`, `invalidateListingsCache` |
| `middleware/rateLimit.js` | **new**: `authLimiter`, `globalLimiter` |
| `controllers/listing.js` | `index` uses the cache; create, update and delete invalidate it |
| `controllers/reviews.js` | post and delete invalidate the cache |
| `routes/user.js` | `authLimiter` on `POST /login` and `POST /signup` |
| `app.js` | `trust proxy`; mount `globalLimiter` |
| `package.json` | add `ioredis`, `express-rate-limit`, `rate-limit-redis` |
| `.env` | add `REDIS_URL` (optional, has a default) |

## 7. Local setup

```bash
docker run -d --name wanderlust-redis -p 6379:6379 redis:7-alpine
docker exec -it wanderlust-redis redis-cli ping   # → PONG
```

## 8. Acceptance criteria

- [ ] First `GET /listings` returns `X-Cache: MISS`. A second one within 60 s returns `X-Cache: HIT`.
- [ ] Different filters (for example `?category=Castles`) get their own cache entries.
- [ ] Creating, editing or deleting a listing, or adding or deleting a review, makes the next `GET /listings` a `MISS` and shows the new data.
- [ ] `redis-cli KEYS "listings:index:*"` (demo only) shows the cached keys, and `TTL <key>` shows a countdown.
- [ ] The 11th `POST /login` from the same IP within 15 minutes gets status **429** and the error page.
- [ ] Responses include the `RateLimit` / `RateLimit-Policy` headers.
- [ ] With Redis stopped (`docker stop wanderlust-redis`), the site still works: listings load (always `MISS`) and login works.

## 9. Demo script

1. Open DevTools → Network → reload `/listings` twice and point at `X-Cache: MISS`, then `HIT`.
2. Add a review to any listing, go back to `/listings`, and show that it's a `MISS` with the updated rating.
3. Run a loop to show rate limiting:
   ```bash
   for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code}\n" -X POST -d "username=x&password=y" http://localhost:8080/login; done
   ```
   The first 10 are `302` and the rest are `429`.

## 10. Interview explanation

**Two-minute version**
> "The listings page is the most visited page and changes rarely, so I used the cache-aside pattern
> with Redis. The controller builds a cache key from the search filters. If Redis has it, we skip
> MongoDB entirely. If not, we query Mongo and store the result with a 60-second TTL. Whenever a
> listing or review changes, I delete all listings-page keys with SCAN, so users never see stale
> data for long. The TTL is the safety net if an invalidation is ever missed.
> For security I added rate limiting: 10 login or signup attempts per IP per 15 minutes, and 100
> requests per minute overall. The counters live in Redis, not in the app's memory, because with
> multiple app instances behind a load balancer, each instance would otherwise have its own counter
> and an attacker would get 10 × N attempts. Everything fails open: if Redis dies, the site still
> works, just slower and unprotected."

**Likely questions**

| Question | Answer |
|---|---|
| Why not cache every page? | Pages that depend on the logged-in user would need a key per user and are hard to invalidate. Cache what's hot and shared. |
| Why SCAN instead of KEYS? | Redis is single-threaded. KEYS walks every key in one blocking call, while SCAN iterates in small batches. |
| Why also a TTL if you invalidate? | Defence in depth. If an invalidation is missed (a crash between the DB write and the DEL), the data is at most 60 s stale. |
| Cache stampede? | When a hot key expires, many requests hit the DB at once. At this scale it's acceptable. The fix is a short lock or early refresh. |
| Fixed window vs sliding window? | A fixed window can allow up to 2× the limit around the window edge. A sliding window is smoother but costs more. Fixed is fine for login protection. |
| Why rate-limit by IP? | Before login there's no user ID. The downside is that users behind one NAT share a bucket, which is why the global limit is generous. |
| What happens if Redis goes down? | Fail open: no caching and no limits, but the site stays up. It's a deliberate availability-over-protection choice. |
