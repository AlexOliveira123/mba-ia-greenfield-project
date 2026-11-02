import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import queueConfig from './queue.config';

const loadConfig = async (
  env: Partial<Record<string, string>>,
): Promise<ConfigType<typeof queueConfig>> => {
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [queueConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof queueConfig>>(queueConfig.KEY);
  await module.close();
  return config;
};

describe('queueConfig', () => {
  const KEYS = [
    'REDIS_HOST',
    'REDIS_PORT',
    'VIDEO_JOB_ATTEMPTS',
    'VIDEO_JOB_BACKOFF_MS',
  ] as const;
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of KEYS) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('should return config with provided values', async () => {
    const config = await loadConfig({
      REDIS_HOST: 'my-redis',
      REDIS_PORT: '6380',
      VIDEO_JOB_ATTEMPTS: '5',
      VIDEO_JOB_BACKOFF_MS: '1000',
    });

    expect(config).toMatchObject({
      redisHost: 'my-redis',
      redisPort: 6380,
      jobAttempts: 5,
      jobBackoffMs: 1000,
    });
  });

  it('should apply defaults when vars are missing', async () => {
    for (const key of KEYS) delete process.env[key];

    const config = await loadConfig({});

    expect(config.redisHost).toBe('redis');
    expect(config.redisPort).toBe(6379);
    expect(config.jobAttempts).toBe(3);
    expect(config.jobBackoffMs).toBe(5000);
  });
});
