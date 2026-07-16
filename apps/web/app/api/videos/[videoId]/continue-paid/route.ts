import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { type AiJobPhase, continueAiJobOnPaid } from "@/lib/ai-job-control";

export const dynamic = "force-dynamic";

// Owner-triggered "Transcribe now (paid)": force a parked cheap-mode video off
// the free/Batch wait and onto the paid synchronous tier. Uses the explicit
// params signature (NOT RouteContext) so it typechecks under bare `tsc -b`.
export async function POST(
	request: Request,
	props: { params: Promise<{ videoId: string }> },
) {
	try {
		const { videoId } = await props.params;
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const [video] = await db()
			.select({
				id: videos.id,
				ownerId: videos.ownerId,
				transcriptionStatus: videos.transcriptionStatus,
				metadata: videos.metadata,
			})
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId))
			.limit(1);

		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		if (video.ownerId !== user.id) {
			return Response.json({ error: "Forbidden" }, { status: 403 });
		}

		const metadata = (video.metadata as VideoMetadata) || {};
		const aiGenerationStatus = metadata.aiGenerationStatus;
		const phase: AiJobPhase | null =
			video.transcriptionStatus === "PROCESSING"
				? "transcription"
				: aiGenerationStatus === "PROCESSING" || aiGenerationStatus === "QUEUED"
					? "generation"
					: null;

		if (metadata.aiMode !== "cheap" || !phase) {
			return Response.json(
				{ error: "No running cheap-mode AI job to continue" },
				{ status: 409 },
			);
		}

		const result = await continueAiJobOnPaid({
			videoId: videoId as Video.VideoId,
			ownerId: video.ownerId,
			phase,
		});

		if (!result.success) {
			return Response.json({ error: result.message }, { status: 500 });
		}

		revalidatePath(`/s/${videoId}`);
		return Response.json({ success: true });
	} catch (error) {
		console.error("[continue-paid/route] Unexpected error:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
