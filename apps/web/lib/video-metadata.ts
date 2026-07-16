import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/**
 * Read-modify-write a video's `metadata` JSON so sibling fields (aiSummary,
 * completedChunks, pipelineProgress…) are never clobbered. Takes an updater that
 * receives the current metadata and returns the next one, so callers outside the
 * transcribe workflow (the Batch collector cron, the paid-takeover control) can
 * mutate metadata safely. Mirrors the workflow's private patch helper but is
 * import-safe from route/lib code (no workflow directives).
 */
export async function patchVideoMetadata(
	videoId: string,
	updater: (current: VideoMetadata) => VideoMetadata,
): Promise<VideoMetadata> {
	const [row] = await db()
		.select({ metadata: videos.metadata })
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId))
		.limit(1);

	const current = (row?.metadata as VideoMetadata) || {};
	const next = updater(current);

	await db()
		.update(videos)
		.set({ metadata: next })
		.where(eq(videos.id, videoId as Video.VideoId));

	return next;
}
