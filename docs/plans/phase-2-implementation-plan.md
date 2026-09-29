# Phase 2 — Implementation Plan: Load Balancing (Nginx + 3 App Instances)

Spec: [docs/specs/phase-2-load-balancing.md](../specs/phase-2-load-balancing.md)
Estimated time: ~half a day. There are 9 steps, and each one ends in something you can run.

---

## Decisions made while planning (read first)

These come from checking this machine, the current code (after Phase 1), and Docker Compose itself.

| # | Decision | Why |
|---|---|---|
| D1 | **Fix `.env` before anything else** (Step 0) | Tested: Docker Compose **refuses to start** with the current `.env`, failing with `unexpected character "!" in variable name "!!CLOUD_NAME"`. That same typo means `process.env.CLOUD_NAME` is undefined today, so Cloudinary uploads are likely already broken. `MAP_TOKEN` also ends with a stray backtick, which gets passed into the value. |
| D2 | `/health` and the `X-Instance-Id` header are registered **before** `express.static`, `globalLimiter` and session | Health checks run every few seconds. They must never be rate-limited, never create a session document in MongoDB, and stay cheap. |
| D3 | `/health` returns **503 only when MongoDB is down**. Redis state is reported but never fails it | The app can't serve pages without Mongo, but works fine without Redis (Phase 1 fails open). Failing health on a Redis outage would take all 3 instances out at once, for no reason. |
| D4 | Graceful shutdown force-exits after **8 s** | `docker stop` sends SIGTERM, then SIGKILL after 10 s. Finishing our cleanup before 10 s means a clean exit rather than a kill. |
| D5 | Shutdown also closes the **session store's own MongoDB client** (`store.close()`) | `connect-mongo` opens a second MongoDB connection, separate from Mongoose's. Leaving it open keeps the process alive. `store.close()` exists in connect-mongo 5.1.0 (checked). |
| D6 | Three **named** app services (`app1`, `app2`, `app3`), not `deploy.replicas: 3` | The Nginx config and the demo read naturally ("app2 is down"), and each gets a fixed `INSTANCE_ID`. |
| D7 | App containers publish **no host ports**. Compose Redis publishes **no host port** either | Traffic must go through Nginx. Your Phase 1 container `wanderlust-redis` already uses host port 6379, and both can coexist this way. Keep using that one for `node app.js` dev runs. |
| D8 | Nginx `depends_on` apps with `condition: service_started`, not `service_healthy` | With `service_healthy`, one slow or broken instance (for example, Atlas being slow) would stop Nginx from starting at all. Nginx already skips instances that refuse connections. |
| D9 | Don't retry POST requests that already reached an instance | By default, Nginx retries a POST on another instance only if it **never reached** the first one (the connection failed). Once a POST has been sent, it isn't retried, and we keep that default (no `non_idempotent` flag): retrying a "create booking" on app2 after app1 timed out mid-request could create two bookings. GETs are always safe to retry. |
| D10 | Image is `node:22-alpine`, `npm ci --omit=dev`, runs as the non-root `node` user | Small image, reproducible installs from the lockfile, and least privilege. There are no packages that need compiling (checked), so Alpine works as-is. |
| D11 | Healthcheck uses `wget` against `127.0.0.1`, with `start_period: 40s` | `wget` ships with Alpine (busybox), so nothing extra is installed. `127.0.0.1` avoids IPv6 `localhost` surprises. Startup against Atlas took about 25 s in Phase 1 testing. |
| D12 | Containers get `restart: unless-stopped` | If an instance crashes, Docker restarts it automatically. This is self-healing with one line, and useful in the demo. |

---

## Step 0 — Prerequisites and `.env` fix (10 min)

