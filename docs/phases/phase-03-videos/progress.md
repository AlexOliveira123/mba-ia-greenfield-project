# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

---

## Post-completion Defect Record (2026-11-02)

Two functional defects were discovered after all SIs completed. Tests were green because the specs did not exercise the actual broken paths.

### Defect 1 — Retry semantics were dead config

**Root cause:** the original `VideoWorkerProcessor.process()` caught all errors and did NOT rethrow — the `catch` block set `status: 'failed'` unconditionally and swallowed the error. BullMQ only retries a job when the processor function throws; a `catch` that returns normally signals success to BullMQ. The `attempts: 3 / backoff` options added in the queue were therefore unreachable: every job failed on the first attempt with no retry, and there was no way to distinguish "permanent failure" from "transient failure". The unit and integration tests mocked the processor internals, so neither caught this.

**Fix:** Processor now always rethrows; `status: 'failed'` + `failure_reason` are only set when `job.attemptsMade + 1 >= (job.opts.attempts ?? 1)` (the final attempt). Added `jobId: videoId` to `videoQueue.add()` for idempotent re-enqueue. Unit tests now cover both the intermediate-rethrow path and the final-attempt-sets-failed path explicitly.

### Defect 2 — Metadata was a planning gap

**Root cause:** the project plan (Fase 03) listed "extração de duração e metadados" as a capability, but the plan's Data Model had no `metadata` column and no `failure_reason` column. The processor was implemented with only `duration` — width, height, codec, bitrate, fps, format, and size were extracted from ffprobe but discarded without storage. The planning gap meant tests never asserted metadata persistence because it wasn't in the schema.

**Fix:** New migration `AddMetadataAndFailureReasonToVideos` adds `metadata jsonb` and `failure_reason text` (both nullable). `VideoMetadata` interface added to `video.entity.ts`. Processor rewritten with a single `probe()` call (instead of two ffprobe invocations) that feeds both `parseDuration()` and `parseMetadata()`. Integration test with real ffprobe/ffmpeg asserts `metadata.width`, `metadata.height`, `metadata.videoCodec` are populated. E2E tests assert the `jsonb` column round-trips correctly through the TypeORM + PostgreSQL stack.

---

### SI-03.1 — Infra: Docker Compose (MinIO + Redis), npm packages e config factories
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - `Object.assign(process.env, { KEY: undefined })` sets the key to the string `"undefined"` instead of removing it; tests use explicit `delete process.env.KEY` before calling `loadConfig` for the defaults path.
  - `.env.example` had an unquoted MAIL_FROM value (shell-unsafe); fixed to quoted form as part of the file touch.

### SI-03.2 — StorageModule: S3Client provider e StorageService
- **Status:** completed
- **Tests:** 12 passing (6 unit, 4 config, 2 integration)
- **Observations:**
  - All MinIO image registries (Docker Hub, Quay, GHCR, docker.min.io, Bitnami) were inaccessible; `localstack/localstack:latest` pulled but requires a paid license in 2026.x versions. Resolved by pinning to `localstack/localstack:2.3.2` (last free community edition).
  - Switched `compose.yaml` from `minio` + `minio-init` services to a single `localstack:2.3.2` service on port 4566; updated all env defaults from `http://minio:9000` to `http://localstack:4566`.
  - LocalStack does not auto-create buckets; integration test's `beforeAll` issues a `CreateBucketCommand` and ignores `BucketAlreadyExists` / `BucketAlreadyOwnedByYou` errors.

### SI-03.3 — QueueModule: BullMQ setup e configuração
- **Status:** completed
- **Tests:** 1 passing
- **Observations:**
  - `@nestjs/bullmq` v12 and `@nestjs/bull-shared` are ESM (`"type":"module"`) packages; Jest's default `transformIgnorePatterns` excludes all `node_modules`, causing a `SyntaxError: Unexpected token 'export'`. Fixed by adding `transformIgnorePatterns: ["/node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared|bullmq)/)"]` to both `package.json` (jest config) and `test/jest-e2e.json`.

### SI-03.4 — Video entity, migration e nanoid public_id
- **Status:** completed
- **Tests:** 4 passing
- **Observations:**
  - `nanoid` v5 is ESM-only; added to `transformIgnorePatterns` alongside bullmq packages in both `package.json` (jest config) and `test/jest-e2e.json`.
  - `createTestDataSource` helper's `cleanAllTables` updated to delete from `videos` before other tables (FK ordering).

