import { Test, TestingModule } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from '../queue/constants';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import type { UploadInitiateDto } from './dto/upload-initiate.dto';
import { Video, VideoStatus } from './video.entity';
import { VideosService } from './videos.service';

const ALL_ENTITIES = [User, Channel, Video];

describe('VideosService.initiateUpload (integration)', () => {
  let module: TestingModule;
  let service: VideosService;
  let dataSource: DataSource;
  let storageService: {
    createMultipartUpload: jest.Mock;
    getPresignedPartUrls: jest.Mock;
  };
  let channelId: string;
  let userId: string;

  beforeAll(async () => {
    const ds = createTestDataSource(ALL_ENTITIES);

    storageService = {
      createMultipartUpload: jest.fn(),
      getPresignedPartUrls: jest.fn(),
    };

    module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot(ds.options),
        TypeOrmModule.forFeature([Video, Channel, User]),
      ],
      providers: [
        VideosService,
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: jest.fn() },
        },
        {
          provide: queueConfig.KEY,
          useValue: {
            redisHost: 'redis',
            redisPort: 6379,
            jobAttempts: 3,
            jobBackoffMs: 5000,
          },
        },
      ],
    }).compile();

    service = module.get(VideosService);
    dataSource = module.get(DataSource);

    const userRepo = dataSource.getRepository(User);
    const channelRepo = dataSource.getRepository(Channel);

    const user = await userRepo.save(
      userRepo.create({ email: 'videos_it@example.com', password: 'hashed' }),
    );
    userId = user.id;

    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'IT Channel',
        nickname: 'it_channel',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  afterAll(async () => {
    await module.close();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
    jest.clearAllMocks();
  });

  it('should create a draft Video with upload_id and public_id in the DB', async () => {
    storageService.createMultipartUpload.mockResolvedValue({
      uploadId: 'up-abc123',
    });
    storageService.getPresignedPartUrls.mockResolvedValue([
      { partNumber: 1, presignedUrl: 'https://storage/part1' },
    ]);

    const dto: UploadInitiateDto = {
      channelId,
      fileName: 'clip.mp4',
      fileSize: 5 * 1024 * 1024,
      mimeType: 'video/mp4',
      partCount: 1,
    };

    const result = await service.initiateUpload(dto, userId);

    expect(result.videoId).toBeDefined();
    expect(result.publicId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(result.uploadId).toBe('up-abc123');
    expect(result.parts).toHaveLength(1);

    const saved = await dataSource
      .getRepository(Video)
      .findOneBy({ id: result.videoId });
    expect(saved?.status).toBe(VideoStatus.DRAFT);
    expect(saved?.upload_id).toBe('up-abc123');
    expect(saved?.storage_key).toContain('clip.mp4');
  });
});
