# Video Pipeline Map

> Generated for P6.1. This document drives P6.2-P6.5 migration tasks.

---

## 1. Recording Flow

### 1.1 Browser Extension Recording

**Key file:** `apps/browser-extension/src/offscreen/recorder.ts`

The extension uses a Chrome Manifest V3 **offscreen document** to run `MediaRecorder` (service workers cannot access media APIs).

**Capture modes** (line 1-7):
- `picker` -- calls `navigator.mediaDevices.getDisplayMedia()` directly
- `desktop` -- calls `navigator.mediaDevices.getUserMedia()` with `chromeMediaSource: "desktop"` using a `streamId` from `chrome.desktopCapture.chooseDesktopMedia()`
- `silent-tab` -- calls `getUserMedia` with `chromeMediaSource: "tab"`

**Codec selection** (`pickMimeType()`, lines 42-49):
```
Candidates (first supported wins):
  1. video/webm;codecs=vp9,opus
  2. video/webm;codecs=vp8,opus
  3. video/webm
  4. video/mp4
```

**Resolution** (lines 89-93): `{ width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } }` for picker mode. Desktop/tab modes take whatever the OS provides.

**Bitrate** (line 155): `videoBitsPerSecond: 3_000_000` (3 Mbps). No explicit `audioBitsPerSecond`.

**Audio mixing** (lines 115-145): An `AudioContext` at 48000 Hz sample rate mixes display audio and optional mic audio into a single destination stream. In `silent-tab` mode, display audio is also routed to `audioCtx.destination` (audible playback).

**Chunk interval** (line 175): `recorder.start(1000)` -- emits chunks every 1 second.

**Chunk handling** (`ondataavailable`, lines 157-170): Each chunk is read as `ArrayBuffer`, converted to `Uint8Array`, then sent as a plain `Array<number>` via `chrome.runtime.sendMessage` with type `RECORDER_CHUNK`.

### 1.2 Web Recorder Recording

**Key files:**
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-constants.ts`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/web-recorder-utils.ts`
- `apps/web/app/(org)/dashboard/caps/components/web-recorder-dialog/useWebRecorder.ts`

**Codec/format candidates** (constants file, lines 103-117):
```
MP4_MIME_TYPES = {
  withAudio: [
    'video/mp4;codecs="avc1.42E01E,mp4a.40.2"'   (H.264 Baseline + AAC)
    'video/mp4;codecs="avc1.4d401e,mp4a.40.2"'   (H.264 Main + AAC)
  ],
  videoOnly: [
    'video/mp4;codecs="avc1.42E01E"'
    'video/mp4;codecs="avc1.4d401e"'
    "video/mp4"
  ],
}

WEBM_MIME_TYPES = {
  withAudio: ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus"],
  videoOnly: ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"],
}
```

**Pipeline selection** (`selectRecordingPipelineFromSupport` in `web-recorder-utils.ts`):
- **Chromium browsers** (Chrome, Edge, Opera, Brave): tries WebM first. If supported, uses `streaming-webm` pipeline (progressive multipart upload while recording). VP9+Opus preferred, VP8+Opus fallback.
- **Firefox / Safari**: skips streaming WebM, tries MP4 (H.264+AAC via `avc1` codecs). Falls back to buffered WebM if MP4 not supported.
- Two pipeline modes:
  - `streaming-webm`: `supportsProgressiveUpload: true` -- chunks uploaded in real-time
  - `buffered-raw`: `supportsProgressiveUpload: false` -- entire recording buffered, then converted to MP4 via `@remotion/webcodecs` (WebAssembly), then uploaded

**Resolution** (constants, lines 33-37; useWebRecorder.ts lines 712-714):
- Display capture: `{ frameRate: { ideal: 30 }, width: { ideal: 1920 }, height: { ideal: 1080 } }`
- Camera-only: same 1920x1080
- Permission check preview (useMediaPermission.ts line 17): `{ width: { ideal: 1280 }, height: { ideal: 720 } }`

**Bitrate**: No `videoBitsPerSecond` set on web recorder -- browser chooses its own bitrate. (The 3 Mbps setting is extension-only.)

