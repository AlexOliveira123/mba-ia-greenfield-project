import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { VIDEO_PROCESSING_QUEUE } from './constants';

describe('QueueModule', () => {
  it('should compile and resolve @InjectQueue(VIDEO_PROCESSING_QUEUE)', async () => {
    const mockQueue = { add: jest.fn(), getJobs: jest.fn() };

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    })
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue(mockQueue)
      .compile();

    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const queue = module.get(getQueueToken(VIDEO_PROCESSING_QUEUE));
    expect(queue).toBe(mockQueue);

    await module.close();
  });
});
