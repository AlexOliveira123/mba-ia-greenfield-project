---
phase: 3
slug: phase-03-videos
title: "Upload e Processamento de Vídeos"
covers_capabilities:
  - Serviço de armazenamento de arquivos (vídeos e thumbnails)
  - Serviço de processamento em segundo plano (filas)
  - Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
  - Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
  - Processamento automático do vídeo após upload (extração de duração e metadados)
  - Geração automática de thumbnail a partir de um frame do vídeo
  - URL única por vídeo, sem conflito com outros vídeos
  - Reprodução via streaming (sem necessidade de download completo)
  - Download do vídeo pelo usuário
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-02T12:19:05-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-02T12:18:41-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T12:17:27-03:00"
---

# phase-03-videos — Plan

## Step Implementations

### SI-03.1 — Infra: Docker Compose (MinIO + Redis), npm packages e config factories

**Description:** Prepara a infraestrutura local e o esqueleto de configuração que todos os demais SIs desta fase dependem: serviços MinIO e Redis no Compose, variáveis de ambiente, config factories e packages npm.

**Technical actions:**

1. Instalar packages npm dentro do container — `docker compose exec nestjs-api npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner @nestjs/bullmq bullmq nanoid` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-03`, `phase-03-videos/TD-06`)
2. Adicionar serviços `minio` e `redis` ao `compose.yaml` — named volume `minio-data`, credenciais, portas (per `phase-03-videos/TD-01` Revisions 2026-11-02, `phase-03-videos/TD-02`, `phase-03-videos/TD-03`):
   - `minio`: image `cgr.dev/chainguard/minio@sha256:0a01100085e30fb08d2f39e39c9f5c9d83a95707f220b007d813b690cd41622d`; command `server /data --console-address ":9001"` (Chainguard image não tem default — sem command explícito o container exibe help e sai com código 0); named volume `minio-data` (UID 65532); **sem healthcheck** — distroless; env `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_API_CORS_ALLOW_ORIGIN=*` (behavior unverified — gated por integration test em SI-03.2); `nestjs-api` depends_on `minio: {condition: service_started}` apenas
   - `video-worker`: adicionar `restart: unless-stopped`; command como lista YAML `["sh", "-c", "npx tsc -p tsconfig.build.json --outDir dist-worker --declaration false --sourceMap false && node dist-worker/worker/worker-main.js"]` — usar lista YAML (não string escalar `>`) para evitar que o folded block scalar insira `\n` antes de `&&`, causando `sh: 2: Syntax error: "&&" unexpected` no dash do container; crash-loops harmlessly em fresh clone até `npm install` ter rodado (bind-mount: `node_modules` vem do host), depois auto-recupera; depends_on `minio: {condition: service_started}`, `db: {condition: service_healthy}`, `redis: {condition: service_healthy}` — **Rationale dist-worker:** `npm run build` (`nest build`) tem `deleteOutDir: true` e escreve em `./dist` compartilhado via bind-mount com a `nestjs-api`; cada restart do worker apagaria o output que `nest start --watch` está servindo. `tsc --outDir dist-worker --declaration false --sourceMap false` (sem Nest CLI e sem swagger plugin) isola os dois outputs e não emite `.d.ts` que seriam picked up pelo type-checker; o worker precisa apenas das entities, config, storage, queue e do processor.
   - **Bucket bootstrap:** sem serviço dedicado — movido para `StorageService.ensureBucket()` / `onModuleInit` (ver SI-03.2 action 2)
3. Criar `src/config/storage.config.ts` — `registerAs('storage', () => ({ endpoint, publicEndpoint, region, accessKeyId, secretAccessKey, bucket }))` onde `publicEndpoint` defaults ao valor de `endpoint` quando `MINIO_PUBLIC_ENDPOINT` não estiver definida (per `phase-03-videos/TD-01` Revision 2026-11-02)
4. Criar `src/config/queue.config.ts` — `registerAs('queue', () => ({ redisHost, redisPort }))` (per `phase-03-videos/TD-03`)
5. Atualizar `src/config/env.validation.ts`, `.env` e `.env.example` — adicionar Joi rules para `MINIO_ENDPOINT`, `MINIO_PORT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY`, `MINIO_BUCKET`, `MINIO_PUBLIC_ENDPOINT` (optional, defaults to `MINIO_ENDPOINT`), `REDIS_HOST`, `REDIS_PORT` (per `phase-03-videos/TD-01` Revision 2026-11-02)
6. Adicionar `dist-worker/` ao `.gitignore`; adicionar `'dist-worker/**'` ao array `ignores` em `eslint.config.mjs` (projeto usa ESLint flat config — `eslintIgnore` em `package.json` e `.eslintignore` não são lidos por flat config); adicionar `"dist-worker"` ao array `exclude` em `tsconfig.build.json` e garantir `"exclude": ["node_modules", "dist", "dist-worker"]` explícito em `tsconfig.json` (sem `exclude` explícito o TS auto-exclui apenas `outDir`/`./dist` — os `.d.ts` emitidos em `dist-worker/` seriam picked up por `tsc --noEmit` e `nest build`); adicionar `"dist-worker"` a `modulePathIgnorePatterns` ou `testPathIgnorePatterns` do Jest em `package.json`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage.config.ts` | Unit: factory retorna shape esperada dado mock de `process.env` | `src/config/storage.config.spec.ts` |
| `queue.config.ts` | Unit: factory retorna shape esperada dado mock de `process.env` | `src/config/queue.config.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` levanta `minio`, `redis` e `video-worker` sem erro; `minio` sobe (condition: service_started — sem healthcheck, distroless); `video-worker` sobe com `restart: unless-stopped` e se auto-recupera após `npm install` + `npx tsc --outDir dist-worker --declaration false --sourceMap false`
- `dist-worker/` consta no `.gitignore`, array `ignores` de `eslint.config.mjs`, e Jest ignores; `"dist-worker"` consta em `exclude` de `tsconfig.build.json` e `tsconfig.json`
- Após build do worker (`npx tsc -p tsconfig.build.json --outDir dist-worker --declaration false --sourceMap false`), `npx tsc --noEmit` e `npm run lint` passam sem envolver arquivos de `dist-worker/`
- `src/config/storage.config.ts` e `src/config/queue.config.ts` existem com factories `registerAs`
- Joi validation rejeita startup quando qualquer var `MINIO_*` obrigatória estiver ausente; `MINIO_PUBLIC_ENDPOINT` é opcional (defaults to `MINIO_ENDPOINT`)
- Packages `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `@nestjs/bullmq`, `bullmq`, `nanoid` aparecem em `package.json`

---

### SI-03.2 — StorageModule: S3Client provider e StorageService

**Description:** Encapsula toda interação com MinIO via AWS SDK v3 — dois `S3Client` com `forcePathStyle: true` (`STORAGE_CLIENT_INTERNAL` para comandos server-side, `STORAGE_CLIENT_PUBLIC` exclusivamente para `getSignedUrl`), operações de multipart upload, presigned URLs de parte e de entrega, bootstrap idempotente do bucket (`ensureBucket()` via `OnModuleInit`). Exporta `StorageService` para uso pelo `VideosService` e pelo worker. (per `phase-03-videos/TD-01` Revisions 2026-11-02)

**Technical actions:**

1. Criar `src/storage/storage.module.ts` — provê DOIS `S3Client` com `forcePathStyle: true` (per `phase-03-videos/TD-01` Revision 2026-11-02):
   - `STORAGE_CLIENT_INTERNAL` (injection token): endpoint = `storageConfig.endpoint` (`MINIO_ENDPOINT`) — usado para todos os comandos server-side (CreateMultipartUpload, CompleteMultipartUpload, GetObject, DeleteObject, PutObject)
   - `STORAGE_CLIENT_PUBLIC` (injection token): endpoint = `storageConfig.publicEndpoint` (defaults to `storageConfig.endpoint`) — usado EXCLUSIVAMENTE por `getSignedUrl` para que presigned URLs sejam assinadas contra host acessível de fora da rede Compose
2. Criar `src/storage/storage.service.ts` — implementa `OnModuleInit`; injeta `STORAGE_CLIENT_INTERNAL` e `STORAGE_CLIENT_PUBLIC`; métodos: `ensureBucket()` (HeadBucket → CreateBucket se ausente, ignora `BucketAlreadyOwnedByYou`/`BucketAlreadyExists`, exponential backoff, timeout 30 s — chamado de `onModuleInit`), `createMultipartUpload(key)`, `getPresignedPartUrls(key, uploadId, partCount)`, `completeMultipartUpload(key, uploadId, parts)`, `getPresignedGetUrl(key, ttlSeconds, disposition?)`, `deleteObject(key)`, `downloadToFile(key, localPath)`, `uploadFile(key, localPath, contentType)` — todos os comandos S3 usam `STORAGE_CLIENT_INTERNAL`; apenas `getSignedUrl` usa `STORAGE_CLIENT_PUBLIC` (per `phase-03-videos/TD-01` Revisions 2026-11-02, `phase-03-videos/TD-02`, `phase-03-videos/TD-05`)
3. Registrar `StorageModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Unit: cada método com ambos os clients mockados — verifica comandos emitidos; `getPresignedPartUrls` e `getPresignedGetUrl` usam `STORAGE_CLIENT_PUBLIC`; demais métodos usam `STORAGE_CLIENT_INTERNAL` (verificado via spy) | `src/storage/storage.service.spec.ts` |
| `StorageService` | Integration: `beforeAll` chama `ensureBucket()`; `createMultipartUpload` + `completeMultipartUpload` + presigned GET URL contra MinIO real do Compose; presigned URLs contêm host de `MINIO_PUBLIC_ENDPOINT`; CORS — OPTIONS preflight a URL presigned PUT com `Origin: http://localhost:3001` + `Access-Control-Request-Method: PUT` deve retornar `Access-Control-Allow-Origin`; PUT real deve expor `ETag` em `Access-Control-Expose-Headers` | `src/storage/storage.service.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `StorageService.ensureBucket()` executa sem erro dado MinIO rodando; idempotente (segunda chamada não falha se bucket já existe)
- `StorageService.createMultipartUpload(key)` retorna `{ uploadId: string }` sem erro dado MinIO rodando
- `StorageService.getPresignedPartUrls(key, uploadId, 3)` retorna array de 3 objetos `{ partNumber, presignedUrl }` com URLs contendo `X-Amz-Signature` e host de `MINIO_PUBLIC_ENDPOINT`
- `StorageService.getPresignedGetUrl(key, 14400)` retorna URL com `X-Amz-Expires=14400` e host de `MINIO_PUBLIC_ENDPOINT`
- `StorageService.getPresignedGetUrl(key, 3600, 'attachment; filename="video.mp4"')` retorna URL com `response-content-disposition` no query string e host de `MINIO_PUBLIC_ENDPOINT`
- Comandos server-side (`createMultipartUpload`, `completeMultipartUpload`, `deleteObject`, `downloadToFile`, `uploadFile`) usam `STORAGE_CLIENT_INTERNAL`; presigned URLs usam `STORAGE_CLIENT_PUBLIC` — verificado em testes unitários via spies nos dois clients
- CORS (integration): OPTIONS preflight a URL presigned PUT com `Origin: http://localhost:3001` retorna `Access-Control-Allow-Origin`; PUT real expõe `ETag` em `Access-Control-Expose-Headers`
- **CORS test gate:** se a assertion de CORS falhar durante a implementação, INTERROMPER e reportar — NÃO deletar nem enfraquecer o teste; acionar `/decide` para registrar a decisão de CORS correta.
- Testes unitários passam com ambos os clients mockados; testes de integração passam com MinIO do Compose

