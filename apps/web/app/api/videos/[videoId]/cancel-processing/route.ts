import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Cancel an in-flight transcription.
 *
 * The pipeline runs as a fire-and-forget background workflow that can't be
 * force-killed from here, so this is cooperative: it sets a durable
 * `cancelRequested` marker and flips the status to CANCELLED immediately (for
 * instant UI feedback). The workflow checks the marker between chunk batches and
 * unwinds before the next Gemini call, so the spend stops within one chunk.
 */
export async function POST(
	_request: Request,
	props: { params: Promise<{ videoId: string }> },
) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const [video] = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}
		if (video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		// Nothing in flight to cancel — don't clobber a finished result.
		if (
			video.transcriptionStatus === "COMPLETE" ||
			video.transcriptionStatus === "SKIPPED" ||
			video.transcriptionStatus === "NO_AUDIO"
		) {
			return Response.json(
				{
					error: "Transcription already finished; nothing to cancel.",
					transcriptionStatus: video.transcriptionStatus,
				},
				{ status: 409 },
			);
		}

		const metadata = (video.metadata as VideoMetadata) || {};
		await db()
			.update(videos)
			.set({
				transcriptionStatus: "CANCELLED",
				metadata: { ...metadata, cancelRequested: true },
			})
			.where(eq(videos.id, videoId));

		revalidatePath(`/s/${videoId}`);

		return Response.json({ success: true, message: "Cancellation requested" });
	} catch (error) {
		console.error("[cancel-processing] error:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
