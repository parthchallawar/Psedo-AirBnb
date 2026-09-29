const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Redis } = require('ioredis');
const passport = require('passport');
const registerChatHandlers = require('./chat.js');

let pubClient;
let subClient;

// Run an Express middleware against a socket's underlying request, with a
// throwaway {} response object.
//
// This is Socket.IO's own documented pattern for reusing express-session,
// and it matters here for a concrete reason we hit while testing: mounting
// session/passport middleware on the raw handshake via io.engine.use(req,
// res, next) crashes the process (`res._implicitHeader is not a function`)
// the moment the middleware tries to write a Set-Cookie header, because the
// WebSocket-upgrade "response" Engine.IO hands it isn't a full
// http.ServerResponse. Running the same middleware via io.use(socket, next)
// instead operates purely on socket.request — none of these middlewares
// need to WRITE a response back, only read the cookie and populate
// req.session/req.user — so the fake {} is never touched and nothing tries
// to flush headers through it.
const wrap = (middleware) => (socket, next) => middleware(socket.request, {}, next);

module.exports.createSocketServer = (httpServer, { sessionMiddleware, instanceId }) => {
  const url = process.env.REDIS_URL || 'redis://127.0.0.1:6379';

  // Dedicated Redis clients for the adapter — NOT the shared Phase 1 client
  // (config/redis.js), which times out commands after 500ms. Tested: with
  // that timeout, the subscriber's initial subscribe silently failed and
  // cross-instance messages were lost even with Redis up. The subscriber
  // here has no command timeout, so it waits for Redis instead of giving up,
  // and ioredis re-subscribes automatically after a reconnect.
  subClient = new Redis(url, { maxRetriesPerRequest: null });
  pubClient = new Redis(url, { enableOfflineQueue: false });
  // Outages are already logged once by config/redis.js's listener; these
  // clients only need a handler so ioredis doesn't crash on 'error'.
  subClient.on('error', () => {});
  pubClient.on('error', () => {});

  // The adapter's own publish() has no .catch(). Without this wrapper, a
  // Redis outage would turn every chat message into an unhandled promise
  // rejection, which crashes the whole Node process (tested). Wrapping it
  // means a Redis outage pauses cross-instance delivery but the app stays
  // up — same fail-open policy as Phase 1's cache and rate limiter.
  const publish = pubClient.publish.bind(pubClient);
  pubClient.publish = (...args) =>
    publish(...args).catch((err) => console.log('Socket.IO publish failed:', err.message));

  const io = new Server(httpServer, { adapter: createAdapter(pubClient, subClient) });

  // Reuse the Express login session: the browser sends the same session
  // cookie on the WebSocket handshake, so socket.request.user is the
  // logged-in user, with no separate socket auth step.
  io.use(wrap(sessionMiddleware));
  io.use(wrap(passport.session()));
  io.use((socket, next) => {
    if (socket.request.user) return next();
    next(new Error('unauthorized'));
  });

  io.on('connection', (socket) => registerChatHandlers(io, socket, { instanceId }));
  return io;
};

module.exports.closeSocketServer = () => {
  // disconnect(), not quit(): the subscriber may have a queued subscribe
  // (Redis down), and quit() would wait behind it forever.
  subClient?.disconnect();
  pubClient?.disconnect();
};
