"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import { Storage as StorageService } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

export async function cancelUpload({ videoId }: { videoId: string }) {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const vid = await db()
		.select()
		.from(videos)
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.ownerId, user.id),
			),
		)
		.limit(1);

	if (vid.length === 0) return { success: true }; // already gone — idempotent

	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
	const videoRow = vid[0]!;

	const upload = await db()
		.select({ rawFileKey: videoUploads.rawFileKey, phase: videoUploads.phase })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId as Video.VideoId))
		.limit(1);

	const uploadRow = upload[0];

	// Only cancel if still in pre-transcription state (uploading phase or no transcription started)
	if (uploadRow && uploadRow.phase !== "uploading") {
		return { success: false, error: "Processing already started" };
	}

	// Best-effort delete the raw file from S3
	if (uploadRow?.rawFileKey) {
		try {
			const videoDomain = Video.Video.decodeSync({
				...videoRow,
				bucketId: videoRow.bucket,
				storageIntegrationId: videoRow.storageIntegrationId,
				createdAt: videoRow.createdAt.toISOString(),
				updatedAt: videoRow.updatedAt.toISOString(),
				metadata: videoRow.metadata,
			});
			await Effect.gen(function* () {
				const [bucket] = yield* StorageService.getAccessForVideo(videoDomain);
				yield* bucket.deleteObject(uploadRow.rawFileKey as string);
			}).pipe(runPromise);
		} catch (err) {
			console.warn("[cancel-upload] S3 delete failed (best effort):", err);
		}
	}

	// Delete the video row (cascades to videoUploads)
	await db()
		.delete(videos)
		.where(
			and(
				eq(videos.id, videoId as Video.VideoId),
				eq(videos.ownerId, user.id),
			),
		);

	return { success: true };
}
