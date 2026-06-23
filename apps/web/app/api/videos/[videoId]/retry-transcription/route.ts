import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { transcribeVideo } from "@/lib/transcribe";

export async function POST(
	_request: Request,
	props: RouteContext<"/api/videos/[videoId]/retry-transcription">,
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

		// Verify user owns the video
		const videoQuery = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		if (videoQuery.length === 0) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		const video = videoQuery[0];
		if (!video || video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		if (!serverEnv().GEMINI_API_KEY) {
			return Response.json(
				{ error: "Transcription is not configured on this server" },
				{ status: 503 },
			);
		}

		// Reset status so transcribeVideo starts cleanly, then explicitly kick it
		// off on demand. (get-status no longer auto-starts transcription.)
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		// Pass aiGenerationEnabled=false: this only transcribes. Summary/Tasks/
		// Refined are generated separately via their own Generate buttons.
		transcribeVideo(videoId, video.ownerId, false).catch((error) => {
			console.error(
				`[retry-transcription] Error transcribing video ${videoId}:`,
				error,
			);
		});

		// Revalidate the video page to ensure UI updates with fresh data
		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: true,
			message: "Transcription started",
		});
	} catch (error) {
		console.error("Error resetting transcription status:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