**Chunk interval** (useWebRecorder.ts, lines 1050-1069):
- Streaming pipeline: `recorder.start(1000)` (1s timeslice). Falls back to manual `recorder.requestData()` every 1000ms.
- Buffered pipeline: `recorder.start(200)` (200ms timeslice for local backup granularity).

**Audio mixing** (useWebRecorder.ts, lines 914-941): When both system audio and mic are present, an `AudioContext` with a `DynamicsCompressor` limiter mixes them (threshold: -3 dBFS, ratio: 20:1).

**Post-stop (buffered pipeline only):** `convertToMp4()` in `recording-conversion.ts` uses `@remotion/webcodecs` to re-encode WebM to MP4 with `videoCodec: "h264"` and `audioCodec: "aac"`.

### 1.3 Format/Codec Summary

| Path | Format | Codec | Notes |
|------|--------|-------|-------|
| Extension (offscreen recorder) | WebM (preferred) / MP4 (fallback) | VP9+Opus / VP8+Opus / MP4 | 3 Mbps video bitrate |
| Web recorder -- Chrome/Edge | WebM | VP9+Opus / VP8+Opus | streaming pipeline |
| Web recorder -- Safari/Firefox | MP4 | H.264 (avc1) + AAC | buffered, then remotion WebCodecs conversion |
| Upload subpath (extension) | `.mp4` | (server transcodes) | Content-type sent as `video/webm` |

---

## 2. Upload Flow

### 2.1 Architecture Overview

Three upload paths feed into a unified S3 key pattern: `{userId}/{videoId}/{subpath}`. All paths create a `videos` row and optionally a `video_uploads` progress row.

### 2.2 Upload API Routes

**Entry point:** `apps/web/app/api/upload/[...route]/route.ts`

A Hono app mounts three sub-routers:

#### Multipart Upload (`apps/web/app/api/upload/[...route]/multipart.ts`)

S3 key: `{userId}/{videoId}/{subpath}` (default subpath: `result.mp4`). Raw uploads use `raw-upload.*`.

- **POST `/api/upload/multipart/initiate`** -- verifies video ownership, upserts `video_uploads` row with `mode: "multipart"`, calls `bucket.multipart.create(fileKey)`. Returns `{ uploadId }`.
- **POST `/api/upload/multipart/presign-part`** -- returns `{ presignedUrl }` for a specific part number.
- **POST `/api/upload/multipart/complete`** -- completes multipart, verifies via `headObject` (3 retries). Two branches:
  - **Raw upload** (subpath starts `raw-upload.`): updates metadata, calls `startVideoProcessingWorkflow`
  - **Regular** (`result.mp4`): copies object to fix S3 metadata, updates `videos`, deletes `video_uploads` row; if media server available, POSTs to `{MEDIA_SERVER_URL}/video/process` for faststart remux
- **POST `/api/upload/multipart/abort`** -- aborts upload and deletes `video_uploads` row

#### Signed/Presigned Upload (`apps/web/app/api/upload/[...route]/signed.ts`)

- **POST `/api/upload/signed/`** -- returns a presigned POST or PUT URL. Detects content type from extension.
- **POST `/api/upload/signed/batch`** -- batch presign for up to 50 subpaths. Used by desktop HLS segment recorder.

#### Recording Complete (`apps/web/app/api/upload/[...route]/recording-complete.ts`)

- **POST `/api/upload/recording-complete/`** -- for `desktopSegments` source, queues `queueDesktopSegmentsFinalization()` to mux HLS segments. For other sources, no-op.

### 2.3 Server Actions

**`apps/web/actions/video/upload.ts` (line 109) -- `createVideoAndGetUploadUrl`** (web recorder path):
1. Authenticates user; throws `"upgrade_required"` if free user and duration > 300s
2. Calls `requireOrganizationAccess()` and `checkUploadQuota()`
3. If `videoId` provided and video exists: returns presigned re-upload URL
4. Otherwise generates `videoId = nanoId()`
5. S3 key: `{userId}/{videoId}/result.mp4` (or `screenshot/screen-capture.jpg`)
6. Gets presigned URL via `StorageService.createUploadTargetForUser()`
7. Inserts into `videos`: `{ source: { type: "webMP4" }, bucket, storageIntegrationId, public, folderId }`
8. Inserts into `video_uploads`: `{ videoId, total: fileSize ?? 0 }`
9. Creates a `cap.link` short link via Dub (production only)
10. Returns `{ id, presignedPostData, uploadTarget }`

