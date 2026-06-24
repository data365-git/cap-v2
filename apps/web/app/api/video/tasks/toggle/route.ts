import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

export async function POST(request: Request) {
	const user = await getCurrentUser();
	if (!user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const body = await request.json();
	const { videoId, taskIndex, done } = body as {
		videoId: unknown;
		taskIndex: unknown;
		done: unknown;
	};

	if (
		typeof videoId !== "string" ||
		!videoId ||
		typeof taskIndex !== "number" ||
		!Number.isInteger(taskIndex) ||
		taskIndex < 0 ||
		typeof done !== "boolean"
	) {
		return Response.json({ error: "Invalid request body" }, { status: 400 });
	}

	const videoQuery = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (videoQuery.length === 0 || !videoQuery[0]) {
		return Response.json({ error: "Video not found" }, { status: 404 });
	}

	const video = videoQuery[0];
	if (video.ownerId !== user.id) {
		return Response.json({ error: "Forbidden" }, { status: 403 });
	}

	const metadata = (video.metadata as VideoMetadata) || {};
	const tasks = metadata.aiSummary?.tasks;

	if (!tasks || taskIndex >= tasks.length) {
		return Response.json({ error: "Task index out of range" }, { status: 400 });
	}

	tasks[taskIndex].done = done;

	await db()
		.update(videos)
		.set({ metadata })
		.where(eq(videos.id, videoId));

	revalidatePath(`/s/${videoId}`);

	return Response.json({ ok: true });
}
