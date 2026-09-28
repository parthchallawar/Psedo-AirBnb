const { redis, isRedisReady } = require('../config/redis.js');

const LISTINGS_INDEX_PREFIX = 'listings:index:';

// Cache-aside: return cached JSON if present, otherwise run loader() and
// cache its result. Any Redis problem (down, slow, bad data) falls back to
// loader() instead — the cache must never be the reason a page fails to load.
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
    // Not awaited: the response shouldn't wait on the cache write.
    redis.set(key, JSON.stringify(data), 'EX', ttlSeconds)
      .catch((err) => console.log('Cache write failed:', err.message));
  }

  return { data, hit: false };
};

// Delete every key starting with prefix. SCAN walks the keyspace in small
// batches; KEYS would block Redis for as long as the scan takes.
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
// Called whenever a listing or review changes, so the next /listings request
// is a cache miss and reflects the change immediately (see phase-1 plan D9).
module.exports.invalidateListingsCache = () => deleteByPrefix(LISTINGS_INDEX_PREFIX);
