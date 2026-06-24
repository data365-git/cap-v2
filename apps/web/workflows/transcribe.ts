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
import type {
	PipelinePhase,
	PipelinePhaseKey,
	PipelineProgress,
	VideoMetadata,
} from "@cap/database/types";
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

	await initPipelineProgress(videoId);

	try {
		const audio = await extractAudio(videoId, userId, videoData.video);

		if (!audio) {
			await markNoAudio(videoId);
			return {
				success: true,
				message: "Video has no audio track - skipped transcription",
			};
		}

		const [transcription] = await Promise.all([
			transcribeAudio(
				audio.audioUrl,
				// Prefer the freshly probed duration; videoData.video.duration is the
				// stale pre-probe value (often 0 for imports) and would suppress the
				// chunking decision, sending the whole audio to Gemini in one call →
				// MAX_TOKENS truncation → ERROR.
				audio.durationSec ?? videoData.video.duration,
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
		await markError(videoId, describeTranscriptionError(error));
		await markActivePhaseError(videoId);
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

	// Clear any stale failure reason so a successful retry doesn't surface an
	// old error. Read-modify-write to preserve aiSummary/refinedTranscript/etc.
	const staleMetadata = (result.video.metadata as VideoMetadata) || {};
	if (staleMetadata.transcriptionError !== undefined) {
		const { transcriptionError: _cleared, ...rest } = staleMetadata;
		await db()
			.update(videos)
			.set({ metadata: rest })
			.where(eq(videos.id, videoId as Video.VideoId));
	}

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

/**
 * Read-modify-write a partial patch into the video's metadata JSON so we never
 * clobber sibling fields (aiSummary, refinedTranscript, enhancedAudioStatus…).
 */
async function patchVideoMetadata(
	videoId: string,
	patch: Partial<VideoMetadata>,
): Promise<void> {
	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (row?.metadata as VideoMetadata) || {};

	await db()
		.update(videos)
		.set({ metadata: { ...currentMetadata, ...patch } })
		.where(eq(videos.id, videoId as Video.VideoId));
}

const PHASE_LABELS: Record<PipelinePhaseKey, string> = {
	audio: "Audio tayyorlash",
	transcribe: "Transkripsiya",
	analyze: "AI tahlil",
	index: "AI indekslash",
};

// Real execution order: audio extract → STT chunks → embeddings (index) →
// AI analyze (queued as a separate workflow). The phases array mirrors that.
const PHASE_ORDER: PipelinePhaseKey[] = [
	"audio",
	"transcribe",
	"index",
	"analyze",
];

function initialPhases(): PipelinePhase[] {
	return PHASE_ORDER.map((key) => ({
		key,
		label: PHASE_LABELS[key],
		status: "queued" as const,
		done: 0,
		total: key === "analyze" ? 1 : 0,
	}));
}

/**
 * Initialize the full 4-phase pipelineProgress at transcription start. All four
 * phases are seeded as "queued" so the strip shows the unified picture even
 * before the analyze workflow runs. Read-modify-write — never clobbers siblings.
 */
async function initPipelineProgress(videoId: string): Promise<void> {
	const now = new Date().toISOString();
	const progress: PipelineProgress = {
		currentPhase: "audio",
		phases: initialPhases(),
		startedAt: now,
		updatedAt: now,
	};
	await patchVideoMetadata(videoId, { pipelineProgress: progress });
}

/**
 * Read-modify-write a single phase entry inside metadata.pipelineProgress.
 * Updates the matching phase, sets currentPhase + updatedAt. If pipelineProgress
 * is missing (e.g. retry on an old row), it is initialized first so the patch
 * always lands. Shared by both workflows via the metadata JSON — no DB column.
 */
async function patchPipelinePhase(
	videoId: string,
	phaseKey: PipelinePhaseKey,
	patch: Partial<Omit<PipelinePhase, "key" | "label">>,
): Promise<void> {
	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	const currentMetadata = (row?.metadata as VideoMetadata) || {};
	const now = new Date().toISOString();

	const existing = currentMetadata.pipelineProgress;
	const base: PipelineProgress = existing ?? {
		currentPhase: phaseKey,
		phases: initialPhases(),
		startedAt: now,
		updatedAt: now,
	};

	const phases = base.phases.map((p) =>
		p.key === phaseKey ? { ...p, ...patch } : p,
	);

	const next: PipelineProgress = {
		...base,
		phases,
		currentPhase: phaseKey,
		updatedAt: now,
	};

	await db()
		.update(videos)
		.set({ metadata: { ...currentMetadata, pipelineProgress: next } })
		.where(eq(videos.id, videoId as Video.VideoId));
}

/**
 * Flip whichever phase is currently active to "error" so the strip stops the
 * spinner on the right phase. Read-modify-write; no-op if no active phase.
 */
async function markActivePhaseError(videoId: string): Promise<void> {
	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));
	const currentMetadata = (row?.metadata as VideoMetadata) || {};
	const progress = currentMetadata.pipelineProgress;
	if (!progress) return;
	const active = progress.phases.find((p) => p.status === "active");
	if (!active) return;
	await patchPipelinePhase(videoId, active.key, { status: "error" });
}

async function markError(videoId: string, reason?: string): Promise<void> {
	"use step";

	await db()
		.update(videos)
		.set({ transcriptionStatus: "ERROR" })
		.where(eq(videos.id, videoId as Video.VideoId));

	if (reason) {
		await patchVideoMetadata(videoId, {
			transcriptionError: reason.slice(0, 200),
		});
	}
}

/**
 * Map a caught error to a short, user-facing reason string with a coarse
 * category prefix when the underlying tool is detectable.
 */
function describeTranscriptionError(error: unknown): string {
	const message =
		error instanceof Error ? error.message : String(error ?? "Unknown error");
	const lower = message.toLowerCase();
	let prefixed = message;
	if (lower.includes("ffmpeg")) {
		prefixed = `Audio extraction failed: ${message}`;
	} else if (
		lower.includes("gemini") ||
		lower.includes("api key") ||
		lower.includes("quota") ||
		lower.includes("429")
	) {
		prefixed = `AI service error: ${message}`;
	}
	return prefixed.slice(0, 200);
}

async function extractAudio(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<{ audioUrl: string; durationSec: number | null } | null> {
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

	// audio phase: real % when duration is known (total:100), else spinner
	// (total:0). ffmpeg progress is parsed in extractAudioFromUrl and pushed here.
	const knownDuration =
		probe.durationSec != null && Number.isFinite(probe.durationSec)
			? probe.durationSec
			: null;
	await patchPipelinePhase(videoId, "audio", {
		status: "active",
		done: 0,
		total: knownDuration != null ? 100 : 0,
		startedAt: new Date().toISOString(),
	});

	let lastAudioPct = 0;
	const result = await extractAudioFromUrl(videoUrl, {
		totalDurationSec: knownDuration,
		onProgress: (pct) => {
			if (pct <= lastAudioPct) return;
			lastAudioPct = pct;
			// fire-and-forget; throttled to ~once/second inside extractAudioFromUrl
			void patchPipelinePhase(videoId, "audio", { done: pct });
		},
	});

	await patchPipelinePhase(videoId, "audio", {
		status: "done",
		done: knownDuration != null ? 100 : 0,
		completedAt: new Date().toISOString(),
	});

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

	return { audioUrl: audioSignedUrl, durationSec: probe.durationSec ?? null };
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
		const startedAt = new Date().toISOString();
		const chunkStart = Date.now();
		await patchPipelinePhase(context.videoId, "transcribe", {
			status: "active",
			done: 0,
			total: 1,
			startedAt,
		});

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

		await patchPipelinePhase(context.videoId, "transcribe", {
			status: "done",
			done: 1,
			total: 1,
			completedAt: new Date().toISOString(),
			unitTimesMs: [Date.now() - chunkStart],
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

		const chunkStartedAt = new Date().toISOString();
		const unitTimesMs: number[] = [];
		await patchPipelinePhase(context.videoId, "transcribe", {
			status: "active",
			done: 0,
			total: slices.length,
			startedAt: chunkStartedAt,
			unitTimesMs: [],
		});

		for (let i = 0; i < slices.length; i++) {
			const slice = slices[i];
			if (!slice) continue;
			const chunkLabel = `${i + 1}/${slices.length}`;
			const chunkStart = Date.now();

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

			// per-chunk wall-clock duration → drives the counting-down ETA
			unitTimesMs.push(Date.now() - chunkStart);
			const isLast = i === slices.length - 1;
			await patchPipelinePhase(context.videoId, "transcribe", {
				status: isLast ? "done" : "active",
				done: i + 1,
				total: slices.length,
				unitTimesMs: [...unitTimesMs],
				...(isLast ? { completedAt: new Date().toISOString() } : {}),
			});
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
		// videos table has no errorMessage column — persist the human-readable
		// reason into metadata (read-modify-write) alongside the ERROR status so
		// UI revalidation can surface it.
		await markError(videoId, "Transkripsiya juda uzun — qayta urinib ko'ring");
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
			// nothing to index — flip the phase done so the strip doesn't hang
			await patchPipelinePhase(videoId, "index", {
				status: "done",
				done: 0,
				total: 0,
				completedAt: new Date().toISOString(),
			});
			return;
		}

		const resolvedApiKey = apiKey;

		// index phase: embeddings are produced in one batched call here, so we
		// record total = chunk count and one wall-clock unit time for the batch.
		const indexStartedAt = new Date().toISOString();
		const indexStart = Date.now();
		await patchPipelinePhase(videoId, "index", {
			status: "active",
			done: 0,
			total: chunks.length,
			startedAt: indexStartedAt,
		});

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

		await patchPipelinePhase(videoId, "index", {
			status: "done",
			done: chunks.length,
			total: chunks.length,
			completedAt: new Date().toISOString(),
			unitTimesMs: [Date.now() - indexStart],
		});

		console.log(
			`[transcribe] Stored ${rows.length} transcript chunks for video ${videoId}`,
		);
	} catch (error) {
		// RAG indexing is best-effort; transcription stays COMPLETE. Flip the
		// index phase to error so the strip reflects reality without failing the run.
		await patchPipelinePhase(videoId, "index", {
			status: "error",
		}).catch(() => {});
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
