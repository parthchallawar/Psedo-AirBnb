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
