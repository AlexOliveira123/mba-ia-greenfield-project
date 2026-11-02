/**
 * Verifies that the video-worker BullMQ consumer is connected and active.
 * Run inside the nestjs-api container as part of `pretest:e2e`.
 *
 * If no worker is found within 15s, exits with code 1 and prints instructions.
 * Run on the HOST before retrying: docker compose restart video-worker
 */

import { Queue } from 'bullmq';

// Load .env (import declarations are hoisted; env is set before Queue is instantiated)
try {
  process.loadEnvFile('.env');
} catch {
  // .env absent — rely on existing process.env (e.g. CI environment)
}

const QUEUE_NAME = 'video-processing';
const TIMEOUT_MS = 15_000;

const queue = new Queue(QUEUE_NAME, {
  connection: {
    host: process.env.REDIS_HOST ?? 'redis',
    port: Number(process.env.REDIS_PORT ?? 6379),
  },
});

const deadline = Date.now() + TIMEOUT_MS;
let workers = [];

while (Date.now() < deadline) {
  workers = await queue.getWorkers();
  if (workers.length > 0) break;
  await new Promise((r) => setTimeout(r, 1000));
}

await queue.close();

if (!workers.length) {
  process.stderr.write(
    `\nERROR: No video-worker connected after ${TIMEOUT_MS / 1000}s.\n` +
      `Run on the host before retrying:\n` +
      `  docker compose restart video-worker\n\n`,
  );
  process.exit(1);
}

process.stdout.write(`video-worker OK (${workers.length} worker(s) active)\n`);
