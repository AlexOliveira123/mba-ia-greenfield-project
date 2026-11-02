import { execSync } from 'node:child_process';
import { readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { Job } from 'bullmq';
import { Channel } from '../channels/entities/channel.entity';
import { StorageModule } from '../storage/storage.module';
import { StorageService } from '../storage/storage.service';
import storageConfig from '../config/storage.config';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from '../videos/video.entity';
import { VideoWorkerProcessor } from './video-worker.processor';

const ALL_ENTITIES = [User, Channel, Video];

function makeFakeJob(
  data: { videoId: string; storageKey: string },
  attemptsMade: number,
  attempts: number,
): Job<{ videoId: string; storageKey: string }> {
  return {
    data,
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<{ videoId: string; storageKey: string }>;
}

function generateTestVideo(outputPath: string): void {
  // 3-second 320×240 H.264 test video with silent audio, generated in-container
  execSync(
    `ffmpeg -y -f lavfi -i color=c=blue:s=320x240:r=25 -f lavfi -i anullsrc=r=44100:cl=stereo -t 3 -c:v libx264 -preset ultrafast -c:a aac "${outputPath}"`,
    { stdio: 'ignore' },
  );
}

describe('VideoWorkerProcessor (integration)', () => {
  let module: TestingModule;
  let processor: VideoWorkerProcessor;
  let dataSource: DataSource;
  let storageService: StorageService;
  let channelId: string;
  let videoId: string;
  const storageKey = 'videos/integration-test/video.mp4';
  const corruptKey = 'videos/integration-test/corrupt.mp4';

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [storageConfig] }),
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video, Channel, User]),
        StorageModule,
      ],
      providers: [VideoWorkerProcessor],
    }).compile();

    await module.init();

    processor = module.get(VideoWorkerProcessor);
    dataSource = module.get(DataSource);
    storageService = module.get(StorageService);

    await cleanAllTables(dataSource);

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);

    const user = await userRepo.save(
      userRepo.create({ email: 'worker_real@example.com', password: 'hashed' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Real IT Channel',
        nickname: 'worker_real_ch',
        user_id: user.id,
      }),
    );
    channelId = channel.id;

    // Upload a real test video and a corrupt file to MinIO
    const tmpVideo = join(tmpdir(), 'test-video-fixture.mp4');
    generateTestVideo(tmpVideo);
    const videoBuffer = readFileSync(tmpVideo);
    rmSync(tmpVideo, { force: true });

    await storageService.uploadFile(storageKey, videoBuffer, 'video/mp4');
    await storageService.uploadFile(
      corruptKey,
      Buffer.from('this is not a valid video file'),
      'video/mp4',
    );
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');

    const videoRepo = dataSource.getRepository(Video);
    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channelId,
        storage_key: storageKey,
        status: VideoStatus.PROCESSING,
        part_count: 1,
      }),
    );
    videoId = video.id;
  });

  it('should process a real video: status=ready, duration, thumbnail_key, and metadata persisted', async () => {
    const job = makeFakeJob({ videoId, storageKey }, 0, 3);
    await processor.process(job);

    const updated = await dataSource
      .getRepository(Video)
      .findOneBy({ id: videoId });

    expect(updated?.status).toBe(VideoStatus.READY);
    expect(updated?.duration).toBeGreaterThan(0);
    expect(updated?.thumbnail_key).toBe(`thumbnails/${videoId}/thumbnail.jpg`);

    const meta = updated?.metadata;
    expect(meta).toBeDefined();
    expect(meta?.width).toBeGreaterThan(0);
    expect(meta?.height).toBeGreaterThan(0);
    expect(typeof meta?.videoCodec).toBe('string');
    expect(meta?.videoCodec.length).toBeGreaterThan(0);
    expect(meta?.sizeBytes).toBeGreaterThan(0);
  });

  it('should upload the thumbnail to MinIO (file downloadable)', async () => {
    const job = makeFakeJob({ videoId, storageKey }, 0, 3);
    await processor.process(job);

    const thumbKey = `thumbnails/${videoId}/thumbnail.jpg`;
    const tmpDest = join(tmpdir(), `verify-thumb-${videoId}.jpg`);
    try {
      await storageService.downloadToFile(thumbKey, tmpDest);
      expect(statSync(tmpDest).size).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDest, { force: true });
    }
  });

  it('should set status=failed and failure_reason on the final attempt with a corrupt file', async () => {
    const videoRepo = dataSource.getRepository(Video);
    const corruptVideo = await videoRepo.save(
      videoRepo.create({
        channel_id: channelId,
        storage_key: corruptKey,
        status: VideoStatus.PROCESSING,
        part_count: 1,
      }),
    );

    // Simulate final attempt (attemptsMade = attempts - 1)
    const job = makeFakeJob(
      { videoId: corruptVideo.id, storageKey: corruptKey },
      2,
      3,
    );

    await expect(processor.process(job)).rejects.toThrow();

    const updated = await videoRepo.findOneBy({ id: corruptVideo.id });
    expect(updated?.status).toBe(VideoStatus.FAILED);
    expect(updated?.failure_reason).toBeTruthy();
  });
});