**`apps/web/actions/video/create-for-processing.ts` (line 33) -- `createVideoForServerProcessing`** (file import path):
1. Generates `videoId = nanoId()`
2. Raw key: `{userId}/{videoId}/raw-upload.mp4`
3. Gets a `PUT` presigned URL
4. Inserts into `videos`: `{ source: { type: "webMP4" } }`
5. Inserts into `video_uploads`: `{ mode: "singlepart", phase: "uploading", processingProgress: 0, rawFileKey }`
6. Client XHRs the file, then calls `triggerVideoProcessing()` which fires `startVideoProcessingWorkflow`

### 2.4 Extension Upload Flow

**Files:** `apps/browser-extension/src/background/sw.ts`, `apps/browser-extension/src/background/upload.ts`

1. `initializeUpload()` -- calls `GET /api/desktop/video/create`, then `POST /api/upload/multipart/initiate` with `contentType: "video/webm"` and `subpath: "result.mp4"`
2. `handleChunk(chunk)` -- buffers chunks in memory; flushes at `MIN_PART_SIZE = 5 * 1024 * 1024` (5 MB) via presigned PUT
3. `finalizeUpload()` -- uploads final partial chunk, calls multipart complete, then recording-complete
4. Retry logic: exponential backoff (1/4/16/64/256s), 6 attempts, Chrome notification on dead-letter

### 2.5 Web Recorder Chunk Handling

Each `ondataavailable` chunk simultaneously:
1. Stored in `recordedChunksRef` (in-memory fallback)
2. Persisted to IndexedDB via `RecordingSpool` (crash recovery, max 32 MB pending)
3. If streaming pipeline: fed to `InstantRecordingUploader.handleChunk()` which buffers until 5 MB and uploads via presigned multipart PUT (max 3 parallel parts, 30s stall timeout, 3 retry attempts)

Max in-flight upload buffer: 128 MB (`MAX_PENDING_UPLOAD_BYTES`). If exceeded, recording stops automatically.

### 2.6 S3 Key Patterns

```
{userId}/{videoId}/{subpath}
```

| Subpath | Used for |
|---------|----------|
| `result.mp4` | Web recorder, extension final output |
| `raw-upload.mp4` | File import (server-processed) |
| `screenshot/screen-capture.jpg` | Screenshots / thumbnails |
| `preview/animated-preview.gif` | Generated animated preview |
| `segments/video/init.mp4` | Desktop segment video init |
| `segments/video/segment_NNN.m4s` | Desktop segment video chunks |
| `segments/audio/init.mp4` | Desktop segment audio init |
| `segments/audio/segment_NNN.m4s` | Desktop segment audio chunks |
| `segments/manifest.json` | Desktop segment manifest |
| `output/video_recording_000.m3u8` | Legacy MediaConvert HLS |
| `combined-source/stream.m3u8` | Legacy local HLS |

**Env vars:** `CAP_AWS_BUCKET`, `CAP_AWS_REGION`, `CAP_AWS_ACCESS_KEY`, `CAP_AWS_SECRET_KEY`, `CAP_AWS_ENDPOINT`, `CAP_AWS_BUCKET_URL`. Optional CloudFront via `CLOUDFRONT_KEYPAIR_ID` / `CLOUDFRONT_KEYPAIR_PRIVATE_KEY`.

---

## 3. Storage Model

### 3.1 Storage Modes by Source Type

| Source type | Storage pattern | Notes |
|---|---|---|
| `desktopSegments` | Separate audio + video `.m4s` segments, muxed to `result.mp4` after recording | Desktop app live recording |
| `desktopMP4` | Single `result.mp4` | Desktop app single-file |
| `webMP4` | Single `result.mp4` (or `raw-upload.mp4` then processed) | Web recorder |
| `extensionWeb` | Single `result.mp4` | Browser extension |
| `MediaConvert` | HLS at `output/video_recording_000.m3u8` + `.ts` segments | LEGACY |
| `local` | HLS at `combined-source/stream.m3u8` + `.ts` segments | LEGACY |