---

### SI-03.3 — QueueModule: BullMQ setup e configuração

**Description:** Registra o Redis e a fila `video-processing` no BullMQ, disponibilizando o token `@InjectQueue('video-processing')` para o producer (`VideosService`) e o decorador `@Processor('video-processing')` para o consumer (worker).

**Technical actions:**

1. Criar `src/queue/queue.module.ts` — `BullModule.forRootAsync` injetando `queueConfig` para host/port Redis; `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`; exportar o módulo (per `phase-03-videos/TD-03`)
2. Criar `src/queue/constants.ts` — `export const VIDEO_PROCESSING_QUEUE = 'video-processing'`
3. Registrar `QueueModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Unit: compilação e resolução do token `@InjectQueue(VIDEO_PROCESSING_QUEUE)` com `BullModule.registerQueue` mockado | `src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `QueueModule` é importado em `AppModule` sem erro de compilação TypeScript
- `@InjectQueue(VIDEO_PROCESSING_QUEUE)` resolve para uma instância `Queue` quando `QueueModule` é importado em um test module
- Constante `VIDEO_PROCESSING_QUEUE = 'video-processing'` é exportada e usável em outros módulos

---

### SI-03.4 — Video entity, migration e nanoid public_id

**Description:** Define a entidade `Video` com todos os campos do Data Model, o enum `VideoStatus`, o hook `@BeforeInsert()` para geração automática do `public_id` com `nanoid(12)`, e cria a migration correspondente.