1. Docker Desktop is running (the whale icon has settled). Check with `docker --version` and `docker compose version`.
2. **Fix `.env`** (D1). Edit two lines only, and don't change any values:
   - Line 1: `!!CLOUD_NAME=...` → `CLOUD_NAME=...` (remove the `!!`).
   - `MAP_TOKEN=...`: remove the trailing `` ` `` character at the end of the value.
3. Check that Compose can read it (from the project root, after Step 5 creates `docker-compose.yml`):
   `docker compose config --quiet`. No output means it parsed correctly.
4. Branch from the Phase 1 work: `git checkout phase-1-redis && git checkout -b phase-2-load-balancing`.

✅ `node app.js` still starts, and creating a listing with an image now uploads to Cloudinary.

## Step 1 — Configurable port and instance ID: `app.js` (15 min)

1. Change the Redis import so shutdown can close the client, and add the new constants near the other requires:
   ```js
   const os = require('os');
   const { redis, isRedisReady } = require('./config/redis.js');

   const PORT = process.env.PORT || 8080;
   // Which copy of the app answered — shown in the X-Instance-Id header and logs.
   const INSTANCE_ID = process.env.INSTANCE_ID || os.hostname();
   ```
2. Change the listen call at the end of `main().then(...)`:
   ```js
   server = app.listen(PORT, () => {
     console.log(`Server ${INSTANCE_ID} is running on port ${PORT}`);
   });
   ```
   and declare `let server;` at the top level, next to `let store;`.

✅ `PORT=9090 node app.js` (Git Bash) listens on 9090. Plain `node app.js` still uses 8080.

## Step 2 — Instance header and `/health`: `app.js` (20 min)

Insert **directly before** `app.use(express.urlencoded(...))`, which comes before static, the rate limiter and session (D2):

```js
// Tag every response with the instance that served it, so load balancing is visible.
app.use((req, res, next) => {
  res.set('X-Instance-Id', INSTANCE_ID);
  next();
});

// Health check for Docker and the load balancer. Registered before static files,
// rate limiting and sessions so it's cheap, never limited and never creates a session.
// Only MongoDB decides healthy vs unhealthy: Redis is optional (it fails open).
app.get('/health', (req, res) => {
  const mongoUp = mongoose.connection.readyState === 1;
  res.status(mongoUp ? 200 : 503).json({
    status: mongoUp ? 'ok' : 'unavailable',
    instance: INSTANCE_ID,
    mongo: mongoUp ? 'connected' : 'disconnected',
    redis: isRedisReady() ? 'ready' : 'down',
  });
});
```

✅ `curl -i localhost:8080/health` → `200` with JSON and an `X-Instance-Id` header. With the Redis container stopped it's still `200`, with `"redis":"down"`. Calling it 150 times in a minute never returns 429.

## Step 3 — Graceful shutdown: `app.js` (25 min)

Add at the bottom of `app.js`, outside `main().then(...)`:

```js
// Graceful shutdown: on `docker stop` (SIGTERM) or Ctrl+C (SIGINT), stop accepting
// new connections, let in-flight requests finish, then close every connection.
let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received: ${INSTANCE_ID} shutting down gracefully`);

  // Docker sends SIGKILL 10s after SIGTERM, so give up cleanly before that.
  setTimeout(() => {
    console.log('Graceful shutdown timed out, forcing exit');
    process.exit(1);
  }, 8000).unref();

  try {
    if (server) await new Promise((resolve) => server.close(resolve)); // waits for in-flight requests
    if (store) await store.close();                                     // session store's own Mongo client
    await mongoose.connection.close();
    await redis.quit().catch(() => redis.disconnect());
    console.log('Shutdown complete');
    process.exit(0);
  } catch (err) {
    console.error('Error during shutdown:', err);
    process.exit(1);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
```

Notes
- `server.close()` stops new connections, and its callback runs once in-flight requests finish. Node 22 also closes idle keep-alive sockets during `close()`, so it doesn't hang on them.
- `redis.quit()` sends QUIT and waits. If Redis is already down, it rejects (because of the 500 ms `commandTimeout`), so we fall back to `disconnect()`.
- On Windows, only Ctrl+C (SIGINT) can be tested locally. SIGTERM is exercised inside Docker in Step 8.

✅ `node app.js`, then Ctrl+C prints `SIGINT received…` and `Shutdown complete`, and the process exits right away.

## Step 4 — Dockerfile and `.dockerignore` (15 min)

**`Dockerfile`** (project root):
```dockerfile
FROM node:22-alpine

WORKDIR /app

# Install dependencies first: this layer is cached until package*.json changes,
# so code-only changes rebuild in seconds.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

# Don't run as root inside the container.
USER node

EXPOSE 8080
CMD ["node", "app.js"]
```

