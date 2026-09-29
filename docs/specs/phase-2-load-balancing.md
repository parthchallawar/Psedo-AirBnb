# Phase 2 — Load Balancing with Nginx (3 App Instances)

## 1. Goal

Run **three identical instances** of the app behind **Nginx**, which spreads requests across
them. If one instance dies, the site keeps working. Everything starts with one command:
`docker compose up`.

## 2. Problem today

One Node process on port 8080. If it crashes or is restarted, the site is down, and it can only
use one CPU core.

## 3. Concepts (keep to these)

| Concept | One-line explanation |
|---|---|
| **Horizontal scaling** | Handle more load by adding more machines or instances, not a bigger machine. |
| **Load balancer** | Sits in front of the instances and forwards each request to one of them. |
| **Round robin** | Default strategy: requests go to app1, app2, app3, app1, and so on. |
| **Stateless server** | An instance keeps no user data in its own memory, so any instance can serve any request. |
| **Health check** | An endpoint (`/health`) that says whether an instance is OK, so broken ones get no traffic. |
| **Graceful shutdown** | On stop, finish in-flight requests before exiting. |

## 4. Why this app can already scale out (important interview point)

| State | Where it lives | Shared across instances? |
|---|---|---|
| Login session | MongoDB (connect-mongo) | Yes |
| Uploaded images | Cloudinary | Yes |
| Cache, rate-limit counters | Redis (Phase 1) | Yes |
| Anything in a JS variable | Instance memory | **No**, so we must not rely on it |

If sessions were stored in memory (the express-session default), a user who logged in on app1
would look logged out when their next request hit app2.

## 5. Scope

**In scope:** configurable port, instance ID header, `/health`, graceful shutdown, Dockerfile,
docker-compose (Nginx + 3 app instances + Redis), Nginx config.
**Out of scope:** Kubernetes, auto-scaling, HTTPS certificates, a local MongoDB (we keep using Atlas).

## 6. Design

### 6.1 App changes — `app.js`
1. **Port:** `const PORT = process.env.PORT || 8080;` replaces the hard-coded 8080.
2. **Instance ID:** `const INSTANCE_ID = process.env.INSTANCE_ID || require('os').hostname();`
   Add a middleware near the top that sets the header `X-Instance-Id: <INSTANCE_ID>` on every response.
3. **Health endpoint:** `GET /health`, registered **before** the session, passport and rate-limit
   middleware so it's cheap and never rate-limited:
   ```json
   { "status": "ok", "instance": "app1", "mongo": "connected", "redis": "ready" }
   ```
   - Status 200 if Mongo is connected (`mongoose.connection.readyState === 1`), otherwise 503.
   - Redis state is reported but doesn't cause a 503, since Redis fails open.
4. **Graceful shutdown:** keep the server returned by `app.listen`. On `SIGTERM` and `SIGINT`:
   `server.close()` → `mongoose.connection.close()` → `redis.quit()` → `process.exit(0)`.
   Force `process.exit(1)` after 10 s if that hangs.

### 6.2 Dockerfile (project root)
- Base `node:22-alpine`. `WORKDIR /app`. Copy `package*.json`, then `npm ci --omit=dev`, then copy the source.
- `ENV NODE_ENV=production` is **not** set, because `app.js` only loads `.env` when not in production.
  Instead, docker-compose passes the env vars through `env_file: .env`.
- `EXPOSE 8080`, `CMD ["node", "app.js"]`.

### 6.3 `.dockerignore`
`node_modules`, `.git`, `.env`, `docs`.

### 6.4 `docker-compose.yml` (project root)

| Service | Image | Notes |
|---|---|---|
| `redis` | `redis:7-alpine` | No host port needed (optionally `6379:6379` for redis-cli). |
| `app1`, `app2`, `app3` | built from `Dockerfile` | `env_file: .env`; `environment: REDIS_URL=redis://redis:6379`, `INSTANCE_ID=app1/2/3`, `PORT=8080`; **no host ports**, so they're only reachable through Nginx; `depends_on: redis`; healthcheck hits `/health` with `wget -qO- http://localhost:8080/health`. |
| `nginx` | `nginx:alpine` | Mounts `./nginx/nginx.conf`; ports `80:80`; `depends_on: app1, app2, app3`. |

Three explicitly named app services (rather than `replicas: 3`) keep the Nginx config and the demo easy to read.

