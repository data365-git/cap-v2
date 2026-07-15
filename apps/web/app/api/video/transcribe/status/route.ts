import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
	const user = await getCurrentUser();
	const url = new URL(request.url);
	const videoId = url.searchParams.get("videoId") as Video.VideoId;

	if (!user) {
		return Response.json({ auth: false }, { status: 401 });
	}

	if (!videoId) {
		return Response.json(
			{ error: true, message: "videoId not supplied" },
			{ status: 400 },
		);
	}

	const video = await db().select().from(videos).where(eq(videos.id, videoId));

	if (video.length === 0 || !video[0]) {
		return Response.json(
			{ error: true, message: "Video does not exist" },
			{ status: 404 },
		);
	}

	if (video[0].ownerId !== user.id) {
		return Response.json(
			{ error: true, message: "Forbidden" },
			{ status: 403 },
		);
	}

	// Upload phase is set to "processing" the moment the pipeline is kicked off,
	// before the (slow) workflow enqueue. It is the reliable "processing has
	// actually started" signal — the client uses it to distinguish a genuine
	// start failure from a server action whose response merely timed out.
	const [upload] = await db()
		.select({
			phase: videoUploads.phase,
			processingError: videoUploads.processingError,
		})
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId));

	return Response.json(
		{
			transcriptionStatus: video[0].transcriptionStatus,
			phase: upload?.phase ?? null,
			processingError: upload?.processingError ?? null,
		},
		{ status: 200 },
	);
}
