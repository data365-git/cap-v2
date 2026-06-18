// Media server removed — video editing requires server-side processing which is no longer available
import { db } from "@cap/database";
import { videoUploads } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { FatalError } from "workflow";
import type {
	VideoEditRange,
	VideoEditSpec,
} from "@cap/database/types";

interface EditVideoWorkflowPayload {
	videoId: string;
	userId: string;
	sourceKey: string;
	previousSpec: VideoEditSpec;
	editSpec: VideoEditSpec;
	keepRanges: VideoEditRange[];
	aiGenerationEnabled: boolean;
}

interface VideoEditRenderResult {
	metadata: {
		duration: number;
		width: number;
		height: number;
		fps: number;
	};
}

export async function editVideoWorkflow(
	payload: EditVideoWorkflowPayload,
): Promise<VideoEditRenderResult> {
	"use workflow";

	const { videoId, sourceKey } = payload;

	try {
		// Media server removed — server-side video editing is not available
		await clearEditProcessingState(videoId, sourceKey);
		throw new FatalError(
			"Video editing is not available in this version.",
		);
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		await clearEditProcessingState(videoId, sourceKey);
		throw new FatalError(errorMessage);
	}
}

async function clearEditProcessingState(
	videoId: string,
	sourceKey: string,
): Promise<void> {
	"use step";

	await db()
		.delete(videoUploads)
		.where(
			and(
				eq(videoUploads.videoId, videoId as Video.VideoId),
				eq(videoUploads.rawFileKey, sourceKey),
			),
		);
}
