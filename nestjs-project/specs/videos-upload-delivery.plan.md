---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: test/videos-upload-delivery.e2e-spec.ts
---

# Videos Upload & Delivery Test Plan

## Application Overview

This test plan covers the four REST endpoints of the video upload and delivery cycle:
`POST /videos/upload/initiate` (creates a draft video + returns presigned multipart part URLs),
`POST /videos/upload/complete` (seals the multipart upload + enqueues the processing job),
`GET /videos/:publicId/stream-url` (returns a short-lived presigned GET URL for playback),
and `GET /videos/:publicId/download-url` (returns a short-lived presigned GET URL with
`Content-Disposition: attachment` for forced download). The two POST endpoints require a
valid JWT (channel owner); the two GET endpoints are public.

## Test Scenarios

### 1. POST /videos/upload/initiate

**Setup:** `beforeAll` bootstrap NestJS test application (`Test.createTestingModule`). `beforeEach` truncate `videos`, `channels`, `users` tables; seed one `User` + one `Channel` owned by that user; generate a valid JWT for the user.

#### 1.1. unauthenticated-initiate-returns-401

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-01T02:28:53Z

**Steps:**
  1. POST /videos/upload/initiate com body `{ "channelId": "<seeded-channel-id>", "fileName": "video.mp4", "fileSize": 52428800, "mimeType": "video/mp4", "partCount": 1 }` sem `Authorization` header
    - expect: HTTP 401

#### 1.2. valid-initiate-returns-201-with-upload-data

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-01T02:28:53Z

**Steps:**
  1. POST /videos/upload/initiate com `Authorization: Bearer <valid-jwt>` e body `{ "channelId": "<seeded-channel-id>", "fileName": "video.mp4", "fileSize": 52428800, "mimeType": "video/mp4", "partCount": 1 }`
    - expect: HTTP 201
    - expect: response body contém campo `videoId` (string no formato UUID)
    - expect: response body contém campo `publicId` (string de 12 caracteres)
    - expect: response body contém campo `uploadId` (string não-vazia)
    - expect: response body contém campo `parts` (array com 1 elemento)
    - expect: `parts[0].partNumber === 1`
    - expect: `parts[0].presignedUrl` é uma string URL contendo `X-Amz-Signature` no query string

### 2. POST /videos/upload/complete

**Setup:** `beforeEach` truncate `videos`, `channels`, `users`; seed `User` + `Channel` + draft `Video` (status: `'draft'`, `upload_id` preenchido com valor arbitrário, `storage_key` preenchido); gerar JWT do dono do canal.

#### 2.1. nonexistent-video-returns-404

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-01T02:28:53Z

**Steps:**
  1. POST /videos/upload/complete com `Authorization: Bearer <valid-jwt>` e body `{ "videoId": "00000000-0000-0000-0000-000000000000", "uploadId": "fake-upload-id", "parts": [{ "partNumber": 1, "eTag": "\"abc123\"" }] }` (videoId não existe no banco)
    - expect: HTTP 404
    - expect: response body contém `errorCode === "VIDEO_NOT_FOUND"`

#### 2.2. invalid-parts-count-returns-422

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-01T02:28:53Z

**Steps:**
  1. Usar o `videoId` do `Video` em draft seedado com `partCount: 2` (seeded with `upload_id` reflecting a 2-part multipart upload)
  2. POST /videos/upload/complete com `Authorization: Bearer <valid-jwt>` e body `{ "videoId": "<seeded-video-id>", "uploadId": "<seeded-upload-id>", "parts": [{ "partNumber": 1, "eTag": "\"abc123\"" }] }` (apenas 1 parte enviada; o initiate registrou 2)
    - expect: HTTP 422
    - expect: response body contém `errorCode === "UPLOAD_PART_COUNT_MISMATCH"`

### 3. GET /videos/:publicId/stream-url

**Setup:** `beforeEach` truncate `videos`, `channels`, `users`; seed `User` + `Channel` + `Video` com `status: 'ready'` e `storage_key` válido (ex: `"videos/test-key.mp4"`).

#### 3.1. anonymous-ready-video-returns-stream-url

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-01T02:28:53Z

**Steps:**
  1. GET /videos/<seeded-video-publicId>/stream-url sem `Authorization` header
    - expect: HTTP 200
    - expect: response body contém campo `url` (string não-vazia)
    - expect: response body contém campo `expiresAt` (string ISO 8601)
    - expect: `url` contém `X-Amz-Expires=14400` no query string (TTL 4h per `phase-03-videos/TD-05`)

### 4. GET /videos/:publicId/download-url

**Setup:** `beforeEach` truncate `videos`, `channels`, `users`; seed `User` + `Channel` + `Video` com `status: 'ready'`.

#### 4.1. nonexistent-public-id-returns-404

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-01T02:28:53Z

**Steps:**
  1. GET /videos/nonexistent-public-id/download-url (publicId não existe no banco)
    - expect: HTTP 404
    - expect: response body contém `errorCode === "VIDEO_NOT_FOUND"`
