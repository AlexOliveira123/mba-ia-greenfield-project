import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import { StorageModule } from './storage.module';
import { StorageService } from './storage.service';
import { STORAGE_CLIENT_INTERNAL } from './storage.constants';

describe('StorageService (integration)', () => {
  let module: TestingModule;
  let service: StorageService;
  let s3Internal: S3Client;
  const bucket = process.env.MINIO_BUCKET ?? 'streamtube';
  const publicEndpoint =
    process.env.MINIO_PUBLIC_ENDPOINT ||
    process.env.MINIO_ENDPOINT ||
    'http://minio:9000';

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        StorageModule,
      ],
    }).compile();

    await module.init();

    service = module.get(StorageService);
    s3Internal = module.get<S3Client>(STORAGE_CLIENT_INTERNAL);
  });

  afterAll(async () => {
    await module.close();
  });

  it('ensureBucket() is idempotent — second call does not throw', async () => {
    await expect(service.ensureBucket()).resolves.not.toThrow();
  });

  it('should createMultipartUpload and return a non-empty uploadId', async () => {
    const key = `integration-test/${Date.now()}-probe.bin`;

    const { uploadId } = await service.createMultipartUpload(key);

    expect(typeof uploadId).toBe('string');
    expect(uploadId.length).toBeGreaterThan(0);

    await s3Internal.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  });

  it('should complete a 1-part multipart upload end-to-end', async () => {
    const key = `integration-test/${Date.now()}-complete.bin`;
    const body = Buffer.from('hello multipart MinIO integration test');

    const { uploadId } = await service.createMultipartUpload(key);

    const { ETag } = await s3Internal.send(
      new UploadPartCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: 1,
        Body: body,
      }),
    );
    expect(ETag).toBeDefined();

    await expect(
      service.completeMultipartUpload(key, uploadId, [
        { partNumber: 1, eTag: ETag! },
      ]),
    ).resolves.not.toThrow();
  });

  it('getPresignedPartUrls should return URLs containing X-Amz-Signature and public endpoint host', async () => {
    const key = `integration-test/${Date.now()}-presigned.bin`;
    const { uploadId } = await service.createMultipartUpload(key);

    const parts = await service.getPresignedPartUrls(key, uploadId, 3);

    expect(parts).toHaveLength(3);
    for (const part of parts) {
      expect(part.presignedUrl).toContain('X-Amz-Signature');
      const host = new URL(publicEndpoint).host;
      expect(part.presignedUrl).toContain(host);
    }

    await s3Internal.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  });

  it('getPresignedGetUrl should return URL with correct TTL and public endpoint host', async () => {
    const key = `integration-test/${Date.now()}-get.bin`;

    const url = await service.getPresignedGetUrl(key, 14400);

    expect(url).toContain('X-Amz-Expires=14400');
    const host = new URL(publicEndpoint).host;
    expect(url).toContain(host);
  });

  it('getPresignedGetUrl with disposition should include response-content-disposition', async () => {
    const key = `integration-test/${Date.now()}-download.bin`;

    const url = await service.getPresignedGetUrl(
      key,
      3600,
      'attachment; filename="video.mp4"',
    );

    expect(url).toContain('response-content-disposition');
    const host = new URL(publicEndpoint).host;
    expect(url).toContain(host);
  });

  // CORS gate: if these assertions fail, STOP — do NOT delete or weaken the test.
  // Open /decide to record the correct CORS decision.
  it('CORS: OPTIONS preflight to presigned PUT URL should return Access-Control-Allow-Origin', async () => {
    const key = `cors-test/${Date.now()}-preflight.bin`;
    const { uploadId } = await service.createMultipartUpload(key);
    const [{ presignedUrl }] = await service.getPresignedPartUrls(
      key,
      uploadId,
      1,
    );

    const response = await fetch(presignedUrl, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://localhost:3001',
        'Access-Control-Request-Method': 'PUT',
      },
    });

    expect(response.headers.get('access-control-allow-origin')).toBeTruthy();

    await s3Internal.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  });

  it('CORS: PUT to presigned URL should expose ETag in Access-Control-Expose-Headers', async () => {
    const key = `cors-test/${Date.now()}-put.bin`;
    const { uploadId } = await service.createMultipartUpload(key);
    const [{ presignedUrl }] = await service.getPresignedPartUrls(
      key,
      uploadId,
      1,
    );

    const body = Buffer.from('hello cors integration test');
    const putResponse = await fetch(presignedUrl, {
      method: 'PUT',
      body,
      headers: {
        'Content-Type': 'application/octet-stream',
        Origin: 'http://localhost:3001',
      },
    });

    expect(putResponse.ok).toBe(true);
    const exposeHeaders = putResponse.headers.get(
      'access-control-expose-headers',
    );
    expect(exposeHeaders?.toLowerCase()).toContain('etag');

    await s3Internal.send(
      new AbortMultipartUploadCommand({
        Bucket: bucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  });
});