### 3.2 `videos` Table Schema

Defined in `packages/database/schema.ts` lines 334-419:

| Column | Type | Notes |
|---|---|---|
| `id` | nanoId (varchar 15) PK | typed as `Video.VideoId` |
| `ownerId` | nanoId NOT NULL | FK to users |
| `orgId` | varchar 15 NOT NULL | FK to organizations |
| `name` | varchar 255 NOT NULL | default "My Video" |
| `bucket` | nanoId nullable | FK to `s3_buckets` (custom S3 bucket) |
| `storageIntegrationId` | nanoId nullable | FK to `storage_integrations` (Google Drive etc.) |
| `duration` | float | in seconds |
| `width` | int | |
| `height` | int | |
| `fps` | int | |
| `metadata` | JSON | `VideoMetadata` type (resolution, framerate) |
| `public` | boolean NOT NULL | default true |
| `settings` | JSON | per-video overrides: disableSummary, disableCaptions, etc. |
| `transcriptionStatus` | varchar | `PROCESSING`, `COMPLETE`, `ERROR`, `SKIPPED`, `NO_AUDIO` |
| `source` | JSON NOT NULL | discriminated union: `MediaConvert`, `local`, `desktopMP4`, `desktopSegments`, `webMP4`, `extensionWeb` |
| `folderId` | nanoId nullable | FK to folders |
| `createdAt` | timestamp NOT NULL | |
| `effectiveCreatedAt` | datetime GENERATED | coalesces `metadata.customCreatedAt` or `createdAt` |
| `updatedAt` | timestamp NOT NULL | |
| `password` | encryptedText nullable | password-protected videos |
| `xStreamInfo` | text | LEGACY HLS stream info |
| `isScreenshot` | boolean NOT NULL | default false |
| `skipProcessing` | boolean NOT NULL | default false |
| `awsRegion` | varchar | DEPRECATED |
| `awsBucket` | varchar | DEPRECATED |
| `videoStartTime` | varchar | DEPRECATED |
| `audioStartTime` | varchar | DEPRECATED |
| `jobId` | varchar | DEPRECATED |
| `jobStatus` | varchar | DEPRECATED |

### 3.3 `video_uploads` Table

Defined in `packages/database/schema.ts` line 1152:

| Column | Type | Notes |
|---|---|---|
| `video_id` | PK, FK to `videos.id` | One row per in-progress upload |
| `uploaded` / `total` | bigint bytes | Progress tracking |
| `mode` | `"singlepart"` or `"multipart"` | |
| `phase` | enum | `uploading`, `processing`, `generating_thumbnail`, `complete`, `error` |
| `processing_progress` | int 0-100 | |
| `raw_file_key` | varchar(512) | Set for server-processed uploads |

Row is deleted on multipart complete for non-raw uploads.

### 3.4 Separate Audio/Video Tracks

Only for **`desktopSegments`** source: the desktop app uploads separate video and audio track segments independently. The `SegmentsSource` class (`packages/web-domain/src/Video.ts` lines 154-179) exposes `getVideoInitKey()`, `getAudioInitKey()`, `getVideoSegmentKey(index)`, `getAudioSegmentKey(index)`. These are later muxed by the media server.

All other source types are single-track files.

### 3.5 Thumbnails and Previews

Stored in S3 with fixed paths:
- **Static thumbnail:** `{ownerId}/{videoId}/screenshot/screen-capture.jpg`
- **Animated preview GIF:** `{ownerId}/{videoId}/preview/animated-preview.gif`

The media server generates both during processing and uploads via presigned PUT URLs.

The `GET /api/thumbnail?videoId=...` endpoint (`apps/web/app/api/thumbnail/route.ts` lines 54-56) lists objects under `{ownerId}/{videoId}/` and finds the first key ending in `screen-capture.jpg`.

### 3.6 Custom S3 Buckets

