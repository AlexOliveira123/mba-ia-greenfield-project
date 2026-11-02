---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-31
scope_description: "Object storage service, large-file upload protocol, background job queue, video worker architecture, streaming/download delivery strategy, and unique video URL identifier for Phase 03."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — primary backend subproject. Receives the object storage integration, upload endpoint, queue module, video processing consumer, and streaming/download endpoints. All six TDs have backend decisions or backend consequences.
- `next-frontend/` — upload UI and video delivery display are shaped by TD-02 (cross-layer, upload protocol determines the frontend upload library) and TD-05 (cross-layer, delivery strategy determines what URL the `<video>` tag and download link receive). No purely-frontend architectural decision applies to this phase: the upload form reuses the Phase 02 form pattern (`react-hook-form` + Zod + BFF Route Handler), and the video player screen with full controls is deferred to Phase 05 ("Página de Visualização do Vídeo"). Phase 03's "Reprodução via streaming" capability is a backend concern — NestJS or MinIO serves the bytes with Range-request support; the player UI is Phase 05.

---

## TD-01: Object Storage Service

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Phase 03 requires persistent, scalable storage for video files (up to 10GB each) and generated thumbnails. The architecture diagram names "Object Storage (S3/MinIO)" as the storage container. The choice of storage service also determines the SDK used in NestJS and whether presigned URLs, multipart upload, and Range requests are available as primitives — all of which TD-02 and TD-05 depend on. This decision is foundational: it must be settled before the upload protocol and delivery strategy.

**Options:**

### Option A: MinIO (self-hosted, S3-compatible, Docker Compose service)
MinIO is an open-source object storage server that is fully API-compatible with AWS S3. Deployed as a `minio` service in `compose.yaml`, exposed on ports `9000` (API) and `9001` (web console). NestJS integrates via `@aws-sdk/client-s3` v3 (+ `@aws-sdk/s3-request-presigner`) with a custom `endpoint` pointing to `http://minio:9000` (the Docker Compose service name) and `forcePathStyle: true`. In production, switching to real AWS S3 requires only changing the endpoint, bucket name, and credentials — zero code changes.
- **Pros:** Identical S3 API in dev and prod — presigned URLs, multipart upload, GetObject with Range, PutObject all work identically against MinIO and S3. Zero cloud cost and no external accounts needed in development. Web console at `:9001` for inspecting buckets. Explicitly named in the architecture diagram. Object storage config maps cleanly to a new `storage.config.ts` namespace (per the `registerAs()` pattern from `phase-01-configuracao-base/TD-03`).
- **Cons:** Adds a new Docker Compose service. `forcePathStyle: true` must be set only in dev/MinIO contexts (not needed for real S3).

### Option B: Local filesystem (Docker volume)
Store files in a Docker-managed volume, served via NestJS static middleware or `StreamableFile` responses.
- **Pros:** Zero new infrastructure — no Docker service, no SDK. Implementation is `fs.writeFile` / `fs.createReadStream`.
- **Cons:** Not production-viable. No presigned URLs, no multipart upload, no Range-request primitives — forces all video bytes through NestJS (the bottleneck concern from TD-05 applies). Cannot be swapped for S3 in production without rewriting the storage layer. Blocks the preferred upload and delivery patterns in TD-02 and TD-05.

### Option C: AWS S3 directly (all environments use real S3)
Use real AWS S3 from day one, including local development.
- **Pros:** No dev/prod divergence. The production service is tested from the start.
- **Cons:** Requires an AWS account and IAM credentials even for `npm run start:dev`. Incurs real costs per upload and storage. Real network latency slows iteration. Offline development is impossible. Inappropriate for a Docker Compose-first environment.

**Recommendation:** **Option A (MinIO)** — S3-compatible API means `@aws-sdk/client-s3` code is identical in dev and production (only endpoint, bucket, and credentials change via the namespaced config). All of Phase 03's upload and delivery patterns — presigned multipart URLs, presigned GET URLs, Range requests — work against MinIO exactly as against S3. Option B forecloses the scalable upload and delivery patterns required for 10GB files. Option C introduces cloud cost and network latency into daily development.

