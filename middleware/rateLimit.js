const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redis, isRedisReady } = require('../config/redis.js');
const ExpressError = require('../utils/ExpressError.js');

// Counters live in Redis so every app instance shares the same count
// (Phase 2 runs three instances behind a load balancer).
const makeStore = (prefix, windowMs) => {
  const store = new RedisStore({
    prefix,
    sendCommand: (...args) => redis.call(...args),
  });
  // rate-limit-redis loads its Lua scripts into Redis once, at startup. If
  // Redis was down then, the scripts never load and rate limiting silently
  // stays off. Reloading on every reconnect lets it recover on its own.
  redis.on('ready', () => store.init({ windowMs }).catch(() => {}));
  return store;
};

const createLimiter = ({ prefix, windowMs, limit }) => rateLimit({
  windowMs,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  store: makeStore(prefix, windowMs),
  skip: () => !isRedisReady(), // fail open instantly when Redis is known to be down
  passOnStoreError: true, // ...and fail open if a Redis call fails mid-request
  message: 'Too many requests, please try again later.',
  handler: (req, res, next, options) =>
    next(new ExpressError(options.statusCode, options.message)),
});

// Brute-force protection for login and signup: 10 attempts per IP per 15 min.
module.exports.authLimiter = createLimiter({
  prefix: 'rl:auth:',
  windowMs: 15 * 60 * 1000,
  limit: 10,
});

// Flood protection for the whole site: 100 requests per IP per minute.
module.exports.globalLimiter = createLimiter({
  prefix: 'rl:global:',
  windowMs: 60 * 1000,
  limit: 100,
});
