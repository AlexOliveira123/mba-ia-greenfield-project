import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { Readable } from 'node:stream';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import storageConfig from '../config/storage.config';
import {
  STORAGE_CLIENT_INTERNAL,
  STORAGE_CLIENT_PUBLIC,
} from './storage.constants';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;

  constructor(
    @Inject(STORAGE_CLIENT_INTERNAL) private readonly s3: S3Client,
    @Inject(STORAGE_CLIENT_PUBLIC) private readonly s3Public: S3Client,
    @Inject(storageConfig.KEY)
    cfg: ConfigType<typeof storageConfig>,
  ) {
    this.bucket = cfg.bucket;
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBucket();
  }

  async ensureBucket(): Promise<void> {
    const deadline = Date.now() + 30_000;
    let delay = 500;

    for (;;) {
      try {
        await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
        return;
      } catch (err) {
        const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })
          ?.$metadata?.httpStatusCode;
        const name = (err as { name?: string }).name ?? '';

        if (
          httpStatus === 404 ||
          name === 'NoSuchBucket' ||
          name === 'NotFound'
        ) {
          try {
            await this.s3.send(
              new CreateBucketCommand({ Bucket: this.bucket }),
            );
            this.logger.log(`Bucket "${this.bucket}" created`);
            return;
          } catch (createErr) {
            const createName = (createErr as { name?: string }).name ?? '';
            if (
              createName === 'BucketAlreadyOwnedByYou' ||
              createName === 'BucketAlreadyExists'
            ) {
              return;
            }
          }
        }

        if (Date.now() >= deadline) throw err;
        this.logger.warn(
          `Waiting for bucket "${this.bucket}" (retry in ${delay}ms)…`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
        delay = Math.min(delay * 2, 8_000);
      }
    }
  }

  async createMultipartUpload(key: string): Promise<{ uploadId: string }> {
    const { UploadId } = await this.s3.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key }),
    );
    return { uploadId: UploadId! };
  }

  async getPresignedPartUrls(
    key: string,
    uploadId: string,
    partCount: number,
  ): Promise<Array<{ partNumber: number; presignedUrl: string }>> {
    const parts: Array<{ partNumber: number; presignedUrl: string }> = [];
    for (let partNumber = 1; partNumber <= partCount; partNumber++) {
      const presignedUrl = await getSignedUrl(
        this.s3Public,
        new UploadPartCommand({
          Bucket: this.bucket,
          Key: key,
          UploadId: uploadId,
          PartNumber: partNumber,
        }),
        { expiresIn: 3600 },
      );
      parts.push({ partNumber, presignedUrl });
    }
    return parts;
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: Array<{ partNumber: number; eTag: string }>,
  ): Promise<void> {
    await this.s3.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({ PartNumber: p.partNumber, ETag: p.eTag })),
        },
      }),
    );
  }

  async getPresignedGetUrl(
    key: string,
    ttlSeconds: number,
    disposition?: string,
  ): Promise<string> {
    return getSignedUrl(
      this.s3Public,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(disposition ? { ResponseContentDisposition: disposition } : {}),
      }),
      { expiresIn: ttlSeconds },
    );
  }

  async deleteObject(key: string): Promise<void> {
    await this.s3.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key }),
    );
  }

  async downloadToFile(key: string, destPath: string): Promise<void> {
    const { Body } = await this.s3.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    await pipeline(Body as Readable, createWriteStream(destPath));
  }

  async uploadFile(
    key: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }
}