**Decision:** A (MinIO)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-11-02 (Revision 1): Switch MinIO image source to Chainguard pinned by digest (Docker Hub images discontinued); add `MINIO_PUBLIC_ENDPOINT` for presigned URL signing.
  Rationale: `docker pull minio/minio` and `docker pull minio/mc` return "pull access denied" — official Docker Hub community images were discontinued upstream and the upstream MinIO community edition is archived. Replacement MinIO server image pinned by digest: `cgr.dev/chainguard/minio@sha256:0a01100085e30fb08d2f39e39c9f5c9d83a95707f220b007d813b690cd41622d`; `cgr.dev/chainguard/minio-client` was also selected as the init container (`minio-init`) at this point but is superseded by Revision 2 below. Chainguard image runs as UID 65532 (non-root) — `minio-data` must be a named Docker volume so compose sets ownership automatically. Upstream MinIO receives no security patches; acceptable for dev/test only; production target remains AWS S3 via env-only config change. New env var `MINIO_PUBLIC_ENDPOINT` (defaults to `MINIO_ENDPOINT` when unset) is used exclusively by the public S3Client instance for `getSignedUrl` calls (presigned part-upload URLs, stream URL, download URL) so that presigned URLs are signed against a host that clients outside the Compose network can resolve. The `localstack:2.3.2` substitution made in SI-03.2 was undocumented drift; this Revision formalizes the revert to MinIO via Chainguard images.
