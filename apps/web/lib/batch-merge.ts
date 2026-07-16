import type { VideoMetadata } from "@cap/database/types";

// Pure merge/idempotency helpers for the durable Batch collector cron. Kept in
// their own module (no db/storage/workflow imports) so they are cheap to unit
// test without pulling in the route's heavy dependency graph.

export type BatchJob = NonNullable<VideoMetadata["aiBatchJobs"]>[number];

/** Remove one job (by batchName) from a jobs array. */
export function removeBatchJob(
	jobs: BatchJob[] | undefined,
	batchName: string,
): BatchJob[] {
	return (jobs ?? []).filter((j) => j.batchName !== batchName);
}

/**
 * Idempotently drop a collected Batch chunk onto the `completedChunks` checkpoint
 * grid at its chunk index. cap-v2 resumes transcription by chunk index (the VTT
 * is already absolute-timed by the collector), so a re-collection of the same
 * chunk simply overwrites the same slot — re-running the cron after a crash
 * between merge and job-removal never duplicates cues. Returns a NEW record
 * (never mutates the input) so the caller can read-modify-write metadata safely.
 */
export function mergeCollectedChunkIntoCompletedChunks(
	completedChunks: Record<string, string> | undefined,
	chunkIndex: number,
	chunkVtt: string,
): Record<string, string> {
	return { ...(completedChunks ?? {}), [String(chunkIndex)]: chunkVtt };
}
