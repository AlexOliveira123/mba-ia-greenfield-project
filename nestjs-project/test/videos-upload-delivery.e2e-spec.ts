import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { Channel } from '../src/channels/entities/channel.entity';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { VIDEO_PROCESSING_QUEUE } from '../src/queue/constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { Video, VideoMetadata, VideoStatus } from '../src/videos/video.entity';

const mockStorageService = {
  createMultipartUpload: jest.fn(),
  getPresignedPartUrls: jest.fn(),
  completeMultipartUpload: jest.fn(),
  getPresignedGetUrl: jest.fn(),
};

const mockVideoQueue = {
  add: jest.fn(),
};

describe('Videos Upload & Delivery (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(StorageService)
      .useValue(mockStorageService)
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue(mockVideoQueue)
      .compile();

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
  });

  afterAll(async () => {
    await app.close();
    jest.restoreAllMocks();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    jest.restoreAllMocks();
  });

  async function registerConfirmAndLogin(email: string): Promise<string> {
    const authService = app.get(AuthService);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
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

    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    return loginRes.body.access_token as string;
  }

  async function getChannelIdForUser(userId: string): Promise<string> {
    const channelRepo = dataSource.getRepository(Channel);
    const channel = await channelRepo.findOneByOrFail({ user_id: userId });
    return channel.id;
  }

  function getUserIdFromToken(accessToken: string): string {
    const [, payload] = accessToken.split('.');
    const decoded = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as { sub: string };
    return decoded.sub;
  }

  describe('POST /videos/upload/initiate', () => {
    it('1.1 returns 401 when no Authorization header is provided', async () => {
      const channelId = '00000000-0000-0000-0000-000000000001';
      await request(app.getHttpServer())
        .post('/videos/upload/initiate')
        .send({
          channelId,
          fileName: 'video.mp4',
          fileSize: 52428800,
          mimeType: 'video/mp4',
          partCount: 1,
        })
        .expect(401);
    });
  });

  describe('POST /videos/upload/complete', () => {
    it('2.1 returns 404 with VIDEO_NOT_FOUND when videoId does not exist', async () => {
      const accessToken = await registerConfirmAndLogin(
        'completer@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/upload/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          videoId: '00000000-0000-0000-0000-000000000000',
          uploadId: 'fake-upload-id',
          parts: [{ partNumber: 1, eTag: '"abc123"' }],
        })
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });

    it('2.2 returns 422 with UPLOAD_PART_COUNT_MISMATCH when parts count is wrong', async () => {
      const accessToken = await registerConfirmAndLogin(
        'completer2@example.com',
      );
      const userId = getUserIdFromToken(accessToken);
      const channelId = await getChannelIdForUser(userId);

      const videoRepo = dataSource.getRepository(Video);
      const video = await videoRepo.save(
        videoRepo.create({
          channel_id: channelId,
          storage_key: 'videos/test/video.mp4',
          status: VideoStatus.DRAFT,
          upload_id: 'some-upload-id',
          part_count: 2,
        }),
      );

      const res = await request(app.getHttpServer())
        .post('/videos/upload/complete')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          videoId: video.id,
          uploadId: 'some-upload-id',
          parts: [{ partNumber: 1, eTag: '"abc123"' }],
        })
        .expect(422);

      expect((res.body as { error: string }).error).toBe(
        'UPLOAD_PART_COUNT_MISMATCH',
      );
    });
  });

  describe('GET /videos/:publicId/download-url', () => {
    it('4.1 returns 404 with VIDEO_NOT_FOUND when publicId does not exist', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/nonexistent0000/download-url')
        .expect(404);

      expect((res.body as { error: string }).error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('Video metadata (jsonb round-trip, simulates worker output)', () => {
    it('5.1 metadata and failure_reason are persisted and retrieved correctly via TypeORM', async () => {
      const accessToken = await registerConfirmAndLogin('metauser@example.com');
      const userId = getUserIdFromToken(accessToken);
      const channelId = await getChannelIdForUser(userId);

      const expectedMetadata: VideoMetadata = {
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioCodec: 'aac',
        bitrateKbps: 5000,
        fps: 30,
        format: 'mov,mp4',
        sizeBytes: 18750000,
      };

      const videoRepo = dataSource.getRepository(Video);
      const video = await videoRepo.save(
        videoRepo.create({
          channel_id: channelId,
          storage_key: 'videos/meta-test/video.mp4',
          status: VideoStatus.READY,
          part_count: 1,
          duration: 30,
          thumbnail_key: 'thumbnails/meta-test/thumbnail.jpg',
          metadata: expectedMetadata,
        }),
      );

      const fetched = await videoRepo.findOneBy({ id: video.id });
      expect(fetched?.metadata).toEqual(expectedMetadata);
      expect(fetched?.failure_reason).toBeNull();
    });

    it('5.2 failure_reason is persisted for failed videos', async () => {
      const accessToken = await registerConfirmAndLogin(
        'failedvid@example.com',
      );
      const userId = getUserIdFromToken(accessToken);
      const channelId = await getChannelIdForUser(userId);

      const videoRepo = dataSource.getRepository(Video);
      const video = await videoRepo.save(
        videoRepo.create({
          channel_id: channelId,
          storage_key: 'videos/fail-test/video.mp4',
          status: VideoStatus.FAILED,
          part_count: 1,
          failure_reason: 'FFmpeg exited with code 1: invalid input',
        }),
      );

      const fetched = await videoRepo.findOneBy({ id: video.id });
      expect(fetched?.status).toBe(VideoStatus.FAILED);
      expect(fetched?.failure_reason).toBe(
        'FFmpeg exited with code 1: invalid input',
      );
      expect(fetched?.metadata).toBeNull();
    });
  });
});
