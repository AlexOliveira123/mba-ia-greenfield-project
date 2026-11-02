jest.setTimeout(180_000);

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Queue } from 'bullmq';
import request from 'supertest';
import type { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/constants';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoStatus } from '../src/videos/video.entity';

// 5.5 MiB — all non-last S3 multipart parts must be ≥ 5 MiB
const PART_SIZE = 5 * 1024 * 1024 + 512 * 1024;
const POLL_INTERVAL_MS = 1500;
const READY_POLL_TIMEOUT_MS = 120_000;
const FAILED_POLL_TIMEOUT_MS = 60_000;

describe('Videos Pipeline (real e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let bullQueue: Queue;
  let s3Client: S3Client;
  let fixturePath: string = '';

  beforeAll(async () => {
    bullQueue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: {
        host: process.env.REDIS_HOST ?? 'redis',
        port: Number(process.env.REDIS_PORT ?? 6379),
      },
    });

    // Belt-and-suspenders worker check — pretest:e2e already verified with 15s;
    // this 30s window guards the rare case where the worker reconnects just after
    // the precheck but before the module boots.
    const workerDeadline = Date.now() + 30_000;
    let workerCount = 0;
    while (Date.now() < workerDeadline) {
      workerCount = (await bullQueue.getWorkers()).length;
      if (workerCount > 0) break;
      await new Promise<void>((r) => setTimeout(r, 1000));
    }
    if (!workerCount) {
      throw new Error(
        'No video-worker connected after 30s. Run on host: docker compose restart video-worker',
      );
    }

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);

    s3Client = new S3Client({
      endpoint: process.env.MINIO_ENDPOINT ?? 'http://minio:9000',
      region: process.env.MINIO_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'streamtube',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'streamtube123',
      },
      forcePathStyle: true,
    });

    // Generate ~11 MB fixture with noise (random-looking data resists H.264 compression
    // and keeps the file above 2 × PART_SIZE so partCount === 2 in the happy-path test)
    fixturePath = path.join(os.tmpdir(), 'pipeline-fixture.mp4');
    execSync(
      `ffmpeg -y -f lavfi -i 'nullsrc=s=640x480:r=25,noise=alls=25:allf=t+u' ` +
        `-f lavfi -i anullsrc=r=44100:cl=stereo -t 12 ` +
        `-c:v libx264 -preset ultrafast -b:v 8000k -maxrate 10000k -bufsize 1000k ` +
        `-c:a aac -b:a 128k ${fixturePath}`,
      { stdio: 'pipe' },
    );
  });

  afterAll(async () => {
    // Obliterate removes all jobs from Redis (force=true includes active jobs).
    // The 3s grace allows the worker to finish any job it started before obliterate
    // so the DB truncate below does not race against a live worker update.
    await bullQueue.obliterate({ force: true });
    await new Promise<void>((r) => setTimeout(r, 3000));
    await cleanAllTables(dataSource);
    await bullQueue.close();
    await app.close();
    if (fixturePath && fs.existsSync(fixturePath)) {
      fs.unlinkSync(fixturePath);
    }
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    jest.restoreAllMocks();
  });

  // ─── helpers ─────────────────────────────────────────────────────────────────

  async function registerAndLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mailSvc = (authService as any).mailService;
    let capturedToken = '';

    jest
      .spyOn(mailSvc, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        capturedToken = t;
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return (loginRes.body as { access_token: string }).access_token;
  }

  function getSubFromToken(token: string): string {
    const [, payload] = token.split('.');
    return (
      JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
        sub: string;
      }
    ).sub;
  }

  async function getChannelId(userId: string): Promise<string> {
    return (
      await dataSource
        .getRepository(Channel)
        .findOneByOrFail({ user_id: userId })
    ).id;
  }

  async function pollVideo(
    videoId: string,
    targetStatus: VideoStatus,
    timeoutMs: number,
  ): Promise<Video> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const v = await dataSource
        .getRepository(Video)
        .findOneBy({ id: videoId });
      if (v?.status === targetStatus) return v;
      await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
    const last = await dataSource
      .getRepository(Video)
      .findOneBy({ id: videoId });
    throw new Error(
      `Timeout: video ${videoId} never reached ${targetStatus}; last status: ${last?.status ?? 'not found'}`,
    );
  }

  // ─── a-g: happy-path ─────────────────────────────────────────────────────────

  it('a-g: initiates upload, uploads parts via presigned URLs, completes, polls to ready, streams, downloads', async () => {
    const accessToken = await registerAndLogin('pipeline-happy@example.com');
    const userId = getSubFromToken(accessToken);
    const channelId = await getChannelId(userId);
    const bucket = process.env.MINIO_BUCKET ?? 'streamtube';

    // a) Read fixture; assert it splits into exactly 2 parts
    const fileBuffer = fs.readFileSync(fixturePath);
    const partCount = Math.ceil(fileBuffer.length / PART_SIZE);
    expect(partCount).toBe(2);

    // b) POST /videos/upload/initiate → 201; DB row is DRAFT
    const initiateRes = await request(app.getHttpServer())
      .post('/videos/upload/initiate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        fileName: 'pipeline-test.mp4',
        fileSize: fileBuffer.length,
        mimeType: 'video/mp4',
        partCount,
      })
      .expect(201);

    const { videoId, publicId, uploadId, parts } = initiateRes.body as {
      videoId: string;
      publicId: string;
      uploadId: string;
      parts: { partNumber: number; presignedUrl: string }[];
    };

    const draftRow = await dataSource
      .getRepository(Video)
      .findOneBy({ id: videoId });
    expect(draftRow?.status).toBe(VideoStatus.DRAFT);

    // c) PUT each part to its presigned URL; collect ETags
    const collectedETags: string[] = [];
    for (const { partNumber, presignedUrl } of parts) {
      const start = (partNumber - 1) * PART_SIZE;
      const end = Math.min(start + PART_SIZE, fileBuffer.length);

      const putRes = await fetch(presignedUrl, {
        method: 'PUT',
        body: fileBuffer.subarray(start, end),
      });
      expect(putRes.ok).toBe(true);
      const eTag = putRes.headers.get('etag') ?? '';
      expect(eTag).toBeTruthy();
      collectedETags.push(eTag);
    }

    // d) POST /videos/upload/complete → 200; DB row is PROCESSING
    const completeRes = await request(app.getHttpServer())
      .post('/videos/upload/complete')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        videoId,
        uploadId,
        parts: parts.map((p, i) => ({
          partNumber: p.partNumber,
          eTag: collectedETags[i],
        })),
      })
      .expect(200);

    expect((completeRes.body as { status: string }).status).toBe(
      VideoStatus.PROCESSING,
    );

    const processingRow = await dataSource
      .getRepository(Video)
      .findOneBy({ id: videoId });
    expect(processingRow?.status).toBe(VideoStatus.PROCESSING);

    // e) Poll until READY; assert duration, metadata, thumbnail in MinIO
    const readyRow = await pollVideo(
      videoId,
      VideoStatus.READY,
      READY_POLL_TIMEOUT_MS,
    );

    expect(readyRow.duration).toBeGreaterThan(0);
    expect(readyRow.metadata).not.toBeNull();
    expect(readyRow.metadata?.width).toBeGreaterThan(0);
    expect(readyRow.metadata?.height).toBeGreaterThan(0);
    expect(readyRow.metadata?.videoCodec).toBeTruthy();
    expect(readyRow.thumbnail_key).toBeTruthy();

    await s3Client.send(
      new HeadObjectCommand({ Bucket: bucket, Key: readyRow.thumbnail_key! }),
    );

    // f) GET /videos/:publicId/stream-url → fetch with Range → 206
    const streamRes = await request(app.getHttpServer())
      .get(`/videos/${publicId}/stream-url`)
      .expect(200);

    const { url: streamUrl } = streamRes.body as { url: string };
    expect(streamUrl).toContain('X-Amz-Signature');

    const rangeRes = await fetch(streamUrl, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(rangeRes.status).toBe(206);
    expect(rangeRes.headers.get('content-range')).toMatch(/^bytes 0-1023\//);
    expect((await rangeRes.arrayBuffer()).byteLength).toBe(1024);

    // g) GET download-url → fetch it → Content-Disposition header starts with 'attachment'
    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${publicId}/download-url`)
      .expect(200);

    const { url: downloadUrl } = downloadRes.body as { url: string };
    expect(downloadUrl).toContain('X-Amz-Signature');

    // Use Range: bytes=0-0 to avoid a full file download while still exercising
    // the real MinIO response headers (presigned URL only works with GET, not HEAD)
    const dlFetchRes = await fetch(downloadUrl, {
      headers: { Range: 'bytes=0-0' },
    });
    const contentDisp = dlFetchRes.headers.get('content-disposition') ?? '';
    expect(contentDisp.toLowerCase()).toMatch(/^attachment/);
  });

  // ─── h: corrupted upload ─────────────────────────────────────────────────────

  it('h: uploading a corrupt file causes row=failed with failure_reason after all attempts', async () => {
    const accessToken = await registerAndLogin('pipeline-corrupt@example.com');
    const userId = getSubFromToken(accessToken);
    const channelId = await getChannelId(userId);

    // A buffer of 0xFF bytes has no valid MP4 container headers; ffprobe will fail
    const corruptPart = Buffer.alloc(6 * 1024 * 1024, 0xff);

    const initiateRes = await request(app.getHttpServer())
      .post('/videos/upload/initiate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        channelId,
        fileName: 'corrupt.mp4',
        fileSize: corruptPart.length,
        mimeType: 'video/mp4',
        partCount: 1,
      })
      .expect(201);

    const { videoId, uploadId, parts } = initiateRes.body as {
      videoId: string;
      uploadId: string;
      parts: { partNumber: number; presignedUrl: string }[];
    };

    const putRes = await fetch(parts[0].presignedUrl, {
      method: 'PUT',
      body: corruptPart,
    });
    expect(putRes.ok).toBe(true);
    const eTag = putRes.headers.get('etag') ?? '';

    await request(app.getHttpServer())
      .post('/videos/upload/complete')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ videoId, uploadId, parts: [{ partNumber: 1, eTag }] })
      .expect(200);

    const failedRow = await pollVideo(
      videoId,
      VideoStatus.FAILED,
      FAILED_POLL_TIMEOUT_MS,
    );
    expect(failedRow.failure_reason).toBeTruthy();
  });

  // ─── i: error cases ──────────────────────────────────────────────────────────

  it('i: non-owner complete → VIDEO_NOT_FOUND; stream-url for non-ready video → VIDEO_NOT_FOUND', async () => {
    // Owner initiates an upload (creates a real MinIO multipart upload + DRAFT row)
    const ownerToken = await registerAndLogin('pipeline-owner@example.com');
    const ownerId = getSubFromToken(ownerToken);
    const ownerChannelId = await getChannelId(ownerId);

    const initiateRes = await request(app.getHttpServer())
      .post('/videos/upload/initiate')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        channelId: ownerChannelId,
        fileName: 'owner-video.mp4',
        fileSize: 6 * 1024 * 1024,
        mimeType: 'video/mp4',
        partCount: 1,
      })
      .expect(201);

    const { videoId, publicId } = initiateRes.body as {
      videoId: string;
      publicId: string;
    };

    // A different authenticated user tries to complete the owner's upload
    const otherToken = await registerAndLogin('pipeline-other@example.com');

    const completeRes = await request(app.getHttpServer())
      .post('/videos/upload/complete')
      .set('Authorization', `Bearer ${otherToken}`)
      .send({
        videoId,
        uploadId: 'irrelevant-upload-id',
        parts: [{ partNumber: 1, eTag: '"fake-etag"' }],
      })
      .expect(404);

    expect((completeRes.body as { error: string }).error).toBe(
      'VIDEO_NOT_FOUND',
    );

    // stream-url for a DRAFT (not yet ready) video
    const streamRes = await request(app.getHttpServer())
      .get(`/videos/${publicId}/stream-url`)
      .expect(404);

    expect((streamRes.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
  });
});