`s3_buckets` table (`schema.ts` lines 628-657): stores per-user/org custom S3 credentials (encrypted at rest). Selected per-video via `videos.bucket` FK. The `Storage.getAccessForVideo()` Effect function resolves either the default platform bucket or the custom user/org bucket.

---

## 4. Processing / Transcoding

### 4.1 Media Server

A separate `media-server` app is referenced in Docker Compose but **not present in this repo clone** (`apps/media-server/` directory is absent). Runs on port **3456**, accessed via `MEDIA_SERVER_URL` env var.

Evidence:
- `packages/local-docker/docker-compose.yml` lines 23-31: builds from `apps/media-server/Dockerfile`, sets `PORT: 3456`
- `docker-compose.template.yml` lines 52-64: `MEDIA_SERVER_URL: http://cap-media-server:3456`
- `packages/env/server.ts` lines 141-155: describes it as "URL of the media server for FFmpeg processing"

The health endpoint returns `{ status, ffmpeg: { available, version } }` -- it wraps FFmpeg.

### 4.2 `startVideoProcessingWorkflow`

Defined in `apps/web/lib/video-processing.ts` lines 90-143:

1. Calls `transitionVideoToProcessing()` -- atomically updates `videoUploads.phase` to `"processing"` (conditional update prevents double-starts)
2. Fires the durable `processVideoWorkflow` via the Effect-based workflow engine

### 4.3 `processVideoWorkflow`

Defined in `apps/web/workflows/process-video.ts`:

1. **`validateProcessingRequest`** -- confirms MEDIA_SERVER_URL is set, video and upload records exist, rawFileKey matches, phase is "processing"
2. **`processVideoOnMediaServer`** -- generates presigned GET URL for raw file and presigned PUT URLs for `result.mp4`, `screenshot/screen-capture.jpg`, `preview/animated-preview.gif`; POSTs to `{MEDIA_SERVER_URL}/video/process`; polls `videoUploads` every 5 seconds (max 720 attempts = 1 hour) waiting for phase `"complete"`
3. **`saveMetadataAndComplete`** -- writes `width`, `height`, `fps`, `duration` to `videos` table; deletes `videoUploads` row
4. **`cleanupRawUpload`** -- deletes the raw source file from S3

### 4.4 Media Server Endpoints

From `apps/web/lib/media-client.ts`:

| Endpoint | Purpose |
|---|---|
| `GET /health` | FFmpeg availability check |
| `POST /video/process` | Transcode raw upload to `result.mp4` + generate thumbnail + GIF |
| `POST /video/mux-segments` | Mux desktop recording segments into single MP4 |
| `POST /video/probe` | Return metadata (duration/width/height/fps/codecs/bitrate/fileSize) |
| `POST /video/convert` | Convert video format |
| `POST /video/edit` | Trim/cut video |
| `POST /audio/check` | Detect audio track presence |
| `POST /audio/extract` | Stream audio out |
| `POST /audio/convert` | Convert audio to MP3 |

### 4.5 Processing Phases

**`videoUploads.phase`** (DB column):
- `"uploading"` -- file being uploaded to S3
- `"processing"` -- media server job running
- `"generating_thumbnail"` -- media server generating thumbnail/GIF
- `"complete"` -- done (row is deleted)
- `"error"` -- failed

**Media server webhook phases** (`apps/web/app/api/webhooks/media-server/progress/route.ts` lines 11-22):
- `queued` -> db `processing`
- `downloading` -> db `processing`
- `probing` -> db `processing`
- `processing` -> db `processing`
- `uploading` -> db `processing`
- `generating_thumbnail` -> db `generating_thumbnail`
- `complete` -> db `complete`
- `error` / `cancelled` -> db `error`

Progress: integer 0-100 in `processingProgress`, human-readable `processingMessage`.

### 4.6 HLS Conversion

HLS playlists are **not produced by the current pipeline**. Two legacy source types use HLS:
- `MediaConvert`: AWS MediaConvert produced `output/video_recording_000.m3u8`
- `local`: `combined-source/stream.m3u8` with `.ts` segments

For new recordings, the media server produces a single `result.mp4`. HLS is **reconstructed on the fly** by `/api/playlist` for legacy sources and desktop segment sources.

