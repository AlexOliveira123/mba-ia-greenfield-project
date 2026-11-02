import { NestFactory } from '@nestjs/core';
import { VideoWorkerModule } from './video-worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(VideoWorkerModule);
  app.enableShutdownHooks();
}

void bootstrap().catch((err: unknown) => {
  console.error('[worker-main] Bootstrap failed', err);
  process.exit(1);
});