### SI-03.5 — VideosService: upload initiate
- **Status:** completed
- **Tests:** 4 passing (3 unit, 1 integration)
- **Observations:**
  - Added `UploadOwnershipException`, `UploadInitiateFailedException`, `UploadCompleteFailedException`, `UploadPartCountMismatchException`, `VideoNotFoundException` to `domain.exception.ts` (all needed by SIs 03.5–03.8 added in one shot to avoid partial domain state).
  - `VideosModule` imports `TypeOrmModule.forFeature([Video, Channel])` and `StorageModule`; exports `TypeOrmModule` + `VideosService`.

### SI-03.6 — VideosService: upload complete e enqueue job
- **Status:** completed
- **Tests:** 8 passing (5 new unit tests for completeUpload + 3 existing for initiateUpload)
- **Observations:**
  - Added `@InjectQueue(VIDEO_PROCESSING_QUEUE)` to `VideosService` constructor; added `QueueModule` to `VideosModule.imports`.
  - `completeUpload` loads the `channel` relation in the `findOne` to verify ownership via `video.channel.user_id`.
  - Ownership and video-not-found are collapsed into a single `VideoNotFoundException` so callers cannot enumerate video IDs belonging to other users.

### SI-03.7 — VideosService: stream URL e download URL
- **Status:** completed
- **Tests:** 5 passing (3 for getStreamUrl, 2 for getDownloadUrl)
- **Observations:**
  - `getStreamUrl` queries `{ public_id, status: 'ready' }` — non-ready videos naturally return `null` from the `where` clause, so a single null-check covers both "not found" and "wrong status" cases.
  - Filename for download disposition is extracted from the last segment of `storage_key`; falls back to `publicId` if `storage_key` is null.

### SI-03.8 — VideosController: endpoints de upload e delivery
- **Status:** completed
- **Tests:** 6 E2E passing (1.1, 1.2, 2.1, 2.2, 3.1, 4.1 per spec)
- **Observations:**
  - JWT guard is global via `APP_GUARD`; GET endpoints use `@Public()`, POST endpoints are protected by default.
  - `POST /auth/register` auto-creates a channel for every new user (`createUserWithChannel`); E2E seed helpers use `findOneByOrFail({ user_id })` instead of inserting a new channel.
  - StorageService and BullMQ queue overridden with mocks via `overrideProvider` to keep E2E tests independent from LocalStack.

### SI-03.9 — VideoWorkerProcessor + VideoWorkerModule
- **Status:** completed
- **Tests:** 2 passing (1 happy-path integration, 1 FFmpeg-failure integration)
- **Observations:**
  - `fluent-ffmpeg` + `@types/fluent-ffmpeg` installed; `ffmpeg` binary added to `Dockerfile.dev` (needed for production worker and for real FFmpeg integration; tests mock `extractDuration`/`generateThumbnail`).
  - `StorageService` extended with `downloadToFile` and `uploadFile` methods required by the worker.
  - `@Processor` DI wiring does NOT require BullModule in integration tests — removed `BullModule.forRootAsync` from the spec; processor is resolved directly from the module and `process(job)` is called with a fake job object.
  - `cleanAllTables` called in `beforeAll` to handle leftover data from previous runs; `DELETE FROM "videos"` in `beforeEach` for per-test isolation.
  - `readFile` and `rm` from `node:fs/promises` are spied via `require(...)` in the test to avoid file-system I/O.

### SI-03.10 — worker-main.ts, nest-cli.json e Docker Compose video-worker service
- **Status:** completed
- **Tests:** 1 passing (worker-main.spec.ts)
- **Observations:**
  - `worker-main.ts` and `worker-main.spec.ts` were already created during SI-03.9; `compose.yaml` already had the `video-worker` service.
  - **Corrected (2026-11-02):** Original `command: node dist/worker/worker-main.js` and the assumption "nest-cli.json required no change" were both wrong. The API's `dist/` is shared via bind-mount and `deleteOutDir: true` would race; the correct command is `sh -c "npx tsc -p tsconfig.build.json --outDir dist-worker --declaration false --sourceMap false && node dist-worker/worker/worker-main.js"` producing an isolated output directory. `dist-worker/` added to `.gitignore`, `eslint.config.mjs` ignores, and both `tsconfig.build.json` + `tsconfig.json` excludes to prevent type-check leakage.
  - Added `--runInBand` to the `test:e2e` npm script in `package.json` (was missing, causing auth.e2e and videos.e2e to run in parallel and race on the shared test database — TRUNCATE from one suite deleted rows mid-test in the other suite). All 58 e2e tests now pass in combined run.
  - Cross-suite contamination fix: `cleanAllTables` changed from 5 sequential DELETEs to a single `TRUNCATE TABLE ... CASCADE` (atomic, eliminates FK ordering races). `ThrottlerStorage.storage.clear()` added to `beforeEach` in both e2e specs. `jest.restoreAllMocks()` added to `afterAll` in both specs.