**`.dockerignore`**:
```
node_modules
.git
.env
docs
*.md
```

- `node_modules` is excluded because the image installs its own Linux copy. Your Windows one must not be copied in.
- `.env` is excluded so secrets are never baked into the image. Compose injects them at runtime (Step 5).
- `NODE_ENV` stays unset, so `app.js` still calls `dotenv.config()`. With no `.env` file inside the container, dotenv just logs `injecting env (0)` and the Compose-provided variables are used.

✅ `docker build -t wanderlust-app .` succeeds. `docker run --rm --env-file .env -e REDIS_URL=redis://host.docker.internal:6379 -p 8081:8080 wanderlust-app` then serves `http://localhost:8081/listings`.

## Step 5 — `docker-compose.yml` (30 min)

```yaml
# Local production-like stack: Nginx load-balancing three app instances.
# Start: docker compose up --build -d      Stop: docker compose down

x-app: &app                      # shared settings for app1..app3
  build: .
  env_file: .env
  restart: unless-stopped
  depends_on:
    - redis
  healthcheck:
    test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8080/health"]
    interval: 10s
    timeout: 3s
    retries: 3
    start_period: 40s

services:
  redis:
    image: redis:7-alpine
    restart: unless-stopped
    # No host port: only the app containers talk to this Redis (D7).

  app1:
    <<: *app
    environment:
      INSTANCE_ID: app1
      PORT: "8080"
      REDIS_URL: redis://redis:6379

  app2:
    <<: *app
    environment:
      INSTANCE_ID: app2
      PORT: "8080"
      REDIS_URL: redis://redis:6379

  app3:
    <<: *app
    environment:
      INSTANCE_ID: app3
      PORT: "8080"
      REDIS_URL: redis://redis:6379

  nginx:
    image: nginx:alpine
    restart: unless-stopped
    ports:
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    depends_on:              # started, not healthy (D8)
      - app1
      - app2
      - app3
```

- `environment:` overrides the same key from `env_file:`, so `REDIS_URL` from `.env` (`127.0.0.1`) is replaced by the in-network hostname `redis`.
- Inside the Compose network, service names are DNS names: `redis`, `app1`, and so on.
- The `x-app` anchor keeps the three app services identical except for their ID.

✅ `docker compose config --quiet` prints nothing (valid).

## Step 6 — `nginx/nginx.conf` (20 min)

```nginx
events {}

http {
  # The three app instances. No algorithm named = round robin.
  upstream wanderlust_app {
    server app1:8080 max_fails=3 fail_timeout=10s;
    server app2:8080 max_fails=3 fail_timeout=10s;
    server app3:8080 max_fails=3 fail_timeout=10s;
  }

  server {
    listen 80;
    client_max_body_size 10m;          # cover photo + up to 5 gallery images

    location / {
      proxy_pass http://wanderlust_app;

      proxy_set_header Host              $host;
      proxy_set_header X-Real-IP         $remote_addr;
      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;

      # If an instance is down or broken, retry the request on the next one.
      # POST/PUT/DELETE are only retried if they never reached an instance,
      # so a half-processed booking is never sent twice (D9).
      proxy_next_upstream error timeout http_502 http_503;
      proxy_connect_timeout 2s;
    }
  }
}
```

- **Passive health check:** after 3 failed attempts, Nginx skips that instance for 10 s, then tries it again. (Active health checks need Nginx Plus.)
- `proxy_connect_timeout 2s` means a dead instance is detected in 2 s instead of the 60 s default.
- `X-Forwarded-For` plus `trust proxy = 1` (Phase 1) makes `req.ip` the real browser IP, so rate limits stay per user.

## Step 7 — `package.json` script (2 min)

Add `"start": "node app.js"` to `scripts`, so `npm start` works too. That's the standard entry point people and platforms expect.

## Step 8 — Verify against the acceptance criteria (45 min)

Start the stack: `docker compose up --build -d`, then wait until `docker compose ps` shows the three apps as `healthy` (about 30–60 s).
Run the commands in **Git Bash**.

