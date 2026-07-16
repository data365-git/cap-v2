import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { cancelBatch, deleteBatchFile } from "@/lib/gemini-batch-transcribe";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";

/**
 * Best-effort abandon of any pending durable Batch jobs on a paid takeover (the
 * patience-window flip and the manual "Transcribe now (paid)" button). Cancels
 * each Batch and deletes its uploaded Files API object with the SERVER paid key.
 * Never throws — a cleanup failure must not block the fast continuation, and any
 * already-collected chunks (in completedChunks) are kept; only the pending jobs
 * are dropped by the caller via `aiBatchJobs: undefined`.
 */
export async function abandonPendingBatchJobs(
	metadata: VideoMetadata,
): Promise<void> {
	const jobs = metadata.aiBatchJobs;
	if (!Array.isArray(jobs) || jobs.length === 0) return;
	const paidKey = serverEnv().GEMINI_API_KEY;
	if (!paidKey) return;
	await Promise.allSettled(
		jobs.flatMap((job) => [
			cancelBatch(job.batchName, paidKey),
			deleteBatchFile(job.fileName, paidKey),
		]),
	);
}

export type AiJobPhase = "transcription" | "generation";

type ContinueOnPaidResult = {
	success: boolean;
	message: string;
};

/**
 * Force a parked cheap-mode video onto the paid synchronous tier. Abandons any
 * pending Batch jobs (so a cancelled-but-alive Batch never keeps spending), flips
 * the video to `fast`, clears the quota-wait markers, and re-runs the relevant
 * pipeline stage from its checkpoint. Already-collected chunks in
 * `completedChunks` survive, so paid Standard only redoes what's left.
 */
export async function continueAiJobOnPaid({
	videoId,
	ownerId,
	phase,
}: {
	videoId: Video.VideoId;
	ownerId: string;
	phase: AiJobPhase;
}): Promise<ContinueOnPaidResult> {
	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!row) {
		return { success: false, message: "Video does not exist" };
	}

	const metadata = (row.metadata as VideoMetadata) || {};

	// Cancel + delete any pending Batch inputs before paid Standard repeats the
	// chunk. Best-effort: never blocks the continuation.
	await abandonPendingBatchJobs(metadata);

	const nextMetadata: VideoMetadata = {
		...metadata,
		aiMode: "fast",
		aiQuotaWaiting: undefined,
		aiBatchJobs: undefined,
		aiProcessingStartedAt: undefined,
	};

	if (phase === "transcription") {
		await db()
			.update(videos)
			.set({ transcriptionStatus: null, metadata: nextMetadata })
			.where(eq(videos.id, videoId));
		return transcribeVideo(videoId, ownerId, true, false, "fast");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...nextMetadata,
				aiGenerationStatus: undefined,
			} satisfies VideoMetadata,
		})
		.where(eq(videos.id, videoId));
	return startAiGeneration(videoId, ownerId, true);
}
