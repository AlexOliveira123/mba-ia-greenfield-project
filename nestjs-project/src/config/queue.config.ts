import { registerAs } from '@nestjs/config';

export default registerAs('queue', () => ({
  redisHost: process.env.REDIS_HOST || 'redis',
  redisPort: parseInt(process.env.REDIS_PORT || '6379', 10),
  jobAttempts: parseInt(process.env.VIDEO_JOB_ATTEMPTS || '3', 10),
  jobBackoffMs: parseInt(process.env.VIDEO_JOB_BACKOFF_MS || '5000', 10),
}));
