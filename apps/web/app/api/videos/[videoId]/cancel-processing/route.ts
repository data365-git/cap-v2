import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { patchVideoMetadata } from "@/lib/video-metadata";

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

		// transcriptionStatus is a plain column write; the durable cancelRequested
		// marker (which the transcribe workflow polls) is a read-modify-write, so
		// route it through the atomic row-locked helper to avoid clobbering a
		// concurrent workflow metadata write (pipelineProgress/completedChunks).
		await db()
			.update(videos)
			.set({ transcriptionStatus: "CANCELLED" })
			.where(eq(videos.id, videoId));

		await patchVideoMetadata(videoId, (current) => ({
			...current,
			cancelRequested: true,
		}));

		revalidatePath(`/s/${videoId}`);

		return Response.json({ success: true, message: "Cancellation requested" });
	} catch (error) {
		console.error("[cancel-processing] error:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
