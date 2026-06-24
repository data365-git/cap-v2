"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Schedule } from "effect";
import { runPromise } from "@/lib/server";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { decodeStorageVideo } from "@/lib/video-storage";

async function verifyRawFileUploaded(
	video: typeof videos.$inferSelect,
	rawFileKey: string,
) {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);
	try {
		// A browser PUT can return 200 a moment before the object is visible to a
		// server-side HEAD (R2 read-after-write timing). Retry generously (~8s)
		// before giving up.
		const head = await bucket
			.headObject(rawFileKey)
			.pipe(
				Effect.retry({ times: 8, schedule: Schedule.spaced("1 seconds") }),
				runPromise,
			);

		if ((head.ContentLength ?? 0) <= 0) {
			throw new Error("Uploaded video file is empty");
		}
	} catch (err) {
		// Don't block processing on a failed pre-flight check. The processing
		// workflow fetches the raw file itself and will surface a proper, durable
		// error on the video if it is genuinely missing — whereas throwing here
		// dead-ends a successful upload with "processing failed to start".
		console.warn(
			`[CAP-IMPORT] verifyRawFileUploaded could not confirm ${rawFileKey}; proceeding to start processing anyway:`,
			err,
		);
	}
}

export async function triggerVideoProcessing({
	videoId,
	rawFileKey,
	bucketId,
}: {
	videoId: Video.VideoId;
	rawFileKey: string;
	bucketId: string | null;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Unauthorized");

	await verifyRawFileUploaded(video, rawFileKey);

	await startVideoProcessingWorkflow({
		videoId,
		userId: user.id,
		rawFileKey,
		bucketId,
		processingMessage: "Starting video processing...",
		startFailureMessage: "Video processing could not start.",
	});

	return { success: true };
}