### 4.7 Desktop Segments Finalization

`apps/web/workflows/finalize-desktop-recording.ts`:
- Calls `{MEDIA_SERVER_URL}/video/mux-segments` to combine all video/audio `.m4s` segments into a single `result.mp4`

---

## 5. Playback Flow

### 5.1 Share Page

**Files:** `apps/web/app/s/[videoId]/`

- **`page.tsx`** -- server component. Fetches video record, comments, views, org settings, viewer identity from DB. Renders `Share` client component.
- **`Share.tsx`** -- client component. Handles analytics tracking, polling video status every 2s during transcription, URL-based seeking (`?t=` query param). Delegates video to `<ShareVideo>` and sidebar to `<Sidebar>`.

### 5.2 Video Player Selection

**`ShareVideo.tsx`** (and mirrored in `EmbedVideo.tsx`):
- **`CapVideoPlayer`** for MP4 sources (`desktopMP4`, `webMP4`, `extensionWeb`)
- **`HLSVideoPlayer`** for everything else (live desktop segments, `local`/`MediaConvert` HLS sources)
- When `isActivelyRecording` is true, also uses `HLSVideoPlayer` in background-preview mode

### 5.3 CapVideoPlayer (MP4 path -- native `<video>`)

**File:** `apps/web/app/s/[videoId]/_components/CapVideoPlayer.tsx`

- Calls `resolvePlaybackSource()` (from `playback-source.ts`) to HEAD-probe `/api/playlist?...&videoType=mp4` and get the actual redirected MP4 URL (signed S3/R2/MinIO URL)
- Sets that URL as `<video src="...">`
- Has iOS Safari AVC-level patch (`mp4-level-patch.ts`) that rewrites the mp4 atom in a Blob URL to avoid hardware decoding limits
- Falls back to `rawFallbackSrc` (the original raw upload) on error

### 5.4 HLSVideoPlayer (HLS path -- `hls.js`)

**File:** `apps/web/app/s/[videoId]/_components/HLSVideoPlayer.tsx`

- Imports `Hls` from `hls.js`
- Creates `new Hls({enableWorker: true, lowLatencyMode: false, ...})`, calls `hls.loadSource()`, `hls.attachMedia(video)`
- Falls back to native `video.src = playbackSrc` if `Hls.isSupported()` is false (Safari)
- Has live-segment probe loop before setting `isPlaybackSourceReady`

### 5.5 `/api/playlist` Route

**File:** `apps/web/app/api/playlist/route.ts`

Handles `videoType` values: `video`, `audio`, `master`, `mp4`, `raw-preview`, `segments-master`, `segments-video`, `segments-audio`.

| videoType | Behavior |
|---|---|
| `mp4` | Signs `result.mp4` URL, returns redirect |
| `segments-master` | Reads manifest.json, generates HLS master playlist text |
| `segments-video` / `segments-audio` | Generates HLS segment playlist text with signed segment URLs |
| `master` (custom bucket) | Lists objects, generates HLS master playlist |
| `video` / `audio` (custom bucket) | Generates HLS media playlist |
| `raw-preview` | Signs raw upload file URL, returns redirect |
| Default (S3, no custom bucket) | Signs `.m3u8` URL for legacy sources, redirects |

### 5.6 Video URL Generation

All video URLs route through `/api/playlist`. The playlist route generates signed S3/R2/MinIO URLs via `bucket.getSignedObjectUrl()`. CloudFront signed URLs used when `CLOUDFRONT_KEYPAIR_ID` + `CLOUDFRONT_KEYPAIR_PRIVATE_KEY` env vars are configured.

### 5.7 Seeking

Seeking is **native HTML5** -- both players set `video.currentTime = value` directly. No HLS-specific seek protocol.

- `Share.tsx` `handleSeek()` (lines 419-454): sets `video.currentTime = clamped`, waits for `readyState >= 1`
- `ShareVideo.tsx` has a local `handleSeek` that calls `videoRef.current.currentTime = time`
- HLS.js handles underlying segment prefetch transparently when `currentTime` is set

---

## 6. Every Code Location Assuming HLS or Media-Server

