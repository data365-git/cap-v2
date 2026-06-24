import { promises as fs } from "node:fs";
import { db } from "@cap/database";
import { decrypt } from "@cap/database/crypto";
import { nanoId } from "@cap/database/helpers";
import {
	organizations,
	transcriptChunks,
	users,
	videos,
	videoUploads,
} from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { userIsPro } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError } from "workflow";
import { withCostGuard } from "@/lib/ai-cost-guard";
import {
	ENHANCED_AUDIO_CONTENT_TYPE,
	ENHANCED_AUDIO_EXTENSION,
	enhanceAudioFromUrl,
} from "@/lib/audio-enhance";
import {
	checkHasAudioTrack,
	chunkAudio,
	extractAudioFromUrl,
} from "@/lib/audio-extract";
import { EMBED_MODEL, embedChunksWithUsage } from "@/lib/gemini-embed";
import {
	mergeVtt,
	transcribeWithGemini,
	type VttCue,
} from "@/lib/gemini-transcribe";
import { startAiGeneration } from "@/lib/generate-ai";
import { runPromise } from "@/lib/server";
import { chunkTranscript } from "@/lib/transcript-chunk";
import { decodeStorageVideo } from "@/lib/video-storage";

interface TranscribeWorkflowPayload {
	videoId: string;
	userId: string;
	aiGenerationEnabled: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	transcriptionDisabled: boolean;
	isOwnerPro: boolean;
	ownerEncryptedGeminiKey: string | null;
	orgId: string;
}

export async function transcribeVideoWorkflow(
	payload: TranscribeWorkflowPayload,
) {
	"use workflow";

	const { videoId, userId, aiGenerationEnabled } = payload;

	const videoData = await validateVideo(videoId);

	if (videoData.transcriptionDisabled) {
		await markSkipped(videoId);
		return { success: true, message: "Transcription disabled - skipped" };
	}

	try {
		const audioUrl = await extractAudio(videoId, userId, videoData.video);

		if (!audioUrl) {
			await markNoAudio(videoId);
			return {
				success: true,
				message: "Video has no audio track - skipped transcription",
			};
		}

		const [transcription] = await Promise.all([
			transcribeAudio(
				audioUrl,
				videoData.video.duration,
				videoData.ownerEncryptedGeminiKey,
				{ userId, orgId: videoData.orgId, videoId },
			),
		]);

		await saveTranscription(
			videoId,
			userId,
			videoData.video,
			transcription.transcriptVtt,
			transcription.allComplete,
		);

		if (transcription.allComplete) {
			await chunkEmbedAndStore(
				videoId,
				transcription.transcriptVtt,
				videoData.ownerEncryptedGeminiKey,
				{ userId, orgId: videoData.orgId },
			);
		} else {
			console.warn(
				`[CAP-TRANSCRIBE] Skipping RAG indexing for ${videoId}: transcription truncated`,
			);
		}
	} catch (error) {
		await markError(videoId);
		await cleanupTempAudio(videoId, userId, videoData.video);
		throw error;
	}

	await cleanupTempAudio(videoId, userId, videoData.video);

	if (aiGenerationEnabled) {
		await queueAiGeneration(videoId, userId);
	}

	return { success: true, message: "Transcription completed successfully" };
}

async function validateVideo(videoId: string): Promise<VideoData> {
	"use step";

	const query = await db()
		.select({
			video: videos,
			settings: videos.settings,
			orgSettings: organizations.settings,
			owner: users,
		})
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.innerJoin(users, eq(videos.ownerId, users.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0) {
		throw new FatalError("Video does not exist");
	}

	const result = query[0];
	if (!result?.video) {
		throw new FatalError("Video information is missing");
	}

	const transcriptionDisabled =
		result.video.settings?.disableTranscript ??
		result.orgSettings?.disableTranscript ??
		false;

	const isOwnerPro = userIsPro(result.owner);

	console.log(
		`[transcribe] Owner check: stripeSubscriptionStatus=${result.owner.stripeSubscriptionStatus}, thirdPartyStripeSubscriptionId=${result.owner.thirdPartyStripeSubscriptionId}, isOwnerPro=${isOwnerPro}`,
	);

	await db()
		.update(videos)
		.set({ transcriptionStatus: "PROCESSING" })
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video: result.video,
		transcriptionDisabled,
		isOwnerPro,
		ownerEncryptedGeminiKey: result.owner.geminiApiKey ?? null,
		orgId: result.video.orgId,
	};
}