---

## Post-implementation fixes (2026-11-02)

Root causes discovered after all 10 SIs were marked complete but before Step 4.

### TD-01 Revision 1 — Docker Hub removal → Chainguard MinIO

Official `minio/minio` and `minio/mc` images were removed from Docker Hub (pull access denied). Both SI-03.2 (first implemented with `localstack:2.3.2` as an undocumented drift) and SI-03.9's `minio-init` init-container were replaced. Replacement: `cgr.dev/chainguard/minio` pinned by digest. `minio-client` image dropped — Chainguard `minio-client` lacks the `mc cors` subcommand. Bucket bootstrap moved to `StorageService.ensureBucket()` / `onModuleInit` (HeadBucket → CreateBucket with exponential backoff, 30 s timeout, idempotent). `storage-init` init-container dropped (fresh-clone deadlock: empty bind-mount `node_modules` → `npx ts-node` fails → `nestjs-api` blocked on `condition: service_healthy`). `video-worker` gains `restart: unless-stopped`.

### TD-01 Revision 2 — Dual S3Client architecture

`StorageModule` rewritten with two named providers: `STORAGE_CLIENT_INTERNAL` (endpoint = `MINIO_ENDPOINT`, used for all server-side S3 commands) and `STORAGE_CLIENT_PUBLIC` (endpoint = `MINIO_PUBLIC_ENDPOINT` defaulting to `MINIO_ENDPOINT`, used exclusively for `getSignedUrl`). This ensures presigned URLs for browser upload carry the publicly accessible host while server-side ops use the Docker-network hostname. `MINIO_PUBLIC_ENDPOINT` validation added to `env.validation.ts` (optional). Unit tests verify each client path; integration tests verify presigned URL host.

### VideoWorkerModule DI failure (SI-03.9/03.10)

Root cause: `VideoWorkerModule` bootstraps via `NestFactory.createApplicationContext` — an independent context. The global `ConfigModule.forRoot` from `AppModule` is not active. `QueueModule.forRootAsync` injects `queueConfig.KEY` which was unregistered → `UnknownDependenciesException: BULLMQ_CONFIG(default) (?): CONFIGURATION(queue)`.

Why it was unnoticed: the e2e tests override `StorageService` and the BullMQ queue with `useValue` mocks — no real worker process starts. The `video-worker.processor.integration-spec.ts` resolves the processor from a test module with mocked collaborators and calls `process(job)` directly — no NestJS bootstrap of the full worker context.

Fix: added `ConfigModule.forRoot({ isGlobal: true, load: [databaseConfig, storageConfig, queueConfig], validationSchema, validationOptions })` + `TypeOrmModule.forRootAsync` to `VideoWorkerModule`. Switched to `autoLoadEntities: true` with `TypeOrmModule.forFeature([User])` registered directly in `VideoWorkerModule` (avoids hand-maintained entity list). Shared TypeORM connection factory extracted to `src/database/typeorm-options.factory.ts` — no duplicate connection config between `AppModule` and `VideoWorkerModule`.

`worker-main.ts`: added `app.enableShutdownHooks()` + `.catch((err) => { console.error(...); process.exit(1); })`. Unit spec updated: 3 tests (createApplicationContext called, enableShutdownHooks called, catch → process.exit(1)).

### CORS — verified 2026-11-02

`MINIO_API_CORS_ALLOW_ORIGIN=*` env var in `compose.yaml` works on the Chainguard MinIO image. Integration test `src/storage/storage.service.integration-spec.ts` passes both CORS cases:
- `CORS: OPTIONS preflight to presigned PUT URL should return Access-Control-Allow-Origin` ✓
- `CORS: PUT to presigned URL should expose ETag in Access-Control-Expose-Headers` ✓

