import { readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');
import type { FfprobeData } from 'fluent-ffmpeg';
import { nanoid } from 'nanoid';
import { Repository } from 'typeorm';
import { VIDEO_PROCESSING_QUEUE } from '../queue/constants';
import { StorageService } from '../storage/storage.service';
import { Video, VideoMetadata, VideoStatus } from '../videos/video.entity';

interface ProcessVideoJobData {
  videoId: string;
  storageKey: string;
}

@Processor(VIDEO_PROCESSING_QUEUE)
@Injectable()
export class VideoWorkerProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoWorkerProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<ProcessVideoJobData>): Promise<void> {
    const { videoId, storageKey } = job.data;
    const tmpInput = join(tmpdir(), `video-${nanoid(8)}.tmp`);
    const tmpThumb = join(tmpdir(), `thumb-${nanoid(8)}.jpg`);

    try {
      await this.storageService.downloadToFile(storageKey, tmpInput);

      const probeData = await this.probe(tmpInput);
      const duration = this.parseDuration(probeData);
      const metadata = this.parseMetadata(probeData);

      await this.generateThumbnail(tmpInput, tmpThumb);

      const thumbKey = `thumbnails/${videoId}/thumbnail.jpg`;
      const thumbBuffer = await readFile(tmpThumb);
      await this.storageService.uploadFile(thumbKey, thumbBuffer, 'image/jpeg');

      await this.videoRepository.update(videoId, {
        status: VideoStatus.READY,
        duration,
        thumbnail_key: thumbKey,
        metadata,
      });
    } catch (err) {
      const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);

      if (isFinalAttempt) {
        const reason = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Video ${videoId} failed permanently after ${job.attemptsMade + 1} attempts: ${reason}`,
        );
        await this.videoRepository.update(videoId, {
          status: VideoStatus.FAILED,
          failure_reason: reason,
        });
      } else {
        this.logger.warn(
          `Video ${videoId} attempt ${job.attemptsMade + 1} failed, will retry`,
        );
      }

      throw err;
    } finally {
      await rm(tmpInput, { force: true });
      await rm(tmpThumb, { force: true });
    }
  }

  protected probe(inputPath: string): Promise<FfprobeData> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(inputPath, (err, data) => {
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
        if (err) return reject(err);
        resolve(data);
      });
    });
  }

  protected parseDuration(data: FfprobeData): number {
    return Math.round(data.format.duration ?? 0);
  }

  protected parseMetadata(data: FfprobeData): VideoMetadata {
    const videoStream = data.streams.find((s) => s.codec_type === 'video');
    const audioStream = data.streams.find((s) => s.codec_type === 'audio');

    const fpsRaw = videoStream?.r_frame_rate ?? '0/1';
    const [num, den] = fpsRaw.split('/').map(Number);
    const fps = den && den !== 0 ? Math.round((num / den) * 100) / 100 : 0;

    return {
      width: videoStream?.width ?? 0,
      height: videoStream?.height ?? 0,
      videoCodec: videoStream?.codec_name ?? '',
      audioCodec: audioStream?.codec_name ?? '',
      bitrateKbps: Math.round((data.format.bit_rate ?? 0) / 1000),
      fps,
      format: data.format.format_name ?? '',
      sizeBytes: data.format.size ?? 0,
    };
  }

  protected async generateThumbnail(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const dir = outputPath.substring(0, outputPath.lastIndexOf('/'));
      const filename = outputPath.substring(outputPath.lastIndexOf('/') + 1);
      ffmpeg(inputPath)
        .screenshots({ count: 1, timemarks: ['5%'], filename, folder: dir })
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err));
    });
  }
}
