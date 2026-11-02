---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-31T20:01:43+00:00"
    source: training-data
  "@aws-sdk/s3-request-presigner":
    version: "^3.1161.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-10-31T20:01:43+00:00"
    source: training-data
  "@nestjs/bullmq":
    version: "^12.x"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-10-31T20:01:43+00:00"
    source: training-data
  bullmq:
    version: "^6.x"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-10-31T20:01:43+00:00"
    source: training-data
  nanoid:
    version: "^5.1.16"
    context7_id: "/ai/nanoid"
    fetched_at: "2026-10-31T20:01:43+00:00"
    source: training-data
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T11:38:03-03:00"
note: "Context7 was unavailable at resolve time. Docs written from training data. Re-fetch with Context7 at /plan-build time if IDs above resolve correctly."
---

# phase-03-videos — Library References

Distilled docs for libraries decided in this slice. Context7 was unavailable at `/plan-resolve` time; content is from model training data (knowledge cutoff: August 2025). Re-fetch via Context7 at `/plan-build` time to update.

---

## @aws-sdk/client-s3

**Source:** `/aws/aws-sdk-js-v3` (Context7) — AWS SDK v3 S3 client. Maps to `phase-03-videos/TD-01` Decision A (MinIO with S3-compatible API).

AWS SDK v3 uses modular clients. For MinIO in dev, set `endpoint` to the Docker Compose service URL and `forcePathStyle: true`.

### NestJS module setup (dual S3Client — per TD-01 Revision 2026-11-02)

Two providers: `STORAGE_CLIENT_INTERNAL` for all server-side S3 commands; `STORAGE_CLIENT_PUBLIC` exclusively for `getSignedUrl` so presigned URLs are signed against a host reachable outside the Compose network.

```typescript
// src/storage/storage.module.ts
import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { ConfigType } from '@nestjs/config';
import { storageConfig } from '../config/storage.config';
import { StorageService } from './storage.service';

export const STORAGE_CLIENT_INTERNAL = 'STORAGE_CLIENT_INTERNAL';
export const STORAGE_CLIENT_PUBLIC = 'STORAGE_CLIENT_PUBLIC';

const makeClient = (endpoint: string, cfg: ConfigType<typeof storageConfig>) =>
  new S3Client({
    endpoint,
    region: cfg.region,           // e.g. 'us-east-1' (required even for MinIO)
    forcePathStyle: true,         // required for MinIO path-style URLs
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

@Module({
  providers: [
    {
      provide: STORAGE_CLIENT_INTERNAL,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        makeClient(cfg.endpoint, cfg),
    },
    {
      provide: STORAGE_CLIENT_PUBLIC,
      inject: [storageConfig.KEY],
      useFactory: (cfg: ConfigType<typeof storageConfig>) =>
        makeClient(cfg.publicEndpoint ?? cfg.endpoint, cfg),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule {}
```

### Key commands for Phase 03

```typescript
import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';

// Create multipart upload (returns uploadId)
const { UploadId } = await s3.send(
  new CreateMultipartUploadCommand({ Bucket: bucket, Key: key }),
);

// Complete multipart upload
await s3.send(
  new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId,
    MultipartUpload: {
      Parts: [{ PartNumber: 1, ETag: '...' }, ...],
    },
  }),
);

// Abort (on error / cancel)
await s3.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId }));

// Head (get metadata: ContentLength, ContentType, etc.)
const { ContentLength, ContentType } = await s3.send(
  new HeadObjectCommand({ Bucket: bucket, Key: key }),
);

// Delete object
await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

// Simple PUT (for small files like thumbnails < 5MB)
await s3.send(
  new PutObjectCommand({ Bucket: bucket, Key: key, Body: buffer, ContentType: 'image/jpeg' }),
);
```

---

## @aws-sdk/s3-request-presigner

**Source:** `/aws/aws-sdk-js-v3` (Context7) — Presigned URL generator for S3 commands. Used for TD-02 (multipart part presigned PUTs) and TD-05 (presigned GET for streaming/download).

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client, UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Presign a part upload (PUT) — TTL: 1 hour per part
const presignedPartUrl = await getSignedUrl(
  s3,
  new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: partNumber,
  }),
  { expiresIn: 3600 },           // seconds
);

// Presign a GET for streaming (TTL: 4 hours — covers a full playback session)
const streamUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({ Bucket: bucket, Key: key }),
  { expiresIn: 4 * 60 * 60 },
);

