import type { VideoMetadata } from "@cap/database/types";

// Pure decision helpers for the opt-in cheap/Batch transcription park. Kept
// dependency-free so the "strand vs fail-safe" and "resume-skip" logic that
// guards REAL Gemini billing is unit-testable in isolation from the workflow.

export const CHEAP_NO_PAID_KEY_MESSAGE =
	"Cheap transcription hit the free-tier quota but no paid GEMINI_API_KEY is configured to fall back to. Set GEMINI_API_KEY or switch the organization to fast mode.";

/**
 * Decide what a cheap-mode transcription must do when it hits the free-tier
 * quota wall. The durable park (PROCESSING + aiQuotaWaiting) is only RECOVERABLE
 * when a paid GEMINI_API_KEY exists: the poll-batch-jobs cron collects the Batch
 * result with it, and the patience window auto-continues on it. With NO paid key
 * there is nothing to collect and no paid tier to fall back to, so parking would
 * strand the video in PROCESSING forever — fail safe to ERROR instead.
 */
export function cheapWallDisposition(paidKeyPresent: boolean): "park" | "fail" {
	return paidKeyPresent ? "park" : "fail";
}

/**
 * Chunk indices already present in the `completedChunks` checkpoint — the durable
 * resume grid. A re-run (cheap re-kick, paid takeover via continue-paid, retry)
 * SKIPS these instead of re-transcribing and re-billing them. Pure + validated so
 * the skip logic is unit-testable without the workflow's heavy dependency graph.
 */
export function resumableChunkIndices(
	sliceCount: number,
	completedChunks: VideoMetadata["completedChunks"] | undefined,
): number[] {
	if (!completedChunks) return [];
	const done: number[] = [];
	for (let i = 0; i < sliceCount; i++) {
		const v = completedChunks[String(i)];
		if (typeof v === "string" && v.length > 0) done.push(i);
	}
	return done;
}