**Technical actions:**

1. Criar `src/videos/video.entity.ts` — entity `Video` com todos os campos do Data Model (id, public_id, title, description, status, storage_key, upload_id, duration, thumbnail_key, channel_id, created_at, updated_at), enum `VideoStatus`, `@BeforeInsert() generatePublicId()` via `nanoid(12)` (per `phase-03-videos/TD-06`, `### Data Model → Video`)
2. Criar `src/videos/videos.module.ts` — `VideosModule` com `TypeOrmModule.forFeature([Video])`
3. Gerar migration `CreateVideosTable` — `CREATE TABLE videos` com todos os campos, `UNIQUE INDEX uq_videos_public_id`, FK `channel_id → channels(id)`
4. Registrar `VideosModule` em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` entity | Integration: `public_id` único (INSERT duplicado retorna constraint violation), `status` default `'draft'`, FK `channel_id` NOT NULL, `@BeforeInsert` gera string de 12 chars URL-safe | `src/videos/video.entity.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `Video.publicId` é preenchido automaticamente com 12 caracteres URL-safe (`[A-Za-z0-9_-]`) ao criar um registro sem especificar `publicId`
- Inserir dois `Video` com o mesmo `public_id` retorna violação de constraint `uq_videos_public_id`
- `Video.status` assume `'draft'` quando não especificado
- INSERT de `Video` sem `channel_id` retorna erro de constraint NOT NULL