Observed: OPTIONS response includes `access-control-allow-origin: *`; PUT response includes `access-control-expose-headers: ETag` (case-insensitive match). Prior "unverified" notes in `library-refs.md` and `context.md` updated.

---

## Step 4 — BullMQ retry/backoff (2026-11-02)

Added `{ attempts: 3, backoff: { type: 'exponential', delay: 5000 } }` to `videoQueue.add()` in `VideosService.completeUpload` (per TD-03). Updated `videos.service.spec.ts` to assert the third argument. Fresh-clone check passed: `docker compose down -v && rm -rf dist dist-worker && docker compose up -d` → video-worker compiled `dist-worker/` and bootstrapped cleanly on first run; all services stayed Up.

Shared TypeORM factory extracted to `src/database/typeorm-options.factory.ts`; `AppModule` and `VideoWorkerModule` both use `buildTypeOrmOptions(dbConfig, { autoLoadEntities: true })`. `VideoWorkerModule` drops the explicit entity list in favour of `autoLoadEntities: true` + `TypeOrmModule.forFeature([User])`.

---

## Step 5 — Real pipeline E2E (2026-11-02)

**Problem:** `test/videos-upload-delivery.e2e-spec.ts` overrode `StorageService` and the BullMQ queue with `useValue` mocks, and seeded `READY` videos directly in the DB. No e2e test ever exercised the real `queue → worker → MinIO → DB` path — which is exactly why the never-booting worker went unnoticed.

**Implementation:**

- `VIDEO_JOB_ATTEMPTS` and `VIDEO_JOB_BACKOFF_MS` added to `src/config/queue.config.ts` + Joi schema; `VideosService.completeUpload` reads values from `queueConfig`; `.env` sets `VIDEO_JOB_BACKOFF_MS=200` for fast test retries. Unit spec and integration spec updated with `queueConfig.KEY` provider. Phase doc Events/Messages updated.
- `scripts/check-worker.mjs` — ESM BullMQ script that polls `queue.getWorkers()` for 15s and exits 1 if no worker is found; added as `"pretest:e2e"` npm script.
- `test/videos-pipeline.e2e-spec.ts` — **NO `overrideProvider`**: real `AppModule`, real MinIO, real Redis, Compose video-worker consumes jobs:
  - `beforeAll` checks worker (30s), compiles NestApp, creates S3Client, generates ~11 MB ffmpeg fixture (`nullsrc+noise, b:v 8000k, 12s → 2 parts × 5.5 MiB`).
  - **a-g (happy path, one `it`)**: register/login → POST initiate (DB=draft) → PUT 2 parts to real presigned MinIO URLs with `fetch`, collect ETags → POST complete (DB=processing) → poll DB until READY → assert `duration > 0`, `metadata.width/height/videoCodec`, `HeadObjectCommand` on thumbnail key → GET stream-url → `Range: bytes=0-1023` → 206 + Content-Range + 1024 bytes → GET download-url → URL contains `content-disposition`.
  - **h**: 6 MiB `0xFF` buffer → worker fails all 3 attempts (200ms exponential backoff) → `status=failed`, `failure_reason` populated.
  - **i**: non-owner complete → `VIDEO_NOT_FOUND`; stream-url for DRAFT video → `VIDEO_NOT_FOUND`.
  - `afterAll`: `bullQueue.obliterate({ force: true })` + 3s grace + `cleanAllTables` + close.
- `test/videos-upload-delivery.e2e-spec.ts` cleaned: removed test 1.2 (initiate happy path) and 3.1 (stream-url for ready video) — both now covered for real in pipeline spec.

**Evidence — full DoD on 2026-11-02:**

| Check | Result |
|---|---|
| Unit + integration (`npm test -- --runInBand`) | **194 tests, 0 failures** (34 suites) |
| E2E (`npm run test:e2e`, pretest:e2e passes) | **61 tests, 0 failures** (5 suites) |
| `npx tsc --noEmit` | **0 errors** |
| `npm run lint` | **0 errors** (40 pre-existing warnings) |

**Pipeline test timings** (from `npm run test:e2e` run):
- `test/videos-pipeline.e2e-spec.ts`: **7.973s** (3 tests: a-g happy path, h corrupted, i errors)
- Full e2e suite: **11.912s** total
