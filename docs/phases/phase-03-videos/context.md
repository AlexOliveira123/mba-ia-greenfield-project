---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-31T16:02:12-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-02T13:41:27-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-10-31T16:02:12-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-31T16:02:12-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-31T16:02:12-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-10-31T16:02:12-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-31T16:02:12-03:00"
  .claude/skills/testing-guide-next-frontend/SKILL.md: "2026-10-31T16:02:12-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-02T13:16:47-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project/` — primary backend: object storage integration, upload endpoints, queue module, video worker entry point, streaming/download endpoints, Video entity with `public_id`.
- `next-frontend/` — upload UI (BFF Route Handlers + upload client component) and delivery URL display shaped by TD-02 and TD-05 (cross-layer). No new architectural FE TDs — upload form reuses the Phase 02 form pattern (`react-hook-form` + Zod + BFF Route Handler).

**Deferred subprojects:** _None._

**Sequencing notes:** Depends on Fase 01 (base config) and Fase 02 (auth, user/channel entities).

**Neighbors (for boundary detection only):**

- **Phase 02 — auth-frontend:** Cadastro, Login e Gerenciamento de Conta — delivers authenticated user session; Phase 03 upload flow depends on authenticated channel ownership.
- **Phase 04 — Gerenciamento de Vídeos e Canal:** video metadata editing, draft → publish flow, management panel — operates on the draft Video records created by Phase 03.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Object Storage Service | decided | A (MinIO) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Upload Protocol for Large Files (≤10GB) | decided | B (S3 Multipart with presigned part URLs) | — |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Background Job Queue | decided | A (BullMQ + @nestjs/bullmq) | @nestjs/bullmq, bullmq |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Repo-wide | Video Worker Architecture | decided | C (same codebase, separate entry point + Docker service) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Cross-layer | Video Delivery Strategy (Streaming & Download) | decided | B (time-limited presigned GET URLs) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video Identifier (Public URL Slug) | decided | B (nanoid, separate public_id column) | nanoid |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-01 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-03, phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** **Option A (MinIO)** — S3-compatible API means `@aws-sdk/client-s3` code is identical in dev and production (only endpoint, bucket, and credentials change via the namespaced config). All of Phase 03's upload and delivery patterns — presigned multipart URLs, presigned GET URLs, Range requests — work against MinIO exactly as against S3. Option B forecloses the scalable upload and delivery patterns required for 10GB files. Option C introduces cloud cost and network latency into daily development.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

**Revisions (2026-11-02, Rev 1):** Docker Hub `minio/minio` and `minio/mc` images discontinued (pull access denied). Replacement MinIO server: `cgr.dev/chainguard/minio@sha256:0a01100085e30fb08d2f39e39c9f5c9d83a95707f220b007d813b690cd41622d`, pinned by digest. Chainguard image runs as UID 65532 — `minio-data` must be a named Docker volume. `MINIO_PUBLIC_ENDPOINT` added (defaults to `MINIO_ENDPOINT` when unset); used exclusively by the public S3Client instance for `getSignedUrl` calls. The `localstack:2.3.2` switch in SI-03.2 was undocumented drift; this Revision formalizes the revert to MinIO. Env defaults revert to `http://minio:9000`.

