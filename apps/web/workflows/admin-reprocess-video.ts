// Media server removed — admin video reprocessing is no longer available
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { FatalError } from "workflow";

interface AdminReprocessVideoWorkflowPayload {
	videoId: string;
}

export async function adminReprocessVideoWorkflow(
	payload: AdminReprocessVideoWorkflowPayload,
): Promise<{ success: boolean; message: string }> {
	"use workflow";

	const { videoId } = payload;

	try {
		// Media server removed — server-side video reprocessing is not available
		const [video] = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(eq(videos.id, Video.VideoId.make(videoId)));

		if (!video) {
			throw new FatalError("Video does not exist");
		}

		// Clean up any existing upload records
		await db()
			.delete(videoUploads)
			.where(eq(videoUploads.videoId, videoId as Video.VideoId));

		return {
			success: false,
			message: "Video reprocessing is not available in this version.",
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await setReprocessError(videoId, errorMessage);
		throw new FatalError(errorMessage);
	}
}

async function setReprocessError(
	videoId: string,
	errorMessage: string,
): Promise<void> {
	"use step";

	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingProgress: 0,
			processingMessage: "Admin reprocess failed",
			processingError: errorMessage,
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId as Video.VideoId));
}
