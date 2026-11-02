import { Inject, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import type { ConfigType } from '@nestjs/config';
import type { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { nanoid } from 'nanoid';
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

export interface InitiateUploadResult {
  videoId: string;
  publicId: string;
  uploadId: string;
  parts: Array<{ partNumber: number; presignedUrl: string }>;
}

export interface CompleteUploadResult {
  videoId: string;
  publicId: string;
  status: string;
}

export interface PresignedUrlResult {
  url: string;
  expiresAt: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    @InjectRepository(Channel)
    private readonly channelRepository: Repository<Channel>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue,
    @Inject(queueConfig.KEY)
    private readonly queueCfg: ConfigType<typeof queueConfig>,
  ) {}

  async initiateUpload(
    dto: UploadInitiateDto,
    userId: string,
  ): Promise<InitiateUploadResult> {
    const channel = await this.channelRepository.findOne({
      where: { id: dto.channelId, user_id: userId },
    });
    if (!channel) throw new UploadOwnershipException();

    const storageKey = `videos/${nanoid(16)}/${dto.fileName}`;
    const video = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: dto.channelId,
        storage_key: storageKey,
        part_count: dto.partCount,
      }),
    );

    let uploadId: string;
    try {
      ({ uploadId } =
        await this.storageService.createMultipartUpload(storageKey));
    } catch {
      await this.videoRepository.delete(video.id);
      throw new UploadInitiateFailedException();
    }

    const parts = await this.storageService.getPresignedPartUrls(
      storageKey,
      uploadId,
      dto.partCount,
    );

    await this.videoRepository.update(video.id, { upload_id: uploadId });

    return { videoId: video.id, publicId: video.public_id, uploadId, parts };
  }

  async completeUpload(
    dto: UploadCompleteDto,
    userId: string,
  ): Promise<CompleteUploadResult> {
    const video = await this.videoRepository.findOne({
      where: { id: dto.videoId },
      relations: ['channel'],
    });

    if (!video || video.channel.user_id !== userId) {
      throw new VideoNotFoundException();
    }

    if (video.part_count !== dto.parts.length) {
      throw new UploadPartCountMismatchException();
    }

    try {
      await this.storageService.completeMultipartUpload(
        video.storage_key!,
        dto.uploadId,
        dto.parts,
      );
    } catch {
      throw new UploadCompleteFailedException();
    }

    await this.videoRepository.update(video.id, {
      status: VideoStatus.PROCESSING,
      upload_id: null,
    });

    await this.videoQueue.add(
      'process-video',
      {
        videoId: video.id,
        storageKey: video.storage_key,
      },
      {
        jobId: video.id,
        attempts: this.queueCfg.jobAttempts,
        backoff: { type: 'exponential', delay: this.queueCfg.jobBackoffMs },
      },
    );

    return {
      videoId: video.id,
      publicId: video.public_id,
      status: VideoStatus.PROCESSING,
    };
  }

  async getStreamUrl(publicId: string): Promise<PresignedUrlResult> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
    });

    if (!video) throw new VideoNotFoundException();

    const ttlSeconds = 14400;
    const url = await this.storageService.getPresignedGetUrl(
      video.storage_key!,
      ttlSeconds,
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return { url, expiresAt };
  }

  async getDownloadUrl(publicId: string): Promise<PresignedUrlResult> {
    const video = await this.videoRepository.findOne({
      where: { public_id: publicId, status: VideoStatus.READY },
    });

    if (!video) throw new VideoNotFoundException();

    const ttlSeconds = 3600;
    const fileName = video.storage_key!.split('/').pop() ?? publicId;
    const disposition = `attachment; filename="${fileName}"`;
    const url = await this.storageService.getPresignedGetUrl(
      video.storage_key!,
      ttlSeconds,
      disposition,
    );
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

    return { url, expiresAt };
  }
}
