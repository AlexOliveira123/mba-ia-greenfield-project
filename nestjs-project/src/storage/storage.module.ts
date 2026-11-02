import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import storageConfig from '../config/storage.config';
import {
  STORAGE_CLIENT_INTERNAL,
  STORAGE_CLIENT_PUBLIC,
} from './storage.constants';
import { StorageService } from './storage.service';

@Module({
  providers: [
    {
      provide: STORAGE_CLIENT_INTERNAL,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        new S3Client({
          endpoint: cfg.endpoint,
          region: cfg.region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
          },
        }),
    },
    {
      provide: STORAGE_CLIENT_PUBLIC,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        new S3Client({
          endpoint: cfg.publicEndpoint,
          region: cfg.region,
          forcePathStyle: true,
          credentials: {
            accessKeyId: cfg.accessKeyId,
            secretAccessKey: cfg.secretAccessKey,
          },
        }),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
