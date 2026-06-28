/**
 * Server-side video processing pipeline.
 *
 * Runs after the raw upload lands in S3/R2. Responsibilities:
 *   1. Probe the source (duration, w/h, codecs, container) and write the
 *      authoritative duration/width/height back to the videos row.
 *   2. Normalize to Safari-friendly MP4 (transcode WebM/VP9/AV1; remux MP4
 *      with +faststart) and upload as `<owner>/<id>/transcoded.mp4`.
 *   3. Generate a thumbnail (`screen-capture.jpg`) and animated GIF preview
 *      (`preview/animated-preview.gif`) at the 10% mark, with retries.
 *
 * Every step is idempotent — a HEAD on the output key short-circuits work
 * that's already complete, so retries from the workflow runner are cheap.
 * Thumbnail / GIF failures are non-fatal (placeholder shows instead).
 */
import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Option } from "effect";
import { FatalError } from "workflow";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";
import {
	extractGifPreview,
	extractThumbnail,
	needsMp4Transcode,
	probeVideo,
	remuxMp4Faststart,
	transcodeToMp4,
	type VideoProbeResult,
	withRetry,
} from "@/lib/video-probe";

interface ProcessVideoWorkflowPayload {
	videoId: string;
	userId: string;
	rawFileKey: string;
	bucketId: string | null;
}

