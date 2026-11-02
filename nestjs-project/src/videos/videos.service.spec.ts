import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import { StorageService } from '../storage/storage.service';
import {
  UploadCompleteFailedException,
  UploadInitiateFailedException,
  UploadOwnershipException,
  UploadPartCountMismatchException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { VIDEO_PROCESSING_QUEUE } from '../queue/constants';
import type { UploadCompleteDto } from './dto/upload-complete.dto';
import type { UploadInitiateDto } from './dto/upload-initiate.dto';
import { Video, VideoStatus } from './video.entity';
import { VideosService } from './videos.service';

const mockDto: UploadInitiateDto = {
  channelId: '11111111-1111-1111-1111-111111111111',
  fileName: 'test.mp4',
  fileSize: 1024,
  mimeType: 'video/mp4',
  partCount: 2,
};

const mockChannel = { id: mockDto.channelId, user_id: 'user-1' } as Channel;

const mockVideo = {
  id: 'vid-uuid',
  public_id: 'AABBCCDDEE12',
  status: VideoStatus.DRAFT,
  storage_key: 'videos/key/test.mp4',
  upload_id: null,
  channel_id: mockDto.channelId,
} as Video;

const mockVideoWithChannel = {
  id: 'vid-uuid',
  public_id: 'AABBCCDDEE12',
  status: VideoStatus.DRAFT,
  storage_key: 'videos/key/test.mp4',
  upload_id: 'upload-123',
  part_count: 2,
  channel_id: '11111111-1111-1111-1111-111111111111',
  channel: { id: '11111111-1111-1111-1111-111111111111', user_id: 'user-1' },
} as unknown as Video;

describe('VideosService', () => {
  let service: VideosService;
  let videoRepo: {
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
    delete: jest.Mock;
    findOne: jest.Mock;
  };
  let channelRepo: { findOne: jest.Mock };
  let storageService: {
    createMultipartUpload: jest.Mock;
    getPresignedPartUrls: jest.Mock;
    completeMultipartUpload: jest.Mock;
    getPresignedGetUrl: jest.Mock;
  };
  let videoQueue: { add: jest.Mock };

  beforeAll(async () => {
    videoRepo = {
      create: jest.fn(),
      save: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      findOne: jest.fn(),
    };
    channelRepo = { findOne: jest.fn() };
    storageService = {
      createMultipartUpload: jest.fn(),
      getPresignedPartUrls: jest.fn(),
      completeMultipartUpload: jest.fn(),
      getPresignedGetUrl: jest.fn(),
    };
    videoQueue = { add: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: getRepositoryToken(Channel), useValue: channelRepo },
        { provide: StorageService, useValue: storageService },
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: videoQueue,
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
  });

  beforeEach(() => jest.clearAllMocks());

  describe('initiateUpload', () => {
    it('should throw UploadOwnershipException when channelId does not belong to userId', async () => {
      channelRepo.findOne.mockResolvedValue(null);

      await expect(
        service.initiateUpload(mockDto, 'other-user'),
      ).rejects.toThrow(UploadOwnershipException);
    });

    it('should return videoId, publicId, uploadId and parts on success', async () => {
      channelRepo.findOne.mockResolvedValue(mockChannel);
      videoRepo.create.mockReturnValue(mockVideo);
      videoRepo.save.mockResolvedValue(mockVideo);
      storageService.createMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
      });
      storageService.getPresignedPartUrls.mockResolvedValue([
        { partNumber: 1, presignedUrl: 'https://s3/part1?X-Amz-Signature=s1' },
        { partNumber: 2, presignedUrl: 'https://s3/part2?X-Amz-Signature=s2' },
      ]);
      videoRepo.update.mockResolvedValue({});

      const result = await service.initiateUpload(mockDto, 'user-1');

      expect(result.videoId).toBe(mockVideo.id);
      expect(result.publicId).toBe(mockVideo.public_id);
      expect(result.uploadId).toBe('upload-123');
      expect(result.parts).toHaveLength(2);
      expect(videoRepo.update).toHaveBeenCalledWith(mockVideo.id, {
        upload_id: 'upload-123',
      });
    });

    it('should throw UploadInitiateFailedException and delete the draft video when storage fails', async () => {
      channelRepo.findOne.mockResolvedValue(mockChannel);
      videoRepo.create.mockReturnValue(mockVideo);
      videoRepo.save.mockResolvedValue(mockVideo);
      storageService.createMultipartUpload.mockRejectedValue(
        new Error('S3 unavailable'),
      );
      videoRepo.delete.mockResolvedValue({});

      await expect(service.initiateUpload(mockDto, 'user-1')).rejects.toThrow(
        UploadInitiateFailedException,
      );
      expect(videoRepo.delete).toHaveBeenCalledWith(mockVideo.id);
    });
  });

  describe('completeUpload', () => {
    const completeDto: UploadCompleteDto = {
      videoId: 'vid-uuid',
      uploadId: 'upload-123',
      parts: [
        { partNumber: 1, eTag: '"etag-1"' },
        { partNumber: 2, eTag: '"etag-2"' },
      ],
    };

    it('should throw VideoNotFoundException when video is not found', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(
        service.completeUpload(completeDto, 'user-1'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw VideoNotFoundException when video belongs to a different user', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...mockVideoWithChannel,
        channel: { user_id: 'other-user' },
      });

      await expect(
        service.completeUpload(completeDto, 'user-1'),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw UploadPartCountMismatchException when parts.length !== part_count', async () => {
      videoRepo.findOne.mockResolvedValue({
        ...mockVideoWithChannel,
        part_count: 3,
      });

      await expect(
        service.completeUpload(completeDto, 'user-1'),
      ).rejects.toThrow(UploadPartCountMismatchException);
    });

    it('should throw UploadCompleteFailedException when storage fails', async () => {
      videoRepo.findOne.mockResolvedValue(mockVideoWithChannel);
      storageService.completeMultipartUpload.mockRejectedValue(
        new Error('S3 error'),
      );

      await expect(
        service.completeUpload(completeDto, 'user-1'),
      ).rejects.toThrow(UploadCompleteFailedException);
    });

    it('should update status to processing, clear upload_id, enqueue job and return result', async () => {
      videoRepo.findOne.mockResolvedValue(mockVideoWithChannel);
      storageService.completeMultipartUpload.mockResolvedValue(undefined);
      videoRepo.update.mockResolvedValue({});
      videoQueue.add.mockResolvedValue({});

      const result = await service.completeUpload(completeDto, 'user-1');

      expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
        mockVideoWithChannel.storage_key,
        completeDto.uploadId,
        completeDto.parts,
      );
      expect(videoRepo.update).toHaveBeenCalledWith(mockVideoWithChannel.id, {
        status: VideoStatus.PROCESSING,
        upload_id: null,
      });
      expect(videoQueue.add).toHaveBeenCalledWith(
        'process-video',
        {
          videoId: mockVideoWithChannel.id,
          storageKey: mockVideoWithChannel.storage_key,
        },
        {
          jobId: mockVideoWithChannel.id,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
        },
      );
      expect(result).toEqual({
        videoId: mockVideoWithChannel.id,
        publicId: mockVideoWithChannel.public_id,
        status: VideoStatus.PROCESSING,
      });
    });
  });

  describe('getStreamUrl', () => {
    const readyVideo = {
      id: 'vid-ready',
      public_id: 'READYPUBLIC12',
      status: VideoStatus.READY,
      storage_key: 'videos/key/video.mp4',
    } as Video;

    it('should return url and expiresAt for a ready video', async () => {
      videoRepo.findOne.mockResolvedValue(readyVideo);
      storageService.getPresignedGetUrl.mockResolvedValue(
        'https://storage/signed?X-Amz-Expires=14400',
      );

      const result = await service.getStreamUrl('READYPUBLIC12');

      expect(storageService.getPresignedGetUrl).toHaveBeenCalledWith(
        readyVideo.storage_key,
        14400,
      );
      expect(result.url).toContain('X-Amz-Expires=14400');
      expect(result.expiresAt).toBeDefined();
    });

    it('should throw VideoNotFoundException when video does not exist', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(service.getStreamUrl('NONEXISTENT12')).rejects.toThrow(
        VideoNotFoundException,
      );
    });

    it('should throw VideoNotFoundException when video status is draft', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(service.getStreamUrl('DRAFTPUBLIC12')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });

  describe('getDownloadUrl', () => {
    const readyVideo = {
      id: 'vid-ready',
      public_id: 'READYPUBLIC12',
      status: VideoStatus.READY,
      storage_key: 'videos/key/video.mp4',
    } as Video;

    it('should return url with attachment disposition and expiresAt for a ready video', async () => {
      videoRepo.findOne.mockResolvedValue(readyVideo);
      storageService.getPresignedGetUrl.mockResolvedValue(
        'https://storage/signed?X-Amz-Expires=3600&response-content-disposition=attachment',
      );

      const result = await service.getDownloadUrl('READYPUBLIC12');

      expect(storageService.getPresignedGetUrl).toHaveBeenCalledWith(
        readyVideo.storage_key,
        3600,
        'attachment; filename="video.mp4"',
      );
      expect(result.url).toContain('X-Amz-Expires=3600');
      expect(result.expiresAt).toBeDefined();
    });

    it('should throw VideoNotFoundException when video does not exist', async () => {
      videoRepo.findOne.mockResolvedValue(null);

      await expect(service.getDownloadUrl('NONEXISTENT12')).rejects.toThrow(
        VideoNotFoundException,
      );
    });
  });
});