### 6.5 `nginx/nginx.conf`

```nginx
events {}

http {
  upstream wanderlust_app {
    # default = round robin
    server app1:8080 max_fails=3 fail_timeout=10s;
    server app2:8080 max_fails=3 fail_timeout=10s;
    server app3:8080 max_fails=3 fail_timeout=10s;
  }

  server {
    listen 80;
    client_max_body_size 10m;          # image uploads

    location / {
      proxy_pass http://wanderlust_app;
      proxy_set_header Host              $host;
      proxy_set_header X-Real-IP         $remote_addr;
      proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_next_upstream error timeout http_502 http_503;  # retry on another instance
    }
  }
}
```

- `max_fails` / `fail_timeout` is Nginx's **passive health check**: after 3 failures it stops
  sending traffic to that instance for 10 s. (Active health checks are an Nginx Plus feature.
  Docker's healthcheck covers container status.)
- `X-Forwarded-For` together with `trust proxy` (Phase 1) keeps `req.ip` equal to the real client
  IP, so rate limiting stays per user.
- Phase 4 adds a `/socket.io/` location to this file.

## 7. Files changed / added

| File | Change |
|---|---|
| `app.js` | `PORT`, `INSTANCE_ID` header, `/health`, graceful shutdown |
| `Dockerfile` | **new** |
| `.dockerignore` | **new** |
| `docker-compose.yml` | **new** |
| `nginx/nginx.conf` | **new** |
| `package.json` | add `"start": "node app.js"` script |

## 8. Acceptance criteria

- [ ] `docker compose up --build` starts redis, app1–3 and nginx, and `http://localhost` shows the site.
- [ ] Repeated `curl -sI http://localhost/listings | grep -i x-instance-id` cycles through app1, app2 and app3.
- [ ] Logging in, then browsing several pages served by different instances, keeps the user logged in.
- [ ] `docker compose stop app2` → the site keeps working, and the headers only show app1 and app3.
- [ ] `docker compose start app2` → app2 receives traffic again.
- [ ] `GET /health` returns 200 with the instance name.
- [ ] The rate limit is shared: 11 login attempts spread over all instances still produce a 429.
- [ ] `docker compose stop` shows each app logging a graceful shutdown.
- [ ] `node app.js` still works on its own (no Docker) for local development.

## 9. Demo script

```bash
docker compose up --build -d
for i in 1 2 3 4 5 6; do curl -sI http://localhost/listings | grep -i x-instance-id; done
docker compose stop app2
for i in 1 2 3 4; do curl -sI http://localhost/listings | grep -i x-instance-id; done
docker compose logs -f app1 app2 app3
```

## 10. Interview explanation

**Two-minute version**
> "I scaled the app horizontally: three identical Node instances behind Nginx using round robin.
> The key requirement is that the instances are stateless. Sessions are stored in MongoDB,
> images in Cloudinary, and cache and rate-limit counters in Redis, so any instance can serve any
> request and a user stays logged in whichever server they hit. Each instance exposes a health
> endpoint. Nginx stops routing to an instance after repeated failures, and retries a failed
> request on another instance, so I can kill one container and users don't notice. On shutdown,
> the app stops taking new connections and finishes in-flight requests before closing database
> connections. I added an X-Instance-Id header so you can see the load balancing happen."

**Likely questions**

| Question | Answer |
|---|---|
| Why not store sessions in memory? | Each instance would have its own sessions, so users would be randomly logged out. You'd then need sticky sessions, which breaks even load distribution and loses sessions when an instance dies. |
| Round robin vs least connections? | Round robin is fine when requests are similar in cost. `least_conn` is better when some requests are slow (uploads, long queries). It's a one-line change. |
| Why is Nginx itself not a single point of failure? | It is, in this setup. In production you run two load balancers with a floating IP, or use a managed one (AWS ALB). |
| Vertical vs horizontal scaling? | Vertical means a bigger machine: simple, but it has a ceiling and is one point of failure. Horizontal means more machines, which needs statelessness but has no hard ceiling. |
| Why `trust proxy`? | Behind a proxy, `req.ip` would be Nginx's IP. `trust proxy` makes Express read the real IP from `X-Forwarded-For`. |
| How does Node use multiple cores? | Each Node process is single-threaded, so running several processes (here, containers) uses several cores. |