interface VideoProcessingResult {
	success: boolean;
	message: string;
	metadata?: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

export async function processVideoWorkflow(
	payload: ProcessVideoWorkflowPayload,
): Promise<VideoProcessingResult> {
	"use workflow";

	const { videoId, userId, rawFileKey } = payload;

	try {
		// Determine source type upfront so we can short-circuit steps that don't
		// apply to audio-only uploads (no video track → no thumbnail/transcode).
		const videoRow = await loadVideoRow(videoId);
		const isAudioSource =
			(videoRow.source as { type?: string } | null)?.type === "webAudio";

		// 1. Probe + write duration/width/height back to the videos row.
		const probe = await probeAndStoreMetadata(videoId, userId, rawFileKey);

		// 2. Ensure a Safari-friendly MP4 lives at <owner>/<id>/transcoded.mp4.
		// Audio uploads have no video track — ffmpeg transcode is not needed.
		if (!isAudioSource) {
			await ensureMp4Variant(videoId, userId, rawFileKey, probe);
		}

		// 3. Thumbnail + GIF preview (non-fatal — placeholder if all retries fail).
		// Audio uploads use /audio-cover-default.svg in the UI; skip ffmpeg frame grab.
		if (!isAudioSource) {
			await ensurePreviewAssets(videoId, userId, probe);
		} else {
			console.info(
				`[CAP-THUMB] skipping previews video=${videoId} reason=audio_source`,
			);
		}

		// 4. Clear the upload row — the upload is fully processed.
		await db()
			.delete(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId));

		return {
			success: true,
			message: "Video processing complete",
			metadata:
				probe.durationSec != null &&
				probe.width != null &&
				probe.height != null
					? {
							duration: probe.durationSec,
							width: probe.width,
							height: probe.height,
							fps: probe.fps ?? 0,
						}
					: undefined,
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setProcessingError(videoId, errorMessage);
		throw new FatalError(errorMessage);
	}
}

/**
 * Step 1 — probe with ffmpeg and persist duration/width/height to the videos
 * row, plus codec/container/probe diagnostics into `metadata` JSON.
 */
async function probeAndStoreMetadata(
	videoId: string,
	userId: string,
	rawFileKey: string,
): Promise<VideoProbeResult> {
	"use step";

	const sourceUrl = await getInternalSourceUrl(videoId, rawFileKey);
	const probe = await probeVideo(sourceUrl);

	console.info(
		`[CAP-PROCESS] probed video=${videoId} duration=${probe.durationSec} width=${probe.width} height=${probe.height} fps=${probe.fps} videoCodec=${probe.videoCodec} audioCodec=${probe.audioCodec} container=${probe.containerFormat}`,
	);

	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const nextMetadata: VideoMetadata = {
		...(row?.metadata ?? {}),
		videoCodec: probe.videoCodec ?? undefined,
		audioCodec: probe.audioCodec ?? undefined,
		containerFormat: probe.containerFormat ?? undefined,
	};

	await db()
		.update(videos)
		.set({
			...(probe.durationSec != null ? { duration: probe.durationSec } : {}),
			...(probe.width != null ? { width: probe.width } : {}),
			...(probe.height != null ? { height: probe.height } : {}),
			...(probe.fps != null ? { fps: probe.fps } : {}),
			metadata: nextMetadata,
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	console.info(`[CAP-PROCESS] metadata written: video=${videoId}`);
	void userId; // referenced only for log parity / call signature symmetry
	return probe;
}

/**
 * Step 2 — guarantee `<owner>/<id>/transcoded.mp4` exists and is playable
 * in Safari. WebM/VP9/AV1 sources get re-encoded; MP4 sources get remuxed
 * with +faststart so the moov atom is at the front.
 *
 * Idempotent: if the key already exists with a non-zero body, we skip.
 */
async function ensureMp4Variant(
	videoId: string,
	userId: string,
	rawFileKey: string,
	probe: VideoProbeResult,
): Promise<void> {
	"use step";

	const video = await loadVideoRow(videoId);
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const transcodedKey = `${userId}/${videoId}/transcoded.mp4`;

	// Idempotency check — skip work if the output already landed.
	const existing = await bucket.headObject(transcodedKey).pipe(runPromise);
	if (Option.isSome(existing) && (existing.value.ContentLength ?? 0) > 0) {
		console.info(
			`[CAP-PROCESS] transcoded.mp4 already present video=${videoId} bytes=${existing.value.ContentLength}`,
		);
		await markMp4Ready(videoId, video.metadata ?? {});
		return;
	}

	const sourceUrl = await getInternalSourceUrl(videoId, rawFileKey);
	const needsFullTranscode = needsMp4Transcode(probe, rawFileKey);

	const result = needsFullTranscode
		? (() => {
				console.info(
					`[CAP-PROCESS] transcoding ${probe.containerFormat ?? "source"} → mp4 video=${videoId}`,
				);
				return transcodeToMp4(sourceUrl);
			})()
		: (() => {
				console.info(`[CAP-PROCESS] remuxing mp4 +faststart video=${videoId}`);
				return remuxMp4Faststart(sourceUrl);
			})();

	const rendered = await result;

	try {
		const body = await fs.readFile(rendered.outputPath);
		await bucket
			.putObject(transcodedKey, body, { contentType: "video/mp4" })
			.pipe(runPromise);
		console.info(
			`[CAP-PROCESS] transcode complete: video=${videoId} size=${rendered.sizeBytes} elapsed=${rendered.elapsedMs}ms key=${transcodedKey}`,
		);
		await markMp4Ready(videoId, video.metadata ?? {});
	} finally {
		await rendered.cleanup();
	}
}

async function markMp4Ready(
	videoId: string,
	currentMetadata: VideoMetadata,
): Promise<void> {
	if (currentMetadata.mp4Ready === true) return;
	await db()
		.update(videos)
		.set({ metadata: { ...currentMetadata, mp4Ready: true } })
		.where(eq(videos.id, videoId as Video.VideoId));
}

/**
 * Step 3 — generate a still thumbnail and a short animated GIF preview.
 * Wrapped in retry (3 attempts, 2s/4s/8s backoff). If all retries fail,
 * we mark thumbnailStatus=failed and continue — the placeholder UI keeps
 * working so the rest of the video still ships.
 */
async function ensurePreviewAssets(
	videoId: string,
	userId: string,
	probe: VideoProbeResult,
): Promise<void> {
	"use step";

	if (probe.durationSec == null || probe.durationSec <= 0) {
		console.warn(
			`[CAP-THUMB] skipping previews video=${videoId} reason=unknown_duration`,
		);
		return;
	}

	const video = await loadVideoRow(videoId);
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const thumbnailKey = `${userId}/${videoId}/screen-capture.jpg`;
	const gifKey = `${userId}/${videoId}/preview/animated-preview.gif`;

	// We prefer the transcoded MP4 as the input — it's already H.264 so the
	// thumbnail ffmpeg run is quick. Falls back to the raw upload if needed.
	const sourceUrl = await getInternalSourceUrl(
		videoId,
		`${userId}/${videoId}/transcoded.mp4`,
	).catch(() => getInternalSourceUrl(videoId, `${userId}/${videoId}/result.webm`));

	let thumbnailOk = false;
	let gifOk = false;

	// Thumbnail — idempotent + retried.
	try {
		const head = await bucket.headObject(thumbnailKey).pipe(runPromise);
		if (Option.isSome(head) && (head.value.ContentLength ?? 0) > 0) {
			thumbnailOk = true;
		} else {
			await withRetry("thumbnail", 3, async () => {
				const { outputPath, cleanup } = await extractThumbnail(
					sourceUrl,
					probe.durationSec ?? 0,
				);
				try {
					const body = await fs.readFile(outputPath);
					await bucket
						.putObject(thumbnailKey, body, { contentType: "image/jpeg" })
						.pipe(runPromise);
				} finally {
					await cleanup();
				}
			});
			thumbnailOk = true;
		}
	} catch (err) {
		console.warn(
			`[CAP-THUMB] failed video=${videoId} asset=thumbnail reason=${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	// GIF preview — idempotent + retried.
	try {
		const head = await bucket.headObject(gifKey).pipe(runPromise);
		if (Option.isSome(head) && (head.value.ContentLength ?? 0) > 0) {
			gifOk = true;
		} else {
			await withRetry("gif-preview", 3, async () => {
				const { outputPath, cleanup } = await extractGifPreview(
					sourceUrl,
					probe.durationSec ?? 0,
				);
				try {
					const body = await fs.readFile(outputPath);
					await bucket
						.putObject(gifKey, body, { contentType: "image/gif" })
						.pipe(runPromise);
				} finally {
					await cleanup();
				}
			});
			gifOk = true;
		}
	} catch (err) {
		console.warn(
			`[CAP-THUMB] failed video=${videoId} asset=gif reason=${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	const nextStatus: VideoMetadata["thumbnailStatus"] = thumbnailOk
		? "ready"
		: "failed";
	await db()
		.update(videos)
		.set({
			metadata: { ...(video.metadata ?? {}), thumbnailStatus: nextStatus },
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	console.info(
		`[CAP-THUMB] previews video=${videoId} thumbnail=${thumbnailOk ? "ready" : "failed"} gif=${gifOk ? "ready" : "failed"}`,
	);
}

async function loadVideoRow(videoId: string) {
	const [row] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	if (!row) throw new FatalError("Video does not exist");
	return row;
}

/**
 * Resolve a presigned read URL for the raw upload (or, when called with the
 * transcoded MP4 key, the rendered MP4). Uses the same internal-signed-URL
 * helper transcribe.ts uses so we share auth + region handling.
 */
async function getInternalSourceUrl(
	videoId: string,
	objectKey: string,
): Promise<string> {
	const video = await loadVideoRow(videoId);
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	return bucket.getInternalSignedObjectUrl(objectKey).pipe(runPromise);
}

async function setProcessingError(
	videoId: string,
	errorMessage: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: "Video processing failed",
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
