const { Queue } = require('bullmq');

const QUEUE_NAME = 'notifications';

// BullMQ takes ioredis connection options (it creates its own client).
const { hostname, port } = new URL(process.env.REDIS_URL || 'redis://127.0.0.1:6379');

const queue = new Queue(QUEUE_NAME, {
  connection: {
    host: hostname,
    port: Number(port) || 6379,
    // Fail fast when Redis is down. With BullMQ's defaults, add() waits
    // indefinitely (tested), which would hang the user's booking request.
    enableOfflineQueue: false,
  },
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 }, // retry after 2s, then 4s
    removeOnComplete: 100,                         // keep the last 100 for inspection
    removeOnFail: 500,                             // failed jobs stay: a simple dead-letter queue
  },
});

// Without a listener BullMQ prints a full stack trace on every reconnect
// attempt during a Redis outage (tested). Log at most once a minute instead.
let lastErrorLog = 0;
queue.on('error', (err) => {
  if (Date.now() - lastErrorLog > 60_000) {
    console.log('Notification queue unavailable:', err.message);
    lastErrorLog = Date.now();
  }
});

// Enqueue a notification. Never throws: the booking/review is already saved,
// so a queue problem must not turn a success into an error for the user.
// `jobId` makes enqueueing idempotent: the same id twice is one job.
module.exports.publishNotification = async (name, data, jobId) => {
  try {
    await queue.add(name, data, { jobId });
  } catch (err) {
    console.log(`Could not enqueue ${name} (${jobId}):`, err.message);
  }
};

module.exports.closeNotificationQueue = () => queue.close().catch(() => {});
module.exports.QUEUE_NAME = QUEUE_NAME;
