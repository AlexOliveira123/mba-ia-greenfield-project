/* eslint-disable @typescript-eslint/no-require-imports */
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Job } from 'bullmq';
import type { Repository } from 'typeorm';
import { StorageService } from '../storage/storage.service';
import { Video, VideoStatus } from '../videos/video.entity';
import { VideoWorkerProcessor } from './video-worker.processor';

const fsPromises =
  require('node:fs/promises') as typeof import('node:fs/promises');

const probeData = {
  format: {
    duration: 10,
    bit_rate: 5000000,
    format_name: 'mov,mp4',
    size: 6250000,
  },
  streams: [
    {
      codec_type: 'video',
      codec_name: 'h264',
      width: 1920,
      height: 1080,
      r_frame_rate: '30/1',
    },
    { codec_type: 'audio', codec_name: 'aac' },
  ],
};

function makeJob(
  videoId: string,
  attemptsMade: number,
  attempts: number,
): Job<{ videoId: string; storageKey: string }> {
  return {
    data: { videoId, storageKey: 'videos/test/video.mp4' },
    attemptsMade,
    opts: { attempts },
  } as unknown as Job<{ videoId: string; storageKey: string }>;
}

describe('VideoWorkerProcessor', () => {
  let processor: VideoWorkerProcessor;
  let videoRepo: jest.Mocked<Pick<Repository<Video>, 'update'>>;
  let storageService: { downloadToFile: jest.Mock; uploadFile: jest.Mock };

  beforeEach(async () => {
    videoRepo = { update: jest.fn().mockResolvedValue({}) };
    storageService = {
      downloadToFile: jest.fn().mockResolvedValue(undefined),
      uploadFile: jest.fn().mockResolvedValue(undefined),
    };

    const module = await Test.createTestingModule({
      providers: [
        VideoWorkerProcessor,
        { provide: getRepositoryToken(Video), useValue: videoRepo },
        { provide: StorageService, useValue: storageService },
      ],
    }).compile();

    processor = module.get(VideoWorkerProcessor);

    jest.spyOn(processor as any, 'probe').mockResolvedValue(probeData);
    jest
      .spyOn(processor as any, 'generateThumbnail')
      .mockResolvedValue(undefined);
    jest.spyOn(fsPromises, 'rm').mockResolvedValue(undefined as never);
  });

  afterEach(() => jest.restoreAllMocks());

  describe('happy path', () => {
    it('should update Video to ready with duration, thumbnail_key, and metadata', async () => {
      jest
        .spyOn(fsPromises, 'readFile')
        .mockResolvedValue(Buffer.from('thumb') as never);

      const job = makeJob('video-1', 0, 3);
      await processor.process(job);

      expect(videoRepo.update).toHaveBeenCalledWith('video-1', {
        status: VideoStatus.READY,
        duration: 10,
        thumbnail_key: 'thumbnails/video-1/thumbnail.jpg',
        metadata: {
          width: 1920,
          height: 1080,
          videoCodec: 'h264',
          audioCodec: 'aac',
          bitrateKbps: 5000,
          fps: 30,
          format: 'mov,mp4',
          sizeBytes: 6250000,
        },
      });
    });
  });

  describe('retry semantics', () => {
    it('should rethrow without setting failed on an intermediate attempt', async () => {
      const processingError = new Error('FFmpeg crashed');
      jest.spyOn(processor as any, 'probe').mockRejectedValue(processingError);

      const job = makeJob('video-2', 0, 3); // attempt 1 of 3 — not final
      await expect(processor.process(job)).rejects.toThrow('FFmpeg crashed');

      expect(videoRepo.update).not.toHaveBeenCalledWith(
        'video-2',
        expect.objectContaining({ status: VideoStatus.FAILED }),
      );
    });

    it('should set failed + failure_reason and rethrow on the final attempt', async () => {
      const processingError = new Error('FFmpeg binary not found');
      jest.spyOn(processor as any, 'probe').mockRejectedValue(processingError);

      const job = makeJob('video-3', 2, 3); // attempt 3 of 3 — final
      await expect(processor.process(job)).rejects.toThrow(
        'FFmpeg binary not found',
      );

      expect(videoRepo.update).toHaveBeenCalledWith('video-3', {
        status: VideoStatus.FAILED,
        failure_reason: 'FFmpeg binary not found',
      });
    });
  });
});