### 6.1 HLS / hls.js

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `apps/web/app/s/[videoId]/_components/HLSVideoPlayer.tsx` | 11, 134, 318-462 | Full hls.js integration: imports Hls, creates instance, loads source, handles errors, retry, live-segment probing | **YES** -- replace with native `<video>` or remove in favor of CapVideoPlayer |
| `apps/web/app/s/[videoId]/_components/ShareVideo.tsx` | 27, 348-395, 452-481 | Imports and renders HLSVideoPlayer for non-MP4 sources and live recordings; builds HLS videoSrc URLs | **YES** -- remove HLS branches, always use CapVideoPlayer |
| `apps/web/app/s/[videoId]/_components/AudioPlayer.tsx` | 1, 12-34 | Uses hls.js for `<audio>` element | **NO** -- dead code (never imported) |
| `apps/web/app/embed/[videoId]/_components/EmbedVideo.tsx` | 18, 181-202, 256 | Imports and renders HLSVideoPlayer for non-MP4 embed sources; same videoSrc construction | **YES** -- remove HLS branches |

### 6.2 `.m3u8` File Paths

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `packages/web-domain/src/Video.ts` | 54-62 | Maps `MediaConvert` -> `M3U8Source` (`output/video_recording_000.m3u8`) and `local` -> `M3U8Source` (`combined-source/stream.m3u8`) | **YES** if legacy source types retired |
| `apps/web/app/api/playlist/route.ts` | 285, 290, 355, 361 | Hard-coded `.m3u8` paths for `local`/`MediaConvert`; `.ts` segment rewriting | **YES** if legacy source types dropped |
| `apps/web/app/api/upload/[...route]/signed.ts` | 28, 146 | Returns `application/x-mpegURL` MIME type for `.m3u8` | Low impact -- change only if `.m3u8` uploads eliminated |
| `apps/web/actions/video/upload.ts` | 54 | Same MIME type branch | Low impact |
| `apps/web/app/api/tools/loom-download/route.ts` | 10, 24-25 | Detects Loom `.m3u8` URLs for import | **NO** -- Loom import specific |
| `apps/web/lib/video-convert.ts` | 42, 107 | `isHlsUrl()` helper; creates temp `.m3u8` files for ffmpeg | **NO** -- Loom import specific |
| `apps/web/workflows/import-loom-video.ts` | 39, 173-174 | Detects `.m3u8` in Loom CDN URLs | **NO** -- Loom import specific |
| `apps/web/actions/loom.ts` | 198 | Same `.m3u8` detection | **NO** -- Loom import specific |

### 6.3 MPEG-TS `.ts` Segments

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `apps/web/app/api/playlist/route.ts` | 361 | Rewrites `.ts` segment lines to signed URLs for legacy `local` source | **YES** if `local` source retired |

### 6.4 `MEDIA_SERVER_URL` / Media Server Client

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `apps/web/lib/media-client.ts` | 20-35, 86-256 | All media server API calls (health, audio, video probe/convert/process) | **YES** if media server replaced |
| `apps/web/workflows/process-video.ts` | 75, 232, 294, 308 | Calls `{MEDIA_SERVER_URL}/video/process` to transcode raw files to `result.mp4` | **YES** -- main upload-to-MP4 pipeline |
| `apps/web/workflows/finalize-desktop-recording.ts` | 34-38, 168, 417-430 | Calls `{MEDIA_SERVER_URL}/video/mux-segments` | Only relevant if `desktopSegments` source kept |
| `apps/web/workflows/edit-video.ts` | 49-54, 108, 225, 300 | Calls `{MEDIA_SERVER_URL}/video/edit` for trim/cut | **YES** if media server removed |
| `apps/web/workflows/admin-reprocess-video.ts` | 43-48, 233, 345 | Calls `{MEDIA_SERVER_URL}/video/process` for admin reprocessing | **YES** if media server removed |
| `apps/web/app/api/webhooks/media-server/progress/route.ts` | 66-69 | Receives webhook callbacks from media server | **YES** if media server removed |
| `apps/web/app/api/upload/[...route]/multipart.ts` | 591-628 | Queues `remuxOnly: true` job for faststart after multipart upload complete | **YES** -- remove or require uploads to already have +faststart |
| `packages/env/server.ts` | 141-155 | Declares `MEDIA_SERVER_URL`, `MEDIA_SERVER_WEBHOOK_SECRET`, `MEDIA_SERVER_WEBHOOK_URL` env vars | Make optional or remove |