async function markSkipped(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "SKIPPED" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markNoAudio(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "NO_AUDIO" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function markError(videoId: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "ERROR" })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function extractAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<string | null> {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const videoUrl = await resolveVideoSourceUrl(videoId, userId, video);

	// Media server removed — single-file MP4, no server-side processing
	let audioBuffer: Buffer;

	const probe = await checkHasAudioTrack(videoUrl);
	console.log(
		`[transcribe] Local ffmpeg audio check for ${videoId}: hasAudio=${probe.hasAudio}, durationSec=${probe.durationSec}`,
	);

	if (probe.durationSec != null) {
		await db()
			.update(videos)
			.set({ duration: probe.durationSec })
			.where(eq(videos.id, videoId as Video.VideoId));
	}

	if (!probe.hasAudio) {
		return null;
	}

	const result = await extractAudioFromUrl(videoUrl);

	try {
		audioBuffer = await fs.readFile(result.filePath);
	} finally {
		await result.cleanup();
	}

	console.log(
		`[transcribe] Extracted audio for ${videoId}: ${audioBuffer.length} bytes`,
	);

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	await bucket
		.putObject(audioKey, audioBuffer, {
			contentType: "audio/mpeg",
		})
		.pipe(runPromise);

	const audioSignedUrl = await bucket
		.getInternalSignedObjectUrl(audioKey)
		.pipe(runPromise);

	return audioSignedUrl;
}

async function resolveVideoSourceUrl(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<string> {
	const [resolvedBucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	const candidateKeys = [
		`${userId}/${videoId}/result.mp4`,
		upload[0]?.rawFileKey,
	].filter(
		(value, index, values): value is string =>
			Boolean(value) && values.indexOf(value) === index,
	);

	for (const key of candidateKeys) {
		const url = await resolvedBucket
			.getInternalSignedObjectUrl(key)
			.pipe(runPromise);
		const response = await fetch(url, {
			method: "GET",
			headers: { range: "bytes=0-0" },
		});

		if (response.ok) {
			console.log(`[transcribe] Using video source ${key}`);
			return url;
		}
	}

	throw new Error("Video file not accessible");
}

interface TranscriptionResult {
	transcriptVtt: string;
	allComplete: boolean;
}

const CHUNK_THRESHOLD_SEC = 12 * 60; // chunk audio longer than 12 minutes
const CHUNK_WINDOW_SEC = 10 * 60; // 10-minute windows
const CHUNK_OVERLAP_SEC = 5; // 5-second overlap to avoid mid-word cuts

async function transcribeAudio(
	audioUrl: string,
	videoDuration: number | null,
	ownerEncryptedGeminiKey: string | null,
	context: { userId: string; orgId: string; videoId: string },
): Promise<TranscriptionResult> {
	"use step";

	let apiKey: string | undefined;

	if (ownerEncryptedGeminiKey) {
		try {
			apiKey = await decrypt(ownerEncryptedGeminiKey);
		} catch {
			console.error(
				"[transcribe] Failed to decrypt user Gemini key, falling back to server key",
			);
		}
	}

	if (!apiKey) {
		apiKey = serverEnv().GEMINI_API_KEY;
	}

	if (!apiKey) {
		throw new FatalError(
			"No Gemini API key configured. Set one in Settings → Account → Transcription API Keys, or ask your admin to set GEMINI_API_KEY.",
		);
	}

	const resolvedApiKey = apiKey;
	const totalDuration = videoDuration ?? 0;
	const shouldChunk =
		totalDuration > CHUNK_THRESHOLD_SEC && Number.isFinite(totalDuration);

	if (!shouldChunk) {
		const result = await withCostGuard({
			orgId: context.orgId,
			userId: context.userId,
			videoId: context.videoId,
			operation: "transcription",
			model: "gemini-3-flash-preview",
			fn: async () => {
				const res = await transcribeWithGemini(audioUrl, {
					apiKey: resolvedApiKey,
					audioDurationSec: videoDuration ?? undefined,
				});
				console.info(
					`[CAP-TRANSCRIBE] chunk 1/1 offsetSec=0 durationSec=${totalDuration} finishReason=${res.finishReason} cueCount=${res.cues.length}`,
				);
				return {
					transcriptVtt: res.transcriptVtt,
					cues: res.cues,
					finishReason: res.finishReason,
					isComplete: res.isComplete,
					inputTokens: res.inputTokens,
					outputTokens: res.outputTokens,
				};
			},
		});

		console.info(
			`[CAP-TRANSCRIBE] merged transcript: 1 chunks, ${result.cues.length} total cues, ${totalDuration} total duration sec, allComplete=${result.isComplete}`,
		);

		return {
			transcriptVtt: result.transcriptVtt,
			allComplete: result.isComplete,
		};
	}

	// Chunked path — download audio to local disk, slice with ffmpeg, transcribe
	// each slice with its startOffset, then merge.
	const { randomUUID } = await import("node:crypto");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");

	const localAudioPath = join(tmpdir(), `audio-full-${randomUUID()}.mp3`);
	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Failed to download audio for chunking: ${audioResponse.status}`,
		);
	}
	const audioBuf = Buffer.from(await audioResponse.arrayBuffer());
	await fs.writeFile(localAudioPath, audioBuf);

	let slices: Awaited<ReturnType<typeof chunkAudio>> = [];
	const perChunkResults: Array<{ cues: VttCue[]; startOffsetSec: number }> = [];
	let allComplete = true;
	let totalCueCount = 0;

	try {
		slices = await chunkAudio(
			localAudioPath,
			totalDuration,
			CHUNK_WINDOW_SEC,
			CHUNK_OVERLAP_SEC,
		);

		for (let i = 0; i < slices.length; i++) {
			const slice = slices[i];
			if (!slice) continue;
			const chunkLabel = `${i + 1}/${slices.length}`;

			const result = await withCostGuard({
				orgId: context.orgId,
				userId: context.userId,
				videoId: context.videoId,
				operation: "transcription",
				model: "gemini-3-flash-preview",
				fn: async () => {
					const res = await transcribeWithGemini(audioUrl, {
						apiKey: resolvedApiKey,
						audioDurationSec: slice.durationSec,
						audioPath: slice.path,
						startOffsetSec: slice.startOffsetSec,
					});
					console.info(
						`[CAP-TRANSCRIBE] chunk ${chunkLabel} offsetSec=${slice.startOffsetSec} durationSec=${slice.durationSec} finishReason=${res.finishReason} cueCount=${res.cues.length}`,
					);
					return {
						transcriptVtt: res.transcriptVtt,
						cues: res.cues,
						finishReason: res.finishReason,
						isComplete: res.isComplete,
						inputTokens: res.inputTokens,
						outputTokens: res.outputTokens,
					};
				},
			});

			// Cues from transcribeWithGemini are already shifted by startOffsetSec —
			// pass 0 to mergeVtt so we don't double-shift.
			perChunkResults.push({ cues: result.cues, startOffsetSec: 0 });
			totalCueCount += result.cues.length;
			if (!result.isComplete) allComplete = false;
		}
	} finally {
		await Promise.all(slices.map((s) => s.cleanup()));
		await fs.unlink(localAudioPath).catch(() => {});
	}

	const merged = mergeVtt(perChunkResults);

	console.info(
		`[CAP-TRANSCRIBE] merged transcript: ${slices.length} chunks, ${totalCueCount} total cues, ${totalDuration} total duration sec, allComplete=${allComplete}`,
	);

	return {
		transcriptVtt: merged.vtt,
		allComplete,
	};
}

async function saveTranscription(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
	transcription: string,
	allComplete: boolean,
): Promise<void> {
	"use step";

	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	await bucket
		.putObject(`${userId}/${videoId}/transcription.vtt`, transcription, {
			contentType: "text/vtt",
		})
		.pipe(runPromise);

	if (allComplete) {
		await db()
			.update(videos)
			.set({ transcriptionStatus: "COMPLETE" })
			.where(eq(videos.id, videoId as Video.VideoId));
	} else {
		console.error(
			`[CAP-TRANSCRIBE] Transcription truncated for ${videoId} — marking ERROR`,
		);
		// videos table has no errorMessage column — log the reason and persist
		// the ERROR status (same path as markError) so UI revalidation triggers.
		await db()
			.update(videos)
			.set({ transcriptionStatus: "ERROR" })
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}

async function chunkEmbedAndStore(
	videoId: string,
	vttContent: string,
	ownerEncryptedGeminiKey: string | null,
	context: { userId: string; orgId: string },
): Promise<void> {
	"use step";

	try {
		let apiKey: string | undefined;

		if (ownerEncryptedGeminiKey) {
			try {
				apiKey = await decrypt(ownerEncryptedGeminiKey);
			} catch {
				console.error(
					"[transcribe] Failed to decrypt user Gemini key for embeddings, falling back to server key",
				);
			}
		}

		if (!apiKey) {
			apiKey = serverEnv().GEMINI_API_KEY;
		}

		if (!apiKey) {
			console.warn(
				"[transcribe] No Gemini API key available for embeddings, skipping RAG indexing",
			);
			return;
		}

		const chunks = chunkTranscript(vttContent);
		if (chunks.length === 0) {
			console.log(`[transcribe] No chunks produced for video ${videoId}`);
			return;
		}

		const resolvedApiKey = apiKey;

		const { embeddings, totalTokens } = await embedChunksWithUsage(
			chunks,
			resolvedApiKey,
		);

		await withCostGuard({
			orgId: context.orgId,
			userId: context.userId,
			videoId,
			operation: "embedding",
			model: EMBED_MODEL,
			fn: async () => ({
				embeddings,
				inputTokens: totalTokens,
				outputTokens: 0,
			}),
		});

		const rows = chunks.map((chunk, i) => ({
			id: nanoId(),
			videoId: videoId as Video.VideoId,
			chunkIndex: i,
			startMs: chunk.startMs,
			endMs: chunk.endMs,
			speaker: chunk.speaker,
			text: chunk.text,
			tokens: chunk.tokens,
			embedding: embeddings[i] ?? null,
			embeddingModel: EMBED_MODEL,
		}));

		await db().insert(transcriptChunks).values(rows);

		console.log(
			`[transcribe] Stored ${rows.length} transcript chunks for video ${videoId}`,
		);
	} catch (error) {
		console.error(
			`[transcribe] RAG indexing failed for video ${videoId}, transcription still COMPLETE:`,
			error,
		);
	}
}

async function cleanupTempAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";

	const audioKey = `${userId}/${videoId}/audio-temp.mp3`;

	try {
		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runPromise);

		await bucket.deleteObject(audioKey).pipe(runPromise);
	} catch (error) {
		console.error(
			`[transcribe] Failed to cleanup temp audio file: ${audioKey}`,
			error,
		);
	}
}

async function queueAiGeneration(
	videoId: string,
	userId: string,
): Promise<void> {
	"use step";

	await startAiGeneration(videoId as Video.VideoId, userId);
}

async function _markEnhancedAudioProcessing(videoId: string): Promise<void> {
	"use step";

	const [video] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (video?.metadata as VideoMetadata) || {};

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				enhancedAudioStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function _enhanceAndSaveAudio(
	videoId: string,
	userId: string,
	audioUrl: string,
	video: typeof videos.$inferSelect,
): Promise<void> {
	"use step";

	console.log(`[transcribe] Starting audio enhancement for video ${videoId}`);

	try {
		const enhancedBuffer = await enhanceAudioFromUrl(audioUrl);
		console.log(
			`[transcribe] Audio enhanced, saving to S3 (${enhancedBuffer.length} bytes)`,
		);

		const [bucket] = await Storage.getAccessForVideo(
			decodeStorageVideo(video),
		).pipe(runPromise);

		const enhancedAudioKey = `${userId}/${videoId}/enhanced-audio.${ENHANCED_AUDIO_EXTENSION}`;

		await bucket
			.putObject(enhancedAudioKey, enhancedBuffer, {
				contentType: ENHANCED_AUDIO_CONTENT_TYPE,
			})
			.pipe(runPromise);

		const [videoRecord] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (videoRecord?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "COMPLETE",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	} catch (error) {
		console.error(
			`[transcribe] Audio enhancement failed for video ${videoId}:`,
			error,
		);

		const [video] = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId));

		const currentMetadata = (video?.metadata as VideoMetadata) || {};

		await db()
			.update(videos)
			.set({
				metadata: {
					...currentMetadata,
					enhancedAudioStatus: "ERROR",
				},
			})
			.where(eq(videos.id, videoId as Video.VideoId));
	}
}