// Presign a GET with Content-Disposition: attachment for forced download
const downloadUrl = await getSignedUrl(
  s3,
  new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`,
  }),
  { expiresIn: 3600 },
);
```

### Multipart upload flow (TD-02 Option B — 3-call orchestration)

```
Client                        NestJS (BFF → API)               MinIO
  │                               │                               │
  │─POST /api/videos/upload/initiate──▶                           │
  │                               │──CreateMultipartUpload──────▶│
  │                               │◀──{ UploadId }───────────────│
  │                               │──getSignedUrl(UploadPart×N)──│ (local, no network)
  │◀──{ videoId, uploadId, parts[{ partNumber, presignedUrl }] }──│
  │                               │                               │
  │───PUT presignedUrl (part 1)──────────────────────────────────▶│
  │◀──ETag──────────────────────────────────────────────────────── │
  │  ... repeat for all parts ...                                  │
  │                               │                               │
  │─POST /api/videos/upload/complete──▶                           │
  │                               │──CompleteMultipartUpload────▶ │
  │                               │──enqueue processing job       │
  │◀──{ videoId, status: 'processing' }──────────────────────────│
```

**Part size:** AWS/MinIO minimum part is 5MB (last part can be smaller). Recommended: 50MB per part for a 10GB file (200 parts).

**CORS:** MinIO must have a CORS rule allowing `PUT` from the browser origin. Implemented via `MINIO_API_CORS_ALLOW_ORIGIN=*` env var in `compose.yaml`. Verified working on the Chainguard image — see `src/storage/storage.service.integration-spec.ts`.

---

## @nestjs/bullmq

**Source:** `/nestjs/bull` (Context7) — Official NestJS BullMQ module. Maps to `phase-03-videos/TD-03` Decision A.

### Module registration

```typescript
// app.module.ts (or a dedicated QueueModule)
import { BullModule } from '@nestjs/bullmq';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.redisHost,   // e.g. 'redis' (Docker Compose service name)
          port: cfg.redisPort,   // e.g. 6379
        },
      }),
    }),
    BullModule.registerQueue({
      name: 'video-processing',   // queue name constant
    }),
  ],
})
export class QueueModule {}
```

### Producing a job

```typescript
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Injectable } from '@nestjs/common';

@Injectable()
export class VideosService {
  constructor(
    @InjectQueue('video-processing') private readonly videoQueue: Queue,
  ) {}

  async enqueueProcessing(videoId: string, storagePath: string) {
    await this.videoQueue.add(
      'process-video',                // job name
      { videoId, storagePath },       // payload — keep small (IDs/paths, not binary)
      {
        attempts: 3,                  // retry up to 3 times
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,          // keep failed jobs for inspection
      },
    );
  }
}
```

### Consuming a job (in worker-main.ts context, TD-04)

```typescript
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing')
export class VideoWorkerProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string; storagePath: string }>): Promise<void> {
    const { videoId, storagePath } = job.data;
    // 1. Download from MinIO (or operate directly on storagePath)
    // 2. Run FFmpeg
    // 3. Upload thumbnail
    // 4. Update Video entity (status → 'ready', duration, etc.)
  }
}
```

### @OnWorkerEvent decorators

```typescript
import { OnWorkerEvent } from '@nestjs/bullmq';
import { Job, UnrecoverableError } from 'bullmq';

@Processor('video-processing')
export class VideoWorkerProcessor extends WorkerHost {
  async process(job: Job): Promise<void> { /* ... */ }

  @OnWorkerEvent('completed')
  onCompleted(job: Job) { /* log */ }

  @OnWorkerEvent('failed')
  onFailed(job: Job, err: Error) {
    if (job.attemptsMade >= (job.opts.attempts ?? 1)) {
      // Mark video as failed in DB
    }
  }
}

// Throw UnrecoverableError to skip retries immediately
throw new UnrecoverableError('FFmpeg binary not found');
```

---

## bullmq

**Source:** `/taskforcesh/bullmq` (Context7) — BullMQ core (Redis-backed queue). Peer dependency of `@nestjs/bullmq`.

### Job lifecycle states

```
waiting → active → completed
               └→ failed (retries remaining → waiting-children)
                         (no retries → failed)
```

### Key types

```typescript
import type { Job, Queue, Worker, JobsOptions } from 'bullmq';

// JobsOptions (subset relevant to Phase 03)
interface JobsOptions {
  attempts?: number;           // default: 1
  backoff?: { type: 'exponential' | 'fixed'; delay: number };
  delay?: number;              // ms to wait before first attempt
  priority?: number;           // lower number = higher priority
  removeOnComplete?: boolean | number;  // true or keep last N
  removeOnFail?: boolean | number;
}
```

### Worker concurrency (for worker-main.ts)

`@nestjs/bullmq`'s `@Processor` decorator accepts a concurrency option. For CPU-bound FFmpeg jobs, set concurrency to 1 (default) or 2 to avoid thrashing:

```typescript
@Processor('video-processing', { concurrency: 1 })
export class VideoWorkerProcessor extends WorkerHost { ... }
```

---

## nanoid

**Source:** `/ai/nanoid` (Context7) — Tiny, secure, URL-safe unique string ID generator. Maps to `phase-03-videos/TD-06` Decision B.

### Import (ESM / CommonJS)

`nanoid` v5+ is ESM-only. For NestJS projects compiled with CommonJS output, use the async `nanoid` or the CJS-compatible `nanoid/non-secure` (not recommended for production IDs). The preferred approach for NestJS is to use `@nestjs/config`'s `tsconfig` with `"module": "commonjs"` — `nanoid` v5 can be imported via dynamic import or by pinning to v4 (which ships CJS).

```typescript
// Option 1: nanoid v4 (CJS-compatible, still supported)
import { nanoid } from 'nanoid';

const publicId = nanoid(12);   // e.g. "V1StGXR8_Z5j"
```

```typescript
// Option 2: nanoid v5 with dynamic import wrapper (for CJS)
// src/common/nanoid.ts
export async function generatePublicId(size = 12): Promise<string> {
  const { nanoid } = await import('nanoid');
  return nanoid(size);
}
```

### URL-safe alphabet

Default alphabet: `A-Za-z0-9_-` (64 characters). At 12 characters: 64^12 ≈ 7.2×10²¹ combinations. For a uniqueness guarantee, NestJS should add a `UNIQUE` index on the `public_id` column and handle the rare `UniqueViolationError` with a retry (generate a new ID and re-insert).

### TypeORM entity integration

```typescript
// src/videos/video.entity.ts
import { Entity, Column, PrimaryGeneratedColumn, BeforeInsert, Index } from 'typeorm';
import { nanoid } from 'nanoid';  // v4 CJS

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;                    // internal PK, never exposed in public URLs

  @Index({ unique: true })
  @Column({ name: 'public_id', type: 'varchar', length: 12 })
  publicId: string;

  @BeforeInsert()
  generatePublicId() {
    this.publicId = nanoid(12);
  }

  // ... other columns
}
```

**Migration note:** the `public_id` column must have `NOT NULL` and a `UNIQUE` index. TypeORM migration:

```typescript
await queryRunner.query(`
  ALTER TABLE "videos"
  ADD COLUMN "public_id" VARCHAR(12) NOT NULL,
  ADD CONSTRAINT "UQ_videos_public_id" UNIQUE ("public_id")
`);
```

---

## Docker Images (Chainguard — pinned by digest)

Added per `phase-03-videos/TD-01` Revision 2026-11-02. Official `minio/minio` and `minio/mc` Docker Hub images discontinued (pull access denied); upstream MinIO community edition archived.

### cgr.dev/chainguard/minio

**Full ref:** `cgr.dev/chainguard/minio@sha256:0a01100085e30fb08d2f39e39c9f5c9d83a95707f220b007d813b690cd41622d`

**Rationale:** Wolfi-based, distroless MinIO server. CVE-scanned, non-root by default. Pinned by digest for reproducibility.

**UID:** 65532 (non-root). Named volume `minio-data` required — Compose sets volume ownership automatically for named volumes; bind mounts would need explicit `chown`.

**Ports:** 9000 (S3 API), 9001 (web console).

**No healthcheck** — image is fully distroless (no `wget`, `curl`, or shell in-image). Use `condition: service_started`; readiness is handled inside the app by `StorageService.ensureBucket()` / `onModuleInit` (retry loop with backoff).

**CORS:** `MINIO_API_CORS_ALLOW_ORIGIN=*` set as env var in `compose.yaml`. **Verified working (2026-11-02)** on the Chainguard image — despite open issues reporting no effect in some Docker configurations (minio/minio#11258, minio/minio#17409), the env var is effective here. MinIO `PutBucketCors` S3 API is NOT supported (minio#15874); env var is the only available mechanism. Gated by `src/storage/storage.service.integration-spec.ts`: OPTIONS preflight returns `Access-Control-Allow-Origin: *`; PUT exposes `ETag` in `Access-Control-Expose-Headers`.

**Note (dropped image):** `cgr.dev/chainguard/minio-client` was considered as an `mc`-based init container (TD-01 Revision 1) but host inspection confirmed it lacks the `mc cors` subcommand. Dropped (TD-01 Revision 2, amended). Bucket bootstrap moved to `StorageService.ensureBucket()`.