---

### SI-03.5 — VideosService: upload initiate

**Description:** Implementa o fluxo de iniciação do upload multipart — verifica ownership do canal, cria o rascunho `Video` no banco, inicia o multipart upload no MinIO, gera as presigned part URLs e retorna os dados para o cliente enviar as partes diretamente ao MinIO.

**Technical actions:**

1. Criar `src/videos/dto/upload-initiate.dto.ts` — `UploadInitiateDto` com `class-validator`: `channelId` (UUID), `fileName` (string, max 255), `fileSize` (integer, max 10 737 418 240), `mimeType` (allowlist: mp4, webm, quicktime, x-msvideo), `partCount` (integer, min 1, max 1000) (per `### API Contracts → Validation Rules`)
2. Criar `src/videos/videos.service.ts` com `VideosService.initiateUpload(dto, userId)` — verificar que `channelId` pertence ao `userId` (lança `ForbiddenException` com `UPLOAD_OWNERSHIP`); criar rascunho `Video` (status `draft`, `storage_key`, `upload_id` provisório); chamar `StorageService.createMultipartUpload` + `getPresignedPartUrls`; persistir `upload_id`; retornar `{ videoId, publicId, uploadId, parts }` (per `phase-03-videos/TD-02`, `### API Contracts → POST /videos/upload/initiate`)
3. Injetar `@InjectRepository(Video)`, `StorageService` e `Repository<Channel>` (para ownership check) em `VideosService`; exportar `VideosService` de `VideosModule`; adicionar `StorageModule` aos imports de `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: caminho feliz, `UPLOAD_OWNERSHIP` (channelId de outro usuário), `UPLOAD_INITIATE_FAILED` (StorageService lança) — StorageService e repos mockados | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: rascunho `Video` criado no DB com `status: 'draft'`, `upload_id` preenchido, `public_id` gerado com 12 chars | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2, SI-03.4

**Acceptance criteria:**

- `initiateUpload` com `channelId` que não pertence ao `userId` lança `ForbiddenException` com `errorCode: "UPLOAD_OWNERSHIP"`
- `initiateUpload` com dados válidos cria um `Video` com `status: 'draft'` no DB e retorna `videoId`, `publicId`, `uploadId` e array `parts` com `parts.length === partCount`
- Cada item de `parts` contém `partNumber` (inteiro ≥ 1) e `presignedUrl` (URL com query `X-Amz-Signature`)
- Falha em `StorageService.createMultipartUpload` propaga como `InternalServerErrorException` com `errorCode: "UPLOAD_INITIATE_FAILED"`

---

### SI-03.6 — VideosService: upload complete e enqueue job

**Description:** Implementa o fluxo de conclusão do upload multipart — chama `CompleteMultipartUpload` no MinIO, transiciona o status do vídeo para `processing`, zera o `upload_id` e enfileira o job `process-video` na fila BullMQ.

**Technical actions:**

1. Criar `src/videos/dto/upload-complete.dto.ts` — `UploadCompleteDto`: `videoId` (UUID), `uploadId` (string), `parts` (array de `{ partNumber: number, eTag: string }`) (per `### API Contracts → POST /videos/upload/complete`)
2. Implementar `VideosService.completeUpload(dto, userId)` — buscar `Video` por `videoId` verificando ownership (lança `VIDEO_NOT_FOUND`); validar `dto.parts.length === video.partCount` (lança `UPLOAD_PART_COUNT_MISMATCH`); chamar `StorageService.completeMultipartUpload`; atualizar `Video` (`status: 'processing'`, `upload_id: null`); enfileirar job `process-video` com `{ videoId, storageKey }` via `@InjectQueue(VIDEO_PROCESSING_QUEUE)` (per `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `### Events/Messages → process-video`)
3. Injetar `@InjectQueue(VIDEO_PROCESSING_QUEUE)` em `VideosService`; adicionar `QueueModule` aos imports de `VideosModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: caminho feliz (status→processing, job enfileirado), `VIDEO_NOT_FOUND`, `UPLOAD_PART_COUNT_MISMATCH`, `UPLOAD_COMPLETE_FAILED` — StorageService, repo e Queue mockados | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.5, SI-03.3

**Acceptance criteria:**

- `completeUpload` com `videoId` inexistente ou pertencente a outro usuário lança `NotFoundException` com `errorCode: "VIDEO_NOT_FOUND"`
- `completeUpload` com `parts.length` diferente do `partCount` originalmente registrado lança `UnprocessableEntityException` com `errorCode: "UPLOAD_PART_COUNT_MISMATCH"`
- `completeUpload` com dados válidos atualiza `Video.status` para `'processing'`, zera `Video.upload_id` e enfileira job `process-video` com payload `{ videoId, storageKey }`
- Falha em `StorageService.completeMultipartUpload` propaga como `InternalServerErrorException` com `errorCode: "UPLOAD_COMPLETE_FAILED"`

---

### SI-03.7 — VideosService: stream URL e download URL

**Description:** Implementa os métodos de entrega do vídeo — geração de presigned GET URLs para streaming (TTL: 4h) e para download forçado com `Content-Disposition: attachment` (TTL: 1h), conforme `phase-03-videos/TD-05`.

**Technical actions:**

1. Implementar `VideosService.getStreamUrl(publicId)` — buscar `Video` por `public_id` com `status: 'ready'` (lança `NotFoundException` com `VIDEO_NOT_FOUND` se ausente ou status diferente); chamar `StorageService.getPresignedGetUrl(storageKey, 14400)`; retornar `{ url, expiresAt }` (per `phase-03-videos/TD-05`, `### API Contracts → GET /videos/:publicId/stream-url`)
2. Implementar `VideosService.getDownloadUrl(publicId)` — mesma lógica com TTL 3600 e `disposition: 'attachment; filename="{fileName}"'` (per `phase-03-videos/TD-05`, `### API Contracts → GET /videos/:publicId/download-url`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getStreamUrl` | Unit: caminho feliz (retorna `{ url, expiresAt }`), `VIDEO_NOT_FOUND` (status `'draft'` ou `'processing'`), `VIDEO_NOT_FOUND` (publicId inexistente) — StorageService e repo mockados | `src/videos/videos.service.spec.ts` |
| `VideosService.getDownloadUrl` | Unit: caminho feliz, `VIDEO_NOT_FOUND` — idem | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `getStreamUrl` com `publicId` de vídeo `status: 'ready'` retorna `{ url: string, expiresAt: string }` com `url` contendo `X-Amz-Expires=14400`
- `getStreamUrl` com `publicId` de vídeo em `status: 'draft'` ou `'processing'` lança `NotFoundException` com `errorCode: "VIDEO_NOT_FOUND"`
- `getDownloadUrl` com `publicId` válido retorna URL com `X-Amz-Expires=3600` e parâmetro `response-content-disposition` no query string
- `getDownloadUrl` com `publicId` inexistente lança `NotFoundException` com `errorCode: "VIDEO_NOT_FOUND"`

---

### SI-03.8 — VideosController: endpoints de upload e delivery

**Description:** Expõe os 4 endpoints REST do ciclo de upload e delivery, aplica `JwtAuthGuard` nos endpoints de upload e adiciona decoradores OpenAPI para cada rota.

**Route:** POST /videos/upload/initiate, POST /videos/upload/complete, GET /videos/:publicId/stream-url, GET /videos/:publicId/download-url
**Test Specs:** see `nestjs-project/specs/videos-upload-delivery.plan.md`
**Authorization:** POST endpoints — Channel Owner (per `### Authorization Matrix`); GET endpoints — Anonymous

**Technical actions:**

1. Criar `src/videos/videos.controller.ts` — 4 rotas: `POST /videos/upload/initiate` (201), `POST /videos/upload/complete` (200), `GET /videos/:publicId/stream-url` (200), `GET /videos/:publicId/download-url` (200) delegando ao `VideosService` (per `### API Contracts`)
2. Aplicar `@UseGuards(JwtAuthGuard)` nos endpoints `initiate` e `complete`; extrair `req.user.id` via `@Request()` para passar ao `VideosService` como `userId` (per `### Authorization Matrix`)
3. Adicionar `@ApiTags('videos')`, `@ApiOperation`, `@ApiBearerAuth`, `@ApiResponse` em cada rota (per `openapi-docs-nestjs/TD-01`)
4. Registrar `VideosController` em `VideosModule`

**Tests:** _(empty — E2E scenarios authored in /plan-test-specs spec)_

**Dependencies:** SI-03.6, SI-03.7

**Acceptance criteria:**

- `POST /videos/upload/initiate` sem `Authorization` header retorna `401`
- `POST /videos/upload/initiate` com token válido e payload válido retorna `201` com `{ videoId, publicId, uploadId, parts }`
- `POST /videos/upload/complete` com `videoId` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`
- `POST /videos/upload/complete` com `parts.length` inválido retorna `422` com `errorCode: "UPLOAD_PART_COUNT_MISMATCH"`
- `GET /videos/:publicId/stream-url` sem autenticação retorna `200` com `{ url, expiresAt }` para vídeo `ready`
- `GET /videos/:publicId/download-url` com `publicId` inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`

---

### SI-03.9 — VideoWorkerProcessor + VideoWorkerModule

**Description:** Implementa o consumer BullMQ que processa o vídeo após upload — extrai duração via FFmpeg, gera thumbnail de um frame, faz upload do thumbnail ao MinIO e atualiza o `Video` no banco com `status: 'ready'` (ou `'failed'` após esgotar as tentativas).

**Technical actions:**

1. Criar `src/worker/video-worker.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE) VideoWorkerProcessor extends WorkerHost`; `process(job)` baixa o arquivo do MinIO via `StorageService`, executa ffprobe em uma única chamada (extrai duração em segundos + metadata completo: width, height, videoCodec, audioCodec, bitrateKbps, fps, format, sizeBytes), gera thumbnail via FFmpeg, faz upload do thumbnail via `StorageService`, atualiza `Video` (`status: 'ready'`, `duration`, `thumbnail_key`, `metadata`); em falha **sempre relança** para que BullMQ gerencie as tentativas; somente na tentativa final (`job.attemptsMade + 1 >= (job.opts.attempts ?? 1)`) atualiza `status: 'failed'` + `failure_reason = err.message` antes de relançar; processamento idempotente — re-executar o mesmo job sobrescreve `thumbnail_key` e `metadata` com segurança (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`, `### Events/Messages → process-video`)
2. Criar `src/worker/video-worker.module.ts` — importa `QueueModule` (consumer), `StorageModule`, `VideosModule`; provê `VideoWorkerProcessor`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoWorkerProcessor` | Integration: real ffprobe/ffmpeg + real MinIO — `Video.status` atualizado para `'ready'`, `duration` (inteiro > 0), `thumbnail_key` e `metadata` (width/height/codec) preenchidos; arquivo corrompido após tentativas esgotadas → `status: 'failed'`, `failure_reason` preenchido | `src/worker/video-worker.processor.integration-spec.ts` |

**Dependencies:** SI-03.3, SI-03.2, SI-03.4

**Acceptance criteria:**

- `VideoWorkerProcessor.process(job)` com `videoId` válido e arquivo presente no MinIO atualiza `Video.status` para `'ready'`, preenche `Video.duration` (integer > 0), `Video.thumbnail_key` e `Video.metadata` (objeto com width/height/codec/bitrate/fps/format/sizeBytes)
- Falha no processamento **sempre relança** (`throw`) para que BullMQ gerencie as tentativas; `Video.status` permanece `'processing'` durante tentativas intermediárias
- Somente na tentativa final (`job.attemptsMade + 1 >= job.opts.attempts`), antes de relançar, atualiza `Video.status` para `'failed'` e `Video.failure_reason` com a mensagem do erro
- Após 3 falhas consecutivas, `Video.status` é `'failed'`, `failure_reason` está preenchido e o job aparece na fila `failed` do BullMQ

---

### SI-03.10 — worker-main.ts e compilação isolada do worker (tsc --outDir dist-worker)

**Description:** Cria o segundo entry point do NestJS que inicializa apenas o `VideoWorkerModule`. O worker é compilado via `tsc --outDir dist-worker` (sem Nest CLI e sem swagger plugin) para isolar o output de `./dist` da `nestjs-api` — ver rationale em SI-03.1 action 2. O serviço `video-worker` no Compose já foi especificado em SI-03.1. (per `phase-03-videos/TD-04`)

**Technical actions:**

1. Criar `src/worker/worker-main.ts` — `NestFactory.createApplicationContext(VideoWorkerModule)` como entry point dedicado ao worker (per `phase-03-videos/TD-04`)
2. Verificar `tsconfig.build.json` — confirmar que não há `paths` aliases que requeiram `tsconfig-paths/register` ao executar `node dist-worker/worker/worker-main.js`; se houver aliases, adicionar `-r tsconfig-paths/register` ao startup command do worker em `compose.yaml`; **NÃO** adicionar `worker-main.ts` ao `nest-cli.json` (evita conflito com `deleteOutDir: true` e swagger plugin — ver SI-03.1 rationale)
3. O serviço `video-worker` no `compose.yaml` já é especificado em SI-03.1 (command `sh -c "npx tsc -p tsconfig.build.json --outDir dist-worker --declaration false --sourceMap false && node dist-worker/worker/worker-main.js"`, depends_on minio/db/redis, `restart: unless-stopped`) — nenhuma alteração adicional ao Compose neste SI

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `worker-main.ts` | Unit: `NestFactory.createApplicationContext` chamado com `VideoWorkerModule` — `NestFactory` mockado | `src/worker/worker-main.spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `docker compose exec nestjs-api npx tsc -p tsconfig.build.json --noEmit` passa sem erros TypeScript
- `docker compose exec nestjs-api npx tsc -p tsconfig.build.json --outDir dist-worker --declaration false --sourceMap false` produz `dist-worker/worker/worker-main.js` sem erros e sem `.d.ts`
- Serviço `video-worker` sobe via `docker compose up -d video-worker` sem erro
- Após `docker compose up -d`, o worker consome jobs enfileirados por `POST /videos/upload/complete` na fila `video-processing`

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated |
| public_id | varchar(12) | unique, not null — generated by `nanoid(12)` via `@BeforeInsert()` (per `phase-03-videos/TD-06`) |
| title | varchar(255) | nullable — draft records have no title at upload initiation |
| description | text | nullable |
| status | enum('draft','processing','ready','failed') | not null, default 'draft' |
| storage_key | varchar(512) | nullable — MinIO object key for the raw video file; set at upload initiation |
| upload_id | varchar(255) | nullable — S3 multipart `UploadId`; stored at initiation, cleared after `CompleteMultipartUpload` (per `phase-03-videos/TD-02`) |
| part_count | integer | nullable — number of upload parts declared at initiation; used to validate `/upload/complete` parts array length |
| duration | integer | nullable — video duration in seconds; populated by worker after processing |
| thumbnail_key | varchar(512) | nullable — MinIO object key for the generated thumbnail; populated by worker |
| metadata | jsonb | nullable — ffprobe-derived technical metadata: `{ width, height, videoCodec, audioCodec, bitrateKbps, fps, format, sizeBytes }`; populated by worker on success (traces to project-plan.md Fase 03 "extração de duração e metadados") |
| failure_reason | text | nullable — human-readable error message captured by worker on final attempt failure; populated only when `status = 'failed'` |
| channel_id | uuid | not null, FK → Channel(id) |
| created_at | timestamptz | not null, default now() |
| updated_at | timestamptz | not null, default now() |

**Relations:** `Video` belongs to `Channel` (many-to-one)
**Indexes:**
- unique on `public_id` (per `phase-03-videos/TD-06`)
- index on `channel_id`
- index on `status`

### API Contracts

#### POST /videos/upload/initiate (SI-03.8)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- channelId: string (uuid), required — channel that will own the video
- fileName: string, required — original file name (used to compose the MinIO object key)
- fileSize: integer, required — file size in bytes; max 10 737 418 240 (10 GB)
- mimeType: string, required — e.g. `video/mp4`, `video/webm`
- partCount: integer, required — number of parts to upload; each part ≥ 5 MB except the last

**Response 201:**
- videoId: string (uuid) — internal ID of the newly created draft Video record
- publicId: string — the `public_id` nanoid value of the draft Video
- uploadId: string — S3 multipart UploadId (required by `/upload/complete`)
- parts: `{ partNumber: integer, presignedUrl: string }[]` — presigned PUT URL per part (TTL: 1 h per URL)

**Error responses:**
- 403 UPLOAD_OWNERSHIP: when `channelId` does not belong to the authenticated user
- 400 validation error: when request body fails schema validation
- 500 UPLOAD_INITIATE_FAILED: when `CreateMultipartUploadCommand` fails on MinIO

---

#### POST /videos/upload/complete (SI-03.8)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- videoId: string (uuid), required — Video record created by `/upload/initiate`
- uploadId: string, required — UploadId returned by `/upload/initiate`
- parts: `{ partNumber: integer, eTag: string }[]`, required — ETags returned by MinIO for each uploaded part

**Response 200:**
- videoId: string (uuid)
- publicId: string
- status: `"processing"` — confirms the processing job has been enqueued

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `videoId` does not exist or does not belong to the authenticated user's channel
- 422 UPLOAD_PART_COUNT_MISMATCH: when `parts` array length differs from `partCount` stored at initiation
- 500 UPLOAD_COMPLETE_FAILED: when `CompleteMultipartUploadCommand` fails on MinIO
- 400 validation error: when request body fails schema validation

---

#### GET /videos/:publicId/stream-url (SI-03.8)

**Request headers:** _(none required — endpoint is public)_

**Response 200:**
- url: string — presigned GET URL for streaming; TTL: 4 hours (per `phase-03-videos/TD-05`)
- expiresAt: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not match a Video with `status: ready`

---

#### GET /videos/:publicId/download-url (SI-03.8)

**Request headers:** _(none required — endpoint is public)_

**Response 200:**
- url: string — presigned GET URL with `Content-Disposition: attachment` for forced download; TTL: 1 hour (per `phase-03-videos/TD-05`)
- expiresAt: string (ISO 8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: when `publicId` does not match a Video with `status: ready`

---

#### Validation Rules — upload endpoints

- `channelId`: required, valid UUID
- `fileName`: required, non-empty string, max 255 chars
- `fileSize`: required, integer, min 1, max 10 737 418 240
- `mimeType`: required, one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-msvideo`
- `partCount`: required, integer, min 1, max 1000
- `videoId`: required, valid UUID
- `uploadId`: required, non-empty string
- `parts[].partNumber`: required, integer ≥ 1
- `parts[].eTag`: required, non-empty string

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Channel Owner |
|----------|-----------|---------------|---------------|
| POST /videos/upload/initiate | ✗ | ✗ | ✓ |
| POST /videos/upload/complete | ✗ | ✗ | ✓ |
| GET /videos/:publicId/stream-url | ✓ | ✓ | ✓ |
| GET /videos/:publicId/download-url | ✓ | ✓ | ✓ |

### Error Catalog

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | No Video record matches the given `publicId` or `videoId`; or the video is not `status: ready` for delivery endpoints |
| UPLOAD_OWNERSHIP | 403 | Authenticated user does not own the channel referenced by `channelId` |
| UPLOAD_INITIATE_FAILED | 500 | `CreateMultipartUploadCommand` returned an error from MinIO |
| UPLOAD_COMPLETE_FAILED | 500 | `CompleteMultipartUploadCommand` returned an error from MinIO |
| UPLOAD_PART_COUNT_MISMATCH | 422 | `parts` array length in `/upload/complete` differs from `partCount` recorded at initiation |
| *(worker-internal)* PROCESSING_FAILED | n/a | FFmpeg or storage failure inside `VideoWorkerProcessor.process()`; not an HTTP error — recorded in `Video.failure_reason` after final attempt |

### Events/Messages

#### process-video

**Payload:**

```json
{ "videoId": "uuid", "storageKey": "string" }
```

**Job options:** `{ attempts: VIDEO_JOB_ATTEMPTS, backoff: { type: 'exponential', delay: VIDEO_JOB_BACKOFF_MS }, jobId: videoId }` — `jobId` pins the BullMQ job ID to the video UUID, ensuring at-most-one queued job per video (idempotent re-enqueue; a second `completeUpload` call for the same video would find the job already in the queue). Values are read from `queueConfig` (`queue.config.ts`), which exposes:
- `VIDEO_JOB_ATTEMPTS` — number of attempts before the job is failed (default: `3`)
- `VIDEO_JOB_BACKOFF_MS` — base exponential backoff delay in ms (default: `5000`); set to `200` in `.env` for fast test iterations

**Producer:** `VideosService` (per `phase-03-videos/TD-03`)
**Consumer:** `VideoWorkerProcessor` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-04`)
**Trigger:** `POST /videos/upload/complete` — after `CompleteMultipartUploadCommand` succeeds; job is enqueued before the HTTP response is returned
**Delivery semantics:** at-least-once — BullMQ attempts controlled by `VIDEO_JOB_ATTEMPTS` (default 3), exponential backoff starting at `VIDEO_JOB_BACKOFF_MS` (default 5 s); worker must be idempotent (per `phase-03-videos/TD-03`)
**Retry contract:** processor always rethrows on failure so BullMQ drives retries; `Video.status` stays `'processing'` during intermediate attempts; only on the final attempt does the processor set `status: 'failed'` + `failure_reason` before rethrowing

## Dependency Map

```
SI-03.1 (root — infra: Compose, npm, config factories)
├── SI-03.2 — depends on SI-03.1 (storage.config necessário para S3Client)
│   └── SI-03.5 — depends on SI-03.2 + SI-03.4 (StorageService + Video entity)
│       ├── SI-03.6 — depends on SI-03.5 + SI-03.3 (completeUpload usa InjectQueue)
│       │   └── SI-03.8 — depends on SI-03.6 + SI-03.7 (controller precisa de todos os métodos do service)
│       └── SI-03.7 — depends on SI-03.5 (delivery methods expandem VideosService)
│           └── SI-03.8 (same — join point)
└── SI-03.3 — depends on SI-03.1 (queue.config necessário para BullMQ)
    └── SI-03.9 — depends on SI-03.3 + SI-03.2 + SI-03.4 (worker precisa de queue, storage e entity)
        └── SI-03.10 — depends on SI-03.9 (entry point precisa do VideoWorkerModule)

SI-03.4 (root — Video entity, independente de config)
```

## Deliverables

- [ ] SI-03.1 — Infra: Docker Compose (MinIO + Redis), npm packages e config factories
- [ ] SI-03.2 — StorageModule: S3Client provider e StorageService
- [ ] SI-03.3 — QueueModule: BullMQ setup e configuração
- [ ] SI-03.4 — Video entity, migration e nanoid public_id
- [ ] SI-03.5 — VideosService: upload initiate
- [ ] SI-03.6 — VideosService: upload complete e enqueue job
- [ ] SI-03.7 — VideosService: stream URL e download URL
- [ ] SI-03.8 — VideosController: endpoints de upload e delivery
- [ ] SI-03.9 — VideoWorkerProcessor + VideoWorkerModule
- [ ] SI-03.10 — worker-main.ts e compilação isolada do worker (tsc --outDir dist-worker)

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Backend E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] TypeScript compiles cleanly (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)

<!-- phase-a-complete -->
