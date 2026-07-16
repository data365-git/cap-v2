"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { patchVideoMetadata } from "@/lib/video-metadata";

export async function editTitle(videoId: Video.VideoId, title: string) {
	const user = await getCurrentUser();

	const trimmed = typeof title === "string" ? title.trim() : "";
	if (!user || !trimmed || !videoId) {
		throw new Error("Missing required data for updating video title");
	}
	if (trimmed.length > 255) {
		throw new Error("Title must be 255 characters or fewer");
	}

	const userId = user.id;
	const query = await db().select().from(videos).where(eq(videos.id, videoId));

	if (query.length === 0) {
		throw new Error("Video not found");
	}

	const video = query[0];
	if (!video) {
		throw new Error("Video not found");
	}

	if (video.ownerId !== userId) {
		throw new Error("You don't have permission to update this video");
	}

	try {
		// `name` is a plain column write; the metadata flag is a read-modify-write,
		// so keep them as separate statements and route the metadata mutation
		// through the atomic row-locked helper to avoid clobbering a concurrent
		// metadata writer (e.g. the AI workflow setting aiTitle).
		await db()
			.update(videos)
			.set({ name: trimmed })
			.where(eq(videos.id, videoId));

		await patchVideoMetadata(videoId, (current) => ({
			...current,
			titleManuallyEdited: true,
		}));

		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/shared-caps");
		revalidatePath(`/s/${videoId}`);

		return { success: true };
	} catch (error) {
		console.error("Error updating video title:", error);
		if (error instanceof Error) {
			throw new Error(error.message);
		}
		throw new Error("Failed to update video title");
	}
}
