require('dotenv').config();
const { Worker } = require('bullmq');
const { createMailer } = require('./mailer.js');
const templates = require('./templates.js');

const QUEUE_NAME = 'notifications';
const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const { hostname, port } = new URL(redisUrl);

async function main() {
  console.log(`Starting notification worker (Queue: "${QUEUE_NAME}", Redis: ${redisUrl})...`);

  let mailer;
  try {
    mailer = await createMailer();
  } catch (err) {
    console.error('Failed to initialize mailer:', err);
    process.exit(1);
  }

  const failRate = Number(process.env.FAIL_RATE) || 0;
  if (failRate > 0) {
    console.log(`Failure simulation enabled: FAIL_RATE=${failRate}`);
  }

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      // Failure simulation for retry demonstration
      if (failRate > 0 && Math.random() < failRate) {
        throw new Error(`Simulated email provider failure (FAIL_RATE=${failRate})`);
      }

      const build = templates[job.name];
      if (!build) {
        throw new Error(`Unknown job type: "${job.name}"`);
      }

      const emails = build(job.data);
      const previews = [];

      for (const email of emails) {
        const previewUrl = await mailer.send(email);
        if (previewUrl) {
          previews.push(previewUrl);
        }
      }

      return { previews };
    },
    {
      connection: {
        host: hostname,
        port: Number(port) || 6379,
        // Worker connection must have maxRetriesPerRequest: null in BullMQ
        maxRetriesPerRequest: null,
      },
      concurrency: 5,
    }
  );

  worker.on('completed', (job, result) => {
    const previewList = result?.previews?.length ? ` Preview(s): ${result.previews.join(' , ')}` : '';
    console.log(`[Job Completed] id=${job.id} name=${job.name}${previewList}`);
  });

  worker.on('failed', (job, err) => {
    const totalAttempts = job?.opts?.attempts || 3;
    const attemptsMade = job?.attemptsMade || 0;
    const isFinal = attemptsMade >= totalAttempts;
    console.log(
      `[Job Failed] id=${job?.id} name=${job?.name} (attempt ${attemptsMade}/${totalAttempts}): ${err.message}${
        isFinal ? ' — gave up (moved to failed set)' : ' — will retry'
      }`
    );
  });

  let lastErrorLog = 0;
  worker.on('error', (err) => {
    if (Date.now() - lastErrorLog > 60_000) {
      console.error('Worker error:', err.message);
      lastErrorLog = Date.now();
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received: notification worker shutting down gracefully`);

    setTimeout(() => {
      console.log('Shutdown timed out, forcing exit');
      process.exit(1);
    }, 8000).unref();

    try {
      await worker.close();
      console.log('Notification worker closed cleanly');
      process.exit(0);
    } catch (err) {
      console.error('Error during worker shutdown:', err);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  console.log('Notification worker is listening for jobs.');
}

main().catch((err) => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
