// TEMPORARY debug route — token-gated. Dumps videoUploads rows (which remain
// ONLY for failed/incomplete uploads — successful ones are deleted on complete)
// plus recent videos, to diagnose why uploads don't land in R2. DELETE after.
import { db } from "@cap/database";
import { videoUploads, videos } from "@cap/database/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

const TOKEN = "diag-9f3a2c7b";

export async function GET(req: Request) {
	const url = new URL(req.url);
	if (url.searchParams.get("token") !== TOKEN) {
		return Response.json({ error: "forbidden" }, { status: 403 });
	}

	const uploads = await db()
		.select()
		.from(videoUploads)
		.orderBy(desc(videoUploads.updatedAt))
		.limit(40);

	const recentVideos = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			source: videos.source,
			duration: videos.duration,
			createdAt: videos.createdAt,
		})
		.from(videos)
		.orderBy(desc(videos.createdAt))
		.limit(30);

	return Response.json({
		videoUploadsCount: uploads.length,
		videoUploads: uploads,
		recentVideos,
	});
}