**Revisions (2026-11-02, Rev 2, amended):** `cgr.dev/chainguard/minio` distroless → no healthcheck; `cgr.dev/chainguard/minio-client` lacks `mc cors` → dropped; `storage-init` service dropped (fresh-clone deadlock: bind-mount `node_modules` empty on clone → `npx ts-node` fails → `nestjs-api` blocked). Bucket bootstrap moved to `StorageService.ensureBucket()` / `onModuleInit` — both api and worker guarantee bucket on startup. `video-worker` gains `restart: unless-stopped` + `sh -c "npx tsc -p tsconfig.build.json --outDir dist-worker --declaration false --sourceMap false && node dist-worker/worker/worker-main.js"` for self-recovery (isolated output dir avoids race with `nestjs-api`'s `dist/`). `MINIO_API_CORS_ALLOW_ORIGIN=*` **verified working** on Chainguard image — OPTIONS preflight returns `Access-Control-Allow-Origin: *`; PUT exposes `ETag` in `Access-Control-Expose-Headers` (gated by `storage.service.integration-spec.ts`; see `progress.md § Post-implementation fixes`). `compose.yaml` replaces `localstack` with `minio` only.

### phase-03-videos/TD-02

**Recommendation:** **Option B (S3 Multipart with presigned part URLs)** — Satisfies both the performance requirement (bytes bypass NestJS) and the resumability requirement (part-level resume via stored `uploadId`). The orchestration is bounded (3 API calls) and each call follows the existing BFF Route Handler → NestJS pattern. Unlike Option C, no new protocol or raw HTTP handler is needed, and the strict BFF model is not strained (no extra public env key required). Option A is disqualified by the explicit resume requirement. Option C is viable and provides better client-side resume ergonomics, but creates tension with the strict BFF model (upload endpoint URL must be browser-reachable) and adds protocol learning overhead; recommend if the team prioritizes zero-client-state resume over implementation simplicity.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** **Option A (BullMQ + @nestjs/bullmq)** — The official NestJS module provides DI-integrated decorator-based processors that align with the project's conventions. Redis is a small, well-understood service to add to the Compose stack. Option B is architecturally elegant (no new service) but the absence of a first-class NestJS integration means writing custom lifecycle boilerplate that BullMQ provides out of the box. Option C is overkill for a single-queue pipeline.

**Libraries:** `@nestjs/bullmq`, `bullmq`

### phase-03-videos/TD-04

**Recommendation:** **Option C (same codebase, separate entry point + Docker service)** — Achieves the architecture diagram's worker-as-separate-container requirement without code duplication or premature monorepo restructuring. The worker entry point is a small file (`src/worker-main.ts`); the Compose change is one service block. Option A is rejected because CPU contention between HTTP handling and FFmpeg is a real concern for a video platform even in development. Option B's setup cost is disproportionate to Phase 03 when the entities are still being created.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** **Option B (time-limited presigned URLs)** — NestJS is not designed to be a streaming media server; proxying 10GB video streams through Node.js creates a bottleneck that degrades all other API traffic. Presigned URLs are the industry-standard pattern for object-storage-backed video platforms. The URL expiry concern is manageable: generate URLs with a TTL covering a full playback session (4 hours) or generate fresh URLs on each page render via the BFF. Option A's binary proxy is an architectural anti-pattern for video streaming at this scale. Option C is premature infrastructure for Phase 03.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** **Option B (nanoid)** — Short, URL-safe public IDs are the industry standard for video platforms (YouTube: 11 chars). The `public_id` column adds minimal implementation cost while producing significantly better public URLs than raw UUIDs. Option C is disqualified by the Phase 03 draft model: videos are pre-registered without titles, so a title-derived slug cannot be generated at upload initiation. Option A works but produces poor public-facing URLs for a user-facing platform.

**Libraries:** `nanoid`

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive.

**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome without a per-render `/auth/me` round-trip. Option C rejected: solves a problem the project does not have at the cost of infrastructure the project does not own.

**Libraries:** `iron-session`

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh). Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving.

**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited. (2) **Aligned with shadcn's canonical form primitive** — `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm.

