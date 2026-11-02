import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import queueConfig from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.redisHost,
          port: cfg.redisPort,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