| # | Criterion | How | Expected |
|---|---|---|---|
| 1 | Site works through Nginx | open `http://localhost` | the listings page |
| 2 | Round robin | `for i in $(seq 1 9); do curl -sI localhost/listings \| grep -i x-instance-id; done \| sort \| uniq -c` | 3 × app1, 3 × app2, 3 × app3 |
| 3 | **Shared cache** across instances | `docker compose exec redis redis-cli flushall`, then `for i in 1 2 3; do curl -sI localhost/listings \| grep -iE "x-instance\|x-cache"; done` | first `MISS` on one instance, then `HIT` on the **other** instances |
| 4 | **Shared session** | log in in the browser, reload 6+ times with DevTools → Network open | `X-Instance-Id` changes and you stay logged in |
| 5 | **Shared rate limit** | `for i in $(seq 1 12); do curl -s -o /dev/null -w "%{http_code}\n" -X POST -d "username=x&password=y" localhost/login; done` | ten `302`, then `429`, even though the attempts hit 3 different instances |
| 6 | Failover | `docker compose stop app2`, then repeat test 2 | only app1 and app3, and no errors |
| 7 | Recovery | `docker compose start app2`, wait until healthy, repeat test 2 | app2 is back in rotation |
| 8 | Health endpoint | `docker compose exec app1 wget -qO- http://127.0.0.1:8080/health` | `{"status":"ok","instance":"app1",...}` |
| 9 | Graceful shutdown | `docker compose stop app1`, then `docker compose logs app1 \| tail -5` | `SIGTERM received…`, then `Shutdown complete`, and the stop takes well under 10 s |
| 10 | Self-healing | `docker compose kill -s SIGKILL app3`, wait a few seconds, `docker compose ps` | app3 restarted automatically (`restart: unless-stopped`) |
| 11 | Local dev unchanged | `docker compose down`, then `node app.js` | still works on `localhost:8080` against `wanderlust-redis` |

Useful while testing: `docker compose logs -f app1 app2 app3` shows which instance handles each request.
To reset the rate limit: `docker compose exec redis redis-cli flushall`.

## Step 9 — Docs (10 min)

- `CLAUDE.md` → Commands: add `docker compose up --build -d` / `docker compose down`, and note that the site is on `http://localhost` (port 80) through Nginx. Replace "port is hardcoded" with `PORT` (default 8080).
- `CLAUDE.md` → Required environment: add `PORT` and `INSTANCE_ID` as optional.
- `CLAUDE.md` → Architecture: add `Dockerfile`, `docker-compose.yml`, `nginx/nginx.conf`, and the `/health` endpoint.

## Suggested commits

1. `Make port and instance ID configurable; add health check` (Steps 1–2)
2. `Add graceful shutdown on SIGTERM/SIGINT` (Step 3)
3. `Containerize the app with Dockerfile` (Steps 4, 7)
4. `Add Docker Compose stack with Nginx load balancing 3 instances` (Steps 5–6)
5. `Document Docker Compose setup` (Step 9)

`.env` isn't committed (it's gitignored), so the Step 0 fix stays local.

---

## Files touched (summary)

| File | Status |
|---|---|
| `.env` | edited locally (typo fixes, not committed) |
| `app.js` | edited: `PORT`, `INSTANCE_ID`, header, `/health`, graceful shutdown |
| `Dockerfile`, `.dockerignore` | new |
| `docker-compose.yml` | new |
| `nginx/nginx.conf` | new |
| `package.json` | `start` script |
| `CLAUDE.md` | edited |

## Known limitations (be ready to mention them in an interview)

- **Nginx is a single point of failure.** In production you'd run two behind a floating IP, or use a managed load balancer (AWS ALB).
- **Nginx resolves `app1..3` to IP addresses once, at startup.** If a container is *recreated* (not just restarted) and gets a new IP, run `docker compose restart nginx`. The production fix is a DNS `resolver` directive, or a service-discovery-aware load balancer.
- **Passive health checks only.** Nginx notices a dead instance by failing real requests to it (a 2 s connect timeout here), rather than probing `/health` itself.
- **Every session-less request creates a session document** (`saveUninitialized: true` in `app.js`), so load tests with `curl` add many rows to the `sessions` collection. Setting `saveUninitialized: false` is a later cleanup.
- **All three instances share one MongoDB Atlas cluster and one Redis.** We scaled the stateless app tier. The data tier (replication, sharding) is a separate topic.
