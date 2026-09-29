const { Redis } = require('ioredis');

// Redis backs the listings cache (utils/cache.js) and the rate limiters
// (middleware/rateLimit.js). It must never be required for the app to work:
// every caller checks isRedisReady() and falls back when it's false.
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379', {
  // Fail fast instead of hanging: if Redis is down or slow, any command
  // rejects after 500ms so callers can fall back (fail open) rather than
  // making the user's request wait on a dead connection.
  commandTimeout: 500,
});

// ioredis retries forever and fires 'error' on every failed attempt; log the
// transition once per outage instead of spamming the console.
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