**Libraries:** `react-hook-form`, `@hookform/resolvers`

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend-msw-foundation` was authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking.

**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price for the structural benefits. Option C rejected.

**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused). (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level. Option B's Route-Handler-as-link-target adds redirects for no clean gain.

**Libraries:** —

### next-frontend-config-base/TD-01

**Recommendation:** Option A (Zod 4). Three converging reasons: (1) **Type-inference matches the FE's strict-TS culture** — `lib/env.ts` exports a typed `env` object with no `as` casts. (2) **Ecosystem gravity in Next.js / React 19** — Zod is the de-facto schema language for App Router (Server Actions inputs, form resolvers, future contract validation). (3) **Direct enablement of TD-02 Option A (`@t3-oss/env-nextjs`)** — t3-env's first-citizen validator.

**Libraries:** `zod`

### next-frontend-config-base/TD-02

**Recommendation:** Option A (`@t3-oss/env-nextjs`). The only option that combines (i) type-level NEXT_PUBLIC_ prefix enforcement, (ii) runtime Proxy-based leak detection, and (iii) single-file, single-import-path consumer ergonomics. Option B reaches roughly the same structural outcome at higher implementation and maintenance cost, with weaker guarantees.

**Libraries:** `@t3-oss/env-nextjs`

### next-frontend-config-base/TD-03

**Recommendation:** Option A (Strict BFF — single server-only `API_URL`). Aligned with the BFF testing strategy and architectural commitment already documented in `next-frontend/CLAUDE.md` (Route Handlers as the only NestJS caller; BFF tests stub `fetch` via MSW). Eliminates CORS, eliminates public exposure of the backend URL, and produces the smallest correct foundation.

**Libraries:** —

### next-frontend-msw-foundation/TD-01

**Recommendation:** Option B (per-domain modules + barrel). Three reasons. (1) MSW's own best-practice recommends it. (2) Domain ownership tracks the codebase, not the project plan. (3) Append-only growth with minimal merge conflicts — each phase touches a new file plus one line in the barrel.

**Libraries:** —

### next-frontend-msw-foundation/TD-02

**Recommendation:** Option A (test-only, `setupServer` only at the foundation). The browser worker is a future capability with no documented current consumer; wiring it now is speculative investment, and wiring it incoherently actively misleads developers. Option A keeps the foundation minimal, aligns 1:1 with everything CLAUDE.md and existing rules document, and is non-breaking to extend.

**Libraries:** —

### next-frontend-msw-foundation/TD-03

**Recommendation:** Option D (hand-written defaults as the default + opt-in seeded faker for bulk collections). Option B's determinism + readability is the right baseline for Phase 02 single-record fixtures. Bulk-collection cases will arrive (Phase 07 home page grid, Phase 06 comment threads) so keeping faker available as a scoped tool is pragmatic. Per-fixture local seeding eliminates the global-cursor pitfall.

**Libraries:** —

### next-frontend-msw-foundation/TD-04

**Recommendation:** Option A (universal handler set + `server.use(...)` overrides + `onUnhandledRequest: "error"`). The "import only what it needs" requirement is satisfied at the authoring layer by TD-01. At the runtime layer, loading all handlers is the canonical MSW v2 model. `onUnhandledRequest: "error"` enforces that a phase's test cannot accidentally invoke a route outside its scope.

**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** Option A (`openapi-typescript` + `openapi-fetch`). Three reinforcing reasons. (1) Strict BFF makes the SDK surface valueless on the client — only Route Handlers ever call the upstream Nest. (2) Types-first matches the rest of the FE foundation. (3) MSW typing is solved by the same `paths` symbol — hand-written handlers type their resolver returns off `paths["/videos"]["get"]["responses"][200]`.

**Libraries:** `openapi-typescript`, `openapi-fetch`

### next-frontend-openapi-typing/TD-02

**Recommendation:** Option B (committed local copy + repo-root sync script). Three reasons. (1) Preserves compose-stack independence. (2) Drift is eliminated structurally when paired with TD-03's CI freshness check. (3) The committed local file is a real artifact in PR review — reviewers see the contract change in `next-frontend/openapi.json`'s diff at the same time as the backend change.

**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** Option C (committed + CI freshness check). The only option that makes contract drift both visible (in PR diffs) and impossible to merge accidentally (CI fail). The complexity premium over Option A is one CI step.

**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** Option A (single `lib/api/contracts.ts` with explicit aliases). The only option that (i) handles pass-through and reshape with the same mechanism, (ii) gives a single grep target for "what shape does the BFF expose", and (iii) decouples Component imports from App Router file paths. Make `lib/api/contracts.ts` the only file that imports `paths` from `types.gen.ts`; every other consumer imports from `contracts.ts`.

**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** Option A (hand-written, typed via `paths`). Reasons: (1) Determinism over auto-generation — BFF integration tests assert on specific values. (2) Coherence with TD-01 recommendation — `openapi-typescript`'s `paths` type is the single contract anchor; reusing it in MSW handlers means "spec ↔ handler ↔ assertion" is one type chain. (3) Scale fit — Phase 02 introduces few endpoints; the manual cost is negligible.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** `@nestjs/swagger`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI").

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per rows above. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Tela do player de vídeo (controles play/pause/volume, barra de progresso, layout com sidebar de sugestões) | deferred | Full player UI belongs to Fase 05 — Página de Visualização do Vídeo. Phase 03 delivers the backend delivery endpoints (presigned stream/download URLs) only; the client `<video src>` wiring and player chrome are Phase 05. | phase-03-videos/TD-05 |
| Edição de título, descrição, categoria e thumbnail do vídeo | deferred | Metadata editing is a Fase 04 capability. Phase 03 pre-registers draft records without title; full metadata editing belongs to Phase 04. | — |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`, and to `testing-guide-next-frontend` for `next-frontend/`. Phase 03 introduces new entities, services with branching logic, configured modules (BullMQ, storage), a second NestJS entry point, and BFF Route Handlers — each layer is exercised per the respective testing guide's pyramid. Key artifact coverage by layer:

**`nestjs-project/`**

| Artifact | Layer |
|---|---|
| `Video` entity (`public_id` unique index, status enum defaults) | Integration (real DB) |
| `StorageService` (MinIO SDK calls: presign, multipart, complete) | Integration (MinIO container) or unit with mocked `S3Client` |
| `VideosService` (upload initiate, upload complete, branching) | Unit (mocked repos) + Integration (DB contract) |
| `VideoWorkerProcessor` (FFmpeg jobs, thumbnail, DB status update) | Integration |
| `StorageModule`, `QueueModule`, `VideoWorkerModule` | Unit (compilation) |
| `VideosController` | E2E only |
| `UploadInitiateDto`, `UploadCompleteDto` | E2E (ValidationPipe wiring per endpoint) |

**`next-frontend/`**

| Artifact | Layer |
|---|---|
| BFF Route Handlers: `initiate-upload/route.ts`, `complete-upload/route.ts` | Integration (Vitest + MSW, typed via `paths`) |
| Upload client component (`"use client"`, file picker, progress bar, retry) | Unit (Vitest + jsdom docblock) |
| Video delivery URL Route Handlers (`stream-url/route.ts`, `download-url/route.ts`) | Integration (Vitest + MSW) |
| Full upload → processing → playback flow | E2E (Playwright, once installed) |

Specific layer coverage by implementation item (SI) is recorded in `progress.md`.