### 6.5 Port 3456

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `docker-compose.template.yml` | 26, 59, 62 | Media server container on port 3456 | **YES** -- remove service |
| `packages/local-docker/docker-compose.yml` | 31 | Same, local dev Docker | **YES** -- remove service |
| `apps/web/__tests__/unit/media-client.test.ts` | 17, 63, 93, 114, 185, 260 | Test mocks using `http://localhost:3456` | **YES** -- update/remove tests |

### 6.6 Transcode / FFmpeg

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `apps/web/lib/video-convert.ts` | 1-7, 14-38, 217, 236 | Spawns local ffmpeg for Loom import; uses `+faststart` | **NO** -- Loom import specific |
| `apps/web/lib/audio-extract.ts` | via `getFfmpegPath()` | Local ffmpeg binary path for audio extraction | **NO** -- audio processing |
| `apps/web/components/PreUploadTrimmer/useFFmpeg.ts` | all | `@ffmpeg/ffmpeg` (WebAssembly) for client-side pre-upload trimming | **NO** -- client-side, separate from media server |

### 6.7 HLS Playlist Generators

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `apps/web/utils/video/ffmpeg/helpers.ts` | 1-57 | `generateM3U8Playlist()` and `generateMasterPlaylist()` -- text generators called by `/api/playlist` for custom-bucket sources | **YES** -- can be deleted when HLS playlist generation removed |

### 6.8 Desktop Segment Muxing

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `apps/web/workflows/finalize-desktop-recording.ts` | 430 | `fetch(${mediaServerUrl}/video/mux-segments)` | Only if `desktopSegments` source kept |

### 6.9 Faststart

| File | Lines | What it does | Needs change? |
|------|-------|--------------|---------------|
| `apps/web/lib/video-convert.ts` | 217, 236 | `-movflags +faststart` in ffmpeg args | **NO** -- Loom import specific |
| `apps/web/app/api/upload/[...route]/multipart.ts` | 625 | "faststart remux" via media server `/video/process` with `remuxOnly: true` | **YES** -- remove or handle differently |

### 6.10 CloudFront (does NOT need change)

| File | Lines | What it does |
|------|-------|--------------|
| `apps/web/workflows/edit-video.ts` | 3-5, 501-508 | CDN cache invalidation after video edit |
| `apps/web/workflows/admin-reprocess-video.ts` | 2-4, 409-416 | CDN cache invalidation after reprocess |

CloudFront is optional (behind env vars) and works equally well with single-file MP4.

---

## Migration Summary for P6.2-P6.5

### Minimum changes for single-file MP4 playback:

1. **`HLSVideoPlayer.tsx`** -- Replace with thin native `<video>` wrapper or redirect all paths to `CapVideoPlayer`
2. **`ShareVideo.tsx`** and **`EmbedVideo.tsx`** -- Remove HLS/segments branches, always use `CapVideoPlayer`
3. **`/api/playlist` route** -- The `mp4` videoType path already works; remove `segments-*`, `master`, `video`, `audio` videoTypes once legacy source types retired
4. **`utils/video/ffmpeg/helpers.ts`** -- Delete once HLS playlist generation is gone
5. **`multipart.ts` faststart remux** -- Remove or require uploads to already have `+faststart`
6. **Docker compose files** -- Remove `cap-media-server` service entry
7. **`packages/env/server.ts`** -- Remove or make optional `MEDIA_SERVER_*` vars

### Items that do NOT need to change:

- Loom import (`video-convert.ts`, `import-loom-video.ts`, `loom.ts`, `loom-download` route)
- Audio processing (`audio-extract.ts`, audio enhance)
- Edit-video workflow (if video editing feature is kept)
- CloudFront invalidation
- `AudioPlayer.tsx` (dead code)
- Client-side `@ffmpeg/ffmpeg` pre-upload trimmer
