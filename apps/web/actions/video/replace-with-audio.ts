"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { extractAudioToBuffer } from "@/lib/audio-extract";
import { runPromise } from "@/lib/server";
import { patchVideoMetadata } from "@/lib/video-metadata";
import { getStorageAccessForVideo } from "@/lib/video-storage";

export type ReplaceWithAudioResult =
	| { ok: true; reclaimedFrom: string[] }
	| { ok: false; reason: string };

// Where the extracted audio is written and later served from. A dedicated key
// (rather than overwriting result.mp4/transcoded.mp4) keeps the change purely
// additive: the playlist route serves this only when metadata.isAudio is set.
const AUDIO_ONLY_NAME = "audio-only.mp3";

// Tried in order; the first heavy media object that exists is the extraction
// source. cap-v2 stores the served media under transcoded.mp4 (Safari-friendly
// transcode) or result.mp4/result.webm (single-file upload), and the original
// bytes under raw-upload.mp4/.webm. Videos with none of these (segment-only
// desktop recordings) fall through to `unsupported_source`.
const SOURCE_CANDIDATE_NAMES = [
	"transcoded.mp4",
	"result.mp4",
	"result.webm",
	"raw-upload.mp4",
	"raw-upload.webm",
] as const;

// Heavy objects reclaimed (best-effort) once the new audio object is verified.
// The audio-only key is never in this list. Segment trees (output/,
// combined-source/) are out of scope here.
const RECLAIM_CANDIDATE_NAMES = [
	"transcoded.mp4",
	"result.mp4",
	"result.webm",
	"raw-upload.mp4",
	"raw-upload.webm",
] as const;

// A freshly-written object's ContentLength should equal the uploaded byte
// count exactly; a small tolerance guards the safety check below against
// provider rounding without weakening it.
const SIZE_VERIFY_TOLERANCE_BYTES = 16;

/**
 * Storage-reclaim owner action: extract the audio track from an owner's video,
 * write it to `audio-only.mp3`, flip `metadata.isAudio` so the playlist route
 * serves that audio in place of the (now-deleted) video, and reclaim the heavy
 * video bytes. AI analysis / transcript are untouched. Irreversible — the
 * ordering below never deletes anything before the newly-written audio is
 * proven to read back with the expected size.
 */
export async function replaceVideoWithAudio(
	videoId: string,
): Promise<ReplaceWithAudioResult> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, reason: "unauthorized" };

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	if (!video) return { ok: false, reason: "not_found" };
	if (video.ownerId !== user.id) return { ok: false, reason: "unauthorized" };

	const meta = (video.metadata as VideoMetadata) ?? {};
	if (meta.isAudio) return { ok: false, reason: "already_audio" };

	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);

	let sourceKey: string | null = null;
	for (const name of SOURCE_CANDIDATE_NAMES) {
		const key = `${video.ownerId}/${videoId}/${name}`;
		try {
			const head = await bucket.headObject(key).pipe(runPromise);
			if ((head.ContentLength ?? 0) > 0) {
				sourceKey = key;
				break;
			}
		} catch {
			// candidate missing — try the next one
		}
	}
	if (!sourceKey) return { ok: false, reason: "unsupported_source" };

	const sourceUrl = await bucket
		.getInternalSignedObjectUrl(sourceKey)
		.pipe(runPromise);

	// Extract fully into memory BEFORE any write — nothing is mutated yet, so
	// a failure here leaves storage untouched.
	let audioBuf: Buffer;
	try {
		audioBuf = await extractAudioToBuffer(sourceUrl);
	} catch (err) {
		console.error("[replaceVideoWithAudio] extract failed", {
			videoId,
			err: err instanceof Error ? err.message : String(err),
		});
		return { ok: false, reason: "extract_failed" };
	}

	const audioKey = `${video.ownerId}/${videoId}/${AUDIO_ONLY_NAME}`;
	await bucket
		.putObject(audioKey, audioBuf, {
			contentType: "audio/mpeg",
			contentLength: audioBuf.length,
		})
		.pipe(runPromise);

	// SAFETY GATE — never delete anything below unless the audio we just wrote
	// reads back with the size we expect. The original video objects are still
	// intact at this point, so a failed verify loses no data.
	let verified = false;
	try {
		const head = await bucket.headObject(audioKey).pipe(runPromise);
		verified =
			Math.abs((head.ContentLength ?? 0) - audioBuf.length) <=
			SIZE_VERIFY_TOLERANCE_BYTES;
	} catch {
		verified = false;
	}
	if (!verified) return { ok: false, reason: "verify_failed" };

	const reclaimedFrom: string[] = [];
	for (const name of RECLAIM_CANDIDATE_NAMES) {
		const key = `${video.ownerId}/${videoId}/${name}`;
		if (key === audioKey) continue;

		try {
			const head = await bucket.headObject(key).pipe(runPromise);
			if ((head.ContentLength ?? 0) === 0) continue;
		} catch {
			continue; // doesn't exist — nothing to reclaim
		}

		try {
			await bucket.deleteObject(key).pipe(runPromise);
			reclaimedFrom.push(key);
		} catch (err) {
			console.error("[replaceVideoWithAudio] reclaim delete failed", {
				key,
				err: err instanceof Error ? err.message : String(err),
			});
		}
	}

	await patchVideoMetadata(videoId, (cur) => ({ ...cur, isAudio: true }));

	revalidatePath(`/s/${videoId}`);

	return { ok: true, reclaimedFrom };
}
