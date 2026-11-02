import { DataSource, Repository } from 'typeorm';
import { User } from '../users/entities/user.entity';
import { Channel } from '../channels/entities/channel.entity';
import { Video, VideoStatus } from './video.entity';
import { createTestDataSource } from '../test/create-test-data-source';

const ALL_ENTITIES = [User, Channel, Video];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let userRepo: Repository<User>;
  let channelRepo: Repository<Channel>;
  let videoRepo: Repository<Video>;
  let channelId: string;
  let counter = 0;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepo = dataSource.getRepository(User);
    channelRepo = dataSource.getRepository(Channel);
    videoRepo = dataSource.getRepository(Video);

    const user = await userRepo.save(
      userRepo.create({ email: 'video_test@example.com', password: 'hashed' }),
    );
    const channel = await channelRepo.save(
      channelRepo.create({
        name: 'Test Channel',
        nickname: 'test_channel',
        user_id: user.id,
      }),
    );
    channelId = channel.id;
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await dataSource.query('DELETE FROM "videos"');
  });

  function buildVideo(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      channel_id: channelId,
      title: `Video ${++counter}`,
      ...overrides,
    };
  }

  it('should auto-generate a 12-char URL-safe public_id via @BeforeInsert', async () => {
    const video = await videoRepo.save(videoRepo.create(buildVideo()));

    expect(video.public_id).toMatch(/^[A-Za-z0-9_-]{12}$/);
  });

  it('should default status to draft when not specified', async () => {
    const video = await videoRepo.save(videoRepo.create(buildVideo()));

    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should enforce unique constraint on public_id', async () => {
    const fixedId = 'AABBCCDDEEFF'.slice(0, 12);

    await videoRepo.save(videoRepo.create(buildVideo({ public_id: fixedId })));

    await expect(
      videoRepo.save(videoRepo.create(buildVideo({ public_id: fixedId }))),
    ).rejects.toThrow();
  });

  it('should reject INSERT without channel_id (NOT NULL constraint)', async () => {
    const video = videoRepo.create({ title: 'No channel' });

    await expect(videoRepo.save(video)).rejects.toThrow();
  });
});
