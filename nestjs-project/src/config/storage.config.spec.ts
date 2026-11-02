import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import storageConfig from './storage.config';

const loadConfig = async (
  env: Partial<Record<string, string>>,
): Promise<ConfigType<typeof storageConfig>> => {
  Object.assign(process.env, env);

  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [storageConfig] }),
    ],
  }).compile();

  const config = module.get<ConfigType<typeof storageConfig>>(
    storageConfig.KEY,
  );
  await module.close();
  return config;
};

describe('storageConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of [
      'MINIO_ENDPOINT',
      'MINIO_PUBLIC_ENDPOINT',
      'MINIO_REGION',
      'MINIO_ACCESS_KEY',
      'MINIO_SECRET_KEY',
      'MINIO_BUCKET',
    ]) {
      if (key in originalEnv) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  it('should return config with provided values', async () => {
    const config = await loadConfig({
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_PUBLIC_ENDPOINT: 'http://localhost:9000',
      MINIO_REGION: 'us-east-1',
      MINIO_ACCESS_KEY: 'test-access-key',
      MINIO_SECRET_KEY: 'test-secret-key',
      MINIO_BUCKET: 'test-bucket',
    });

    expect(config).toMatchObject({
      endpoint: 'http://minio:9000',
      publicEndpoint: 'http://localhost:9000',
      region: 'us-east-1',
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      bucket: 'test-bucket',
    });
  });

  it('should apply defaults when optional vars are missing', async () => {
    delete process.env.MINIO_ENDPOINT;
    delete process.env.MINIO_PUBLIC_ENDPOINT;
    delete process.env.MINIO_REGION;
    delete process.env.MINIO_BUCKET;

    const config = await loadConfig({
      MINIO_ACCESS_KEY: 'key',
      MINIO_SECRET_KEY: 'secret',
    });

    expect(config.endpoint).toBe('http://minio:9000');
    expect(config.publicEndpoint).toBe('http://minio:9000');
    expect(config.region).toBe('us-east-1');
    expect(config.bucket).toBe('streamtube');
  });

  it('publicEndpoint should fall back to MINIO_ENDPOINT when MINIO_PUBLIC_ENDPOINT is not set', async () => {
    delete process.env.MINIO_PUBLIC_ENDPOINT;

    const config = await loadConfig({
      MINIO_ENDPOINT: 'http://custom:9000',
      MINIO_ACCESS_KEY: 'key',
      MINIO_SECRET_KEY: 'secret',
    });

    expect(config.endpoint).toBe('http://custom:9000');
    expect(config.publicEndpoint).toBe('http://custom:9000');
  });
});