- 2026-11-02 (Revision 2, amended): Drop `cgr.dev/chainguard/minio-client`; drop `storage-init` service (fresh-clone deadlock); move bucket bootstrap into `StorageService.ensureBucket()` called from `onModuleInit`; `video-worker` made self-recovering; CORS behavior verified at runtime rather than assumed.
  Evidence (host inspection + upstream research): (1) `cgr.dev/chainguard/minio` is fully distroless — no `wget`, `curl`, or shell in-image; no healthcheck command possible. (2) `cgr.dev/chainguard/minio-client` has no `mc cors` subcommand — dropped. (3) `storage-init` (Dockerfile.dev + bind-mount) deadlocks a fresh clone: README flow is `docker compose up -d` → `docker compose exec nestjs-api npm install`; `storage-init` needs `node_modules` (`npx ts-node` + `@aws-sdk`) which comes from the bind mount and is empty on fresh clone → exits non-zero → `nestjs-api` (depends_on `storage-init: service_completed_successfully`) never starts → `npm install` can never run. (4) MinIO `PutBucketCors` S3 API is not supported — maintainer confirmed "We do not support PUT bucket Cors API and never have" (minio/minio#15874). (5) `MINIO_API_CORS_ALLOW_ORIGIN` env var behavior on this Chainguard image is unverified — multiple open issues report no effect in Docker (minio/minio#11258, minio/minio#17409).
  Changes: (a) Drop `cgr.dev/chainguard/minio-client` — unusable. (b) Drop `storage-init` service — fresh-clone deadlock. (c) Add `StorageService.ensureBucket()` (HeadBucket → CreateBucket idempotently if missing, exponential backoff, bounded 30 s timeout) called from `StorageModule.onModuleInit` — both `nestjs-api` and `video-worker` guarantee the bucket exists on startup; integration tests call `ensureBucket()` in `beforeAll` instead of ad-hoc `CreateBucketCommand`. `nestjs-api` depends on `minio: service_started` only. (d) `video-worker`: add `restart: unless-stopped` + command `sh -c "npx tsc -p tsconfig.build.json --outDir dist-worker --declaration false --sourceMap false && node dist-worker/worker/worker-main.js"` — compiles to an isolated `dist-worker/` output dir (avoids race with `nestjs-api`'s `dist/` which has `deleteOutDir: true`); crash-loops harmlessly on fresh clone until `npm install` has run, then self-recovers. (e) CORS: `MINIO_API_CORS_ALLOW_ORIGIN=*` set in `compose.yaml` env — **verified working** on this Chainguard image; OPTIONS preflight returns `Access-Control-Allow-Origin: *`; PUT response exposes `ETag` in `Access-Control-Expose-Headers` (gated by `src/storage/storage.service.integration-spec.ts`).

---

## TD-02: Upload Protocol for Large Files (≤10GB)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** The project plan calls out two hard constraints (under "Pontos de Atenção"): (1) uploads up to 10GB must not impact system performance, and (2) the system must support recovery from connection failures ("permita retomar em caso de falha de conexão"). Additionally, Phase 03 requires a video record to be pre-registered as a draft the moment upload begins — so draft creation and the upload handshake must be coordinated.

On the **frontend side**, the chosen protocol determines the upload library, the progress-tracking mechanism, and whether the binary bytes go through the BFF Route Handler or bypass it (direct to MinIO). The strict BFF model (`next-frontend-config-base/TD-03`) requires that the NestJS `API_URL` stays server-only; however, binary bytes going directly to MinIO from the browser are architecturally acceptable — the object storage host is distinct from the NestJS API host and is meant to be publicly reachable (it serves presigned URLs).

**Options:**

### Option A: Streaming multipart POST through NestJS → MinIO
Client sends a `multipart/form-data` POST to NestJS (via BFF Route Handler). NestJS pipes the incoming stream directly to MinIO using `@aws-sdk/lib-storage`'s `Upload` helper (which handles internal multipart chunking transparently). Progress is tracked client-side via `XMLHttpRequest.upload.onprogress`. The draft record is created at the start of the request handler before piping begins.
- **Pros:** Simplest implementation — single HTTP request, one NestJS endpoint, no external protocol. Progress tracking via standard XHR events. Draft creation is straightforward (before piping). Consistent with the strict BFF model (bytes go through the Route Handler and NestJS).
- **Cons:** **No resume on connection failure** — a dropped connection means restarting the entire upload. NestJS is in the hot path for 10GB binary data (memory pressure, OS-level HTTP timeouts in reverse proxies at 10GB range). Single-request reliability for very large files is poor in practice.

### Option B: S3 Multipart Upload with presigned part URLs
Flow: (1) Client calls `POST /api/videos/upload/initiate` (BFF) → BFF calls NestJS → NestJS creates draft record + calls MinIO `CreateMultipartUpload` → returns `{ videoId, uploadId, parts: [{ partNumber, presignedUrl }] }`. (2) Client uploads each ~50MB part **directly to MinIO** using the part's presigned PUT URL (binary bytes bypass NestJS). (3) Client calls `POST /api/videos/upload/complete` (BFF) → NestJS calls MinIO `CompleteMultipartUpload` → enqueues processing job.
- **Pros:** Resumable at the part level — client stores `{ uploadId, completedParts }` in localStorage and resumes on reconnect by re-uploading only missing parts. Binary bytes bypass NestJS entirely — no streaming bottleneck. S3 Multipart is the AWS standard for large uploads, fully supported by MinIO. Draft pre-registration is natural (created in the `initiate` call before any binary transfer). Part failures are independently retryable.
- **Cons:** Complex orchestration — 3 API round-trips (initiate, N part uploads, complete). Client must manage part state for resume. Presigned part URLs expire (~1 hour) — must be regenerated if the upload is paused longer than the TTL. AWS/MinIO minimum part size is 5MB (last part may be smaller). MinIO must allow CORS for direct browser PUT requests.

### Option C: Tus resumable upload protocol
Tus (https://tus.io) is an open protocol for resumable file uploads. NestJS implements a tus server endpoint using `@tus/server` (Node.js reference implementation). Client uses `tus-js-client` (standalone) or `Uppy` (full-featured upload UI library). Flow: client creates a tus upload → NestJS `onUploadCreate` hook pre-registers the draft and returns the video ID in the response metadata → client sends chunks to the NestJS tus endpoint → NestJS writes to MinIO → `onUploadFinish` hook enqueues the processing job.
- **Pros:** Purpose-built for resumable uploads — the protocol handles all resume logic (offset tracking, partial content). Client resume is automatic on reconnect (no custom state management). `onUploadCreate` / `onUploadFinish` hooks are the natural integration points for draft creation and job dispatch. Pause, resume, and retry are built into `tus-js-client`/`Uppy`. Standard protocol with official clients.
- **Cons:** Adds `@tus/server` (backend) + `tus-js-client` or `Uppy` (frontend) dependencies. The tus endpoint cannot use standard NestJS routing — requires raw HTTP handler via `app.use()`. Binary data flows through NestJS to MinIO (partially similar to Option A's bottleneck, though tus chunks are small). The tus endpoint URL must be reachable from the browser — requires exposing a `NEXT_PUBLIC_UPLOAD_URL` (a new public env key) or proxying via a BFF Route Handler (complex for streaming).

**Recommendation:** **Option B (S3 Multipart with presigned part URLs)** — Satisfies both the performance requirement (bytes bypass NestJS) and the resumability requirement (part-level resume via stored `uploadId`). The orchestration is bounded (3 API calls) and each call follows the existing BFF Route Handler → NestJS pattern. Unlike Option C, no new protocol or raw HTTP handler is needed, and the strict BFF model is not strained (no extra public env key required). Option A is disqualified by the explicit resume requirement. Option C is viable and provides better client-side resume ergonomics, but creates tension with the strict BFF model (upload endpoint URL must be browser-reachable) and adds protocol learning overhead; recommend if the team prioritizes zero-client-state resume over implementation simplicity.

**Decision:** B (S3 Multipart with presigned part URLs)
**Libraries:** —

---

## TD-03: Background Job Queue

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** After a video is uploaded, Phase 03 requires automatic processing: extracting metadata (duration, resolution, codec) and generating a thumbnail from a video frame using FFmpeg. These operations are CPU-intensive and must run in the background without blocking the HTTP response. A job queue dispatches work from the API to the video worker (TD-04). The choice of queue system determines infrastructure requirements (new Docker Compose services) and the NestJS integration approach.

**Options:**

### Option A: BullMQ + @nestjs/bullmq (Redis-backed)
BullMQ is the de-facto NestJS queue library, backed by Redis. `@nestjs/bullmq` is the official NestJS module with decorator-based consumers (`@Processor`, `@OnWorkerEvent`, `WorkerHost`). Each job is a JSON payload stored in Redis and consumed by registered processors. Supports retries, delays, priorities, and job lifecycle events.
- **Pros:** Official `@nestjs/bullmq` module — DI-integrated decorators mirror NestJS conventions; no custom boilerplate for processor registration or graceful shutdown. Persistent jobs (Redis RDB/AOF), retry strategies, dead-letter queues, and job lifecycle events built in. Large NestJS community with extensive documentation. Bull Board provides a web UI for job inspection. Redis is well-understood and lightweight (< 5MB footprint for this use case).
- **Cons:** Adds Redis as a new Docker Compose service. JSON serialization for job payloads (acceptable — job contains only metadata like `videoId`, `storagePath`, not binary data).

### Option B: pg-boss (PostgreSQL-backed)
pg-boss is a job queue built on PostgreSQL, using `SKIP LOCKED` for efficient job consumption. Jobs are rows in a `pgboss` schema within the existing `streamtube` database. No new Docker Compose service.
- **Pros:** No new infrastructure — reuses the existing PostgreSQL service. ACID-compliant job durability (PostgreSQL WAL). Eliminates Redis entirely.
- **Cons:** No official `@nestjs/pg-boss` module — requires custom NestJS provider wiring (a module that wraps pg-boss lifecycle: `start()`, `work()`, graceful `stop()`). Polling-based consumption (configurable interval) rather than event-driven — slight latency between job creation and pickup. Imperative API (`boss.work('video-processing', handler)`) is less idiomatic for NestJS than `@Processor` decorators. Notably fewer NestJS-specific patterns and examples in the community.

### Option C: RabbitMQ + @golevelup/nestjs-rabbitmq
RabbitMQ is a mature AMQP-based message broker. `@golevelup/nestjs-rabbitmq` provides NestJS integration with declarative message handlers and DI support.
- **Pros:** Battle-tested AMQP broker. Durable queues, exchanges, routing keys, dead-letter queues. Management UI at `:15672`. Suitable for complex multi-consumer topologies.
- **Cons:** **Significantly over-engineered** for a single producer → single consumer video processing pipeline. RabbitMQ's Docker image is heavier than Redis. `@golevelup/nestjs-rabbitmq` is a third-party module, not NestJS-official. AMQP concepts (exchanges, bindings, routing keys) add unnecessary learning overhead for this use case.

**Recommendation:** **Option A (BullMQ + @nestjs/bullmq)** — The official NestJS module provides DI-integrated decorator-based processors that align with the project's conventions. Redis is a small, well-understood service to add to the Compose stack. Option B is architecturally elegant (no new service) but the absence of a first-class NestJS integration means writing custom lifecycle boilerplate that BullMQ provides out of the box. Option C is overkill for a single-queue pipeline.

**Decision:** A (BullMQ + @nestjs/bullmq)
**Libraries:** @nestjs/bullmq, bullmq

---

## TD-04: Video Worker Architecture

**Scope:** Repo-wide

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The architecture diagram explicitly shows "Video Worker (FFmpeg)" as a container separate from the API. This TD decides how the video processing worker is structured in the monorepo and deployed. The worker must: consume jobs from the queue (TD-03), call FFmpeg, update the video record via TypeORM, and upload the generated thumbnail to MinIO (TD-01). The worker shares domain entities (Video, Channel) and config modules with the API — the question is whether this sharing is achieved through a common codebase or through independent services.

**Options:**

### Option A: Co-located consumer — API and worker in the same nestjs-api process
The queue processor (`@Processor` class) lives in `nestjs-project/` and is loaded into the same NestJS application module as the HTTP API. Both the HTTP server and the video processor run in the same `nestjs-api` Docker container.
- **Pros:** Simplest deployment — no new Docker service, no new entry point. Full access to all modules (TypeORM entities, ConfigService, storage services) without duplication. Quick to implement.
- **Cons:** CPU-intensive FFmpeg jobs compete with HTTP request handling in the same OS process — long-running video processing can consume CPU that should serve API requests. Diverges from the architecture diagram (which shows the worker as a separate container). Cannot scale the worker independently from the API.

### Option B: Separate service — new `video-worker/` directory in the monorepo
A new top-level directory `video-worker/` with its own `package.json`, `tsconfig.json`, and source tree. Deployed as a fully independent Docker container.
- **Pros:** Complete isolation — separate deploy, separate scaling, separate dependency tree.
- **Cons:** High setup cost: TypeORM entities, config modules, and domain logic must either be duplicated or extracted into a shared `packages/` workspace (npm workspaces setup, shared build pipeline). Premature for Phase 03 when the video entity is just being defined. Over-engineered for the current scope.

### Option C: Same nestjs-project codebase, separate NestJS app entry point + separate Docker service
The `nestjs-project/` codebase gets a second NestJS application entry point (e.g., `src/worker-main.ts`) that bootstraps a worker-only NestJS app — imports QueueModule, VideoModule, StorageModule, but NOT the HTTP controllers or `AppModule`'s HTTP layer. `compose.yaml` gets a `video-worker` service that runs `node dist/worker-main.js` using the same Docker image as `nestjs-api` but a different `command`. Shared entities, configs, and services are available in both processes by construction — same codebase, same `dist/`.
- **Pros:** Aligns with the architecture diagram (separate container). Shared codebase — entities, TypeORM config, storage services, and domain logic are available in both processes without duplication. Independent scaling — multiple worker replicas can run without scaling the API. Clean separation — HTTP controllers are not loaded in the worker process. Requires only a new entry file and one `compose.yaml` service.
- **Cons:** Two entry points to maintain. The worker's bootstrap module must be updated when new modules need to be accessible in the worker. `compose.yaml` gains an extra service.

**Recommendation:** **Option C (same codebase, separate entry point + Docker service)** — Achieves the architecture diagram's worker-as-separate-container requirement without code duplication or premature monorepo restructuring. The worker entry point is a small file (`src/worker-main.ts`); the Compose change is one service block. Option A is rejected because CPU contention between HTTP handling and FFmpeg is a real concern for a video platform even in development. Option B's setup cost is disproportionate to Phase 03 when the entities are still being created.

**Decision:** C (same codebase, separate entry point + Docker service)
**Libraries:** —

---

## TD-05: Video Delivery Strategy (Streaming & Download)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** After a video is processed, Phase 03 requires two delivery mechanisms: streaming playback (video starts playing before the file is fully downloaded) and user-initiated download. The choice determines how NestJS serves video files and what URL the Next.js frontend provides to the `<video>` tag and download link.

This is cross-layer because:
- **Backend:** NestJS either proxies video streams (with Range-header support) or generates short-lived presigned URLs and returns them as JSON.
- **Frontend:** The BFF Route Handler either calls a stream-proxy endpoint (and pipes the response) or calls a URL-generation endpoint and returns the URL as JSON; the client then points `<video src>` and download `<a href>` at the returned URL.

Under the strict BFF model, the client only calls same-origin Next.js routes. For presigned URLs, the BFF Route Handler calls NestJS, obtains the presigned URL, and returns it as JSON data — the object storage hostname appears in the response body (not as an env var). This is architecturally acceptable: the storage host is data, not configuration, and MinIO/S3 is intended to be publicly reachable.

**Options:**

### Option A: NestJS stream proxy with Range headers
NestJS exposes `GET /videos/:id/stream` and `GET /videos/:id/download`. Each endpoint calls `GetObjectCommand` on MinIO, reads the `Range` request header, and pipes the object body to the HTTP response with `Content-Range` and `Accept-Ranges` headers (HTTP 206 Partial Content). The BFF Route Handler pipes NestJS's response to the browser.
- **Pros:** All traffic through the API — NestJS can enforce access checks (e.g., unlisted video auth) inline with the stream delivery. No URL expiry concern. Consistent with the strict BFF model (bytes flow through Route Handler → NestJS).
- **Cons:** **NestJS is in the hot path for 10GB binary data** — every streaming byte flows through the Node.js process, consuming memory and CPU that should serve API requests. Under concurrent video playback, this saturates the API pod. Range-request proxying must be implemented correctly (Content-Range, 206/416 status codes, multi-range negotiation). Node.js is not designed to be a streaming media server.

### Option B: Time-limited presigned GET URLs from MinIO/S3
NestJS exposes `GET /videos/:id/stream-url` and `GET /videos/:id/download-url`. Each calls the MinIO SDK to generate a presigned GET URL (e.g., 4-hour TTL for streaming; shorter for download). The BFF Route Handler returns the presigned URL as JSON. The client sets `<video src={streamUrl}>` and download `<a href={downloadUrl}>`. The browser streams directly from MinIO, which natively handles Range requests.
- **Pros:** NestJS never handles binary video data for playback — it only issues short-lived URLs. MinIO/S3 natively supports Range requests and HTTP 206 — no custom implementation. Scales to any number of concurrent streams. Authorization checks happen at URL-generation time (NestJS validates auth before issuing the URL). Same pattern works identically in production with S3. Aligns with how large-scale video platforms (YouTube, S3-backed CDNs) operate.
- **Cons:** Presigned URLs expire — a stale URL (e.g., from a cached page) results in a MinIO 403. The BFF must generate fresh URLs per request or the client must handle 403 gracefully. MinIO must be accessible from the client browser at the host/port in the presigned URL (port `9000` exposed in `compose.yaml`).

### Option C: CDN fronting object storage
A CDN (CloudFront, Cloudflare R2, BunnyCDN) is placed in front of MinIO/S3. NestJS returns CDN URLs; the CDN serves video bytes from edge nodes.
- **Pros:** Best end-user performance. Edge caching reduces origin load. Handles Range requests and streaming natively. No URL expiry issue (CDN can use signed cookies for access control).
- **Cons:** **Significant new infrastructure** — CDN integration is out of scope for a greenfield Phase 03. Requires a cloud provider even for dev testing. Adds cache-invalidation complexity. Better suited for Phase 07 (production preparation) than for the upload pipeline phase.

**Recommendation:** **Option B (time-limited presigned URLs)** — NestJS is not designed to be a streaming media server; proxying 10GB video streams through Node.js creates a bottleneck that degrades all other API traffic. Presigned URLs are the industry-standard pattern for object-storage-backed video platforms. The URL expiry concern is manageable: generate URLs with a TTL covering a full playback session (4 hours) or generate fresh URLs on each page render via the BFF. Option A's binary proxy is an architectural anti-pattern for video streaming at this scale. Option C is premature infrastructure for Phase 03.

**Decision:** B (time-limited presigned GET URLs)
**Libraries:** —

---

## TD-06: Unique Video Identifier (Public URL Slug)

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Each video needs a unique public identifier used in its URL (e.g., `/videos/<id>`). TypeORM entities already use UUID v4 as primary keys. The question is whether the public-facing URL uses the UUID directly, or a separate shorter identifier column. This decision is effectively permanent — changing the public URL scheme after content is live breaks existing links and bookmarks.

**Options:**

### Option A: UUID v4 as public identifier (reuse internal PK)
The video's UUID is used directly as the URL segment: `/videos/550e8400-e29b-41d4-a716-446655440000`. No extra column. UUID guarantees uniqueness.
- **Pros:** Zero implementation overhead — UUID is already the PK; no extra column, no generation logic, no unique index.
- **Cons:** 36-character URLs are long, visually noisy, and copy-unfriendly. No video platform of note uses raw UUIDs in public URLs. Poor UX for share links.

### Option B: nanoid — short, URL-safe, separate `public_id` column
A separate `public_id` column (VARCHAR ~12) generated at video creation time using `nanoid` with a URL-safe alphabet (`A-Za-z0-9_-`). Videos are addressed as `/videos/V1StGXR8_Z5j`. The UUID remains as the internal DB PK and FK target; `public_id` has a `UNIQUE` index.
- **Pros:** Short, URL-safe identifiers (YouTube-style: 11 chars). With a 64-char alphabet, 12 characters yield ~7.2×10²¹ combinations — no collision risk in practice. Lightweight package (~130 bytes, zero dependencies). Keeps internal PK as UUID (no FK cascade impact). `nanoid` is already a transitive dependency in the ecosystem; lightweight to add explicitly.
- **Cons:** One extra column and unique index per video. Two identifiers per entity (internal UUID, public nanoid) adds slight mental overhead.

### Option C: Slug derived from video title (human-readable)
A slug like `my-video-title-abc123` derived from the title at creation time, with a random or sequential uniqueness suffix.
- **Pros:** Human-readable and SEO-friendly. The URL describes the content.
- **Cons:** Phase 03 creates videos as drafts **before a title is known** (the title is set in Phase 04) — the slug cannot be generated at upload time. If a slug were generated later, it would require a Phase 04 migration. Slug changes on title edit → breaking links. Collision detection requires a DB query per generation. Higher implementation complexity for a marginal UX benefit.

**Recommendation:** **Option B (nanoid)** — Short, URL-safe public IDs are the industry standard for video platforms (YouTube: 11 chars). The `public_id` column adds minimal implementation cost while producing significantly better public URLs than raw UUIDs. Option C is disqualified by the Phase 03 draft model: videos are pre-registered without titles, so a title-derived slug cannot be generated at upload initiation. Option A works but produces poor public-facing URLs for a user-facing platform.

**Decision:** B (nanoid, separate public_id column)
**Libraries:** nanoid

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object Storage Service | Option A — MinIO (S3-compatible, Docker Compose) | A |
| TD-02 | Cross-layer | Upload Protocol for Large Files (≤10GB) | Option B — S3 Multipart with presigned part URLs | B |
| TD-03 | Backend | Background Job Queue | Option A — BullMQ + @nestjs/bullmq + Redis | A |
| TD-04 | Repo-wide | Video Worker Architecture | Option C — Same nestjs-project codebase, separate entry point + Docker service | C |
| TD-05 | Cross-layer | Video Delivery Strategy (Streaming & Download) | Option B — Time-limited presigned URLs from MinIO/S3 | B |
| TD-06 | Backend | Unique Video Identifier (Public URL Slug) | Option B — nanoid (short, URL-safe, separate `public_id` column) | B |
