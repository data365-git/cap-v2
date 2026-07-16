import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { patchVideoMetadata } from "@/lib/video-metadata";
import { refineVideoTimestampsWorkflow } from "@/workflows/transcribe";

// A PROCESSING refinement older than this is treated as a crashed run rather
// than genuinely in-flight, so a new request is allowed to proceed instead of
// being rejected forever.
const REFINE_STALE_MS = 30 * 60 * 1000;

/**
 * Opt-in per-video ElevenLabs Scribe timestamp refinement (owner-only).
 *
 * Fully DORMANT unless ELEVENLABS_API_KEY is configured: when the key is unset
 * this route makes no changes and returns a clear "not configured" response.
 *
 * The plain `props: { params: Promise<{ videoId: string }> }` signature is used
 * deliberately (instead of RouteContext) so tsc passes without the generated
 * Next route types.
 */
export async function POST(
	_request: Request,
	props: { params: Promise<{ videoId: string }> },
) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = await props.params;
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const videoQuery = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId as Video.VideoId))
			.limit(1);

		const video = videoQuery[0];
		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}
		if (video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		// Gate: the entire feature is dormant until a key is set. Nothing else
		// changes and no metadata is written.
		if (!serverEnv().ELEVENLABS_API_KEY) {
			return Response.json(
				{
					error: "Timestamp refinement is not configured",
					notConfigured: true,
				},
				{ status: 400 },
			);
		}

		if (video.transcriptionStatus !== "COMPLETE") {
			return Response.json(
				{
					error: "Cannot refine timestamps — transcription is not complete",
					transcriptionStatus: video.transcriptionStatus,
				},
				{ status: 400 },
			);
		}

		const metadata = (video.metadata as VideoMetadata) || {};
		const refine = {
			status: metadata.timestampRefineStatus,
			at: metadata.timestampRefinedAt,
		};
		if (refine.status === "PROCESSING") {
			const startedAt = refine.at ? new Date(refine.at).getTime() : 0;
			const stale = !startedAt || Date.now() - startedAt > REFINE_STALE_MS;
			if (!stale) {
				return Response.json(
					{ error: "Timestamp refinement is already in progress" },
					{ status: 409 },
				);
			}
		}

		// Flip to PROCESSING synchronously so the dashboard reflects the in-flight
		// state, then run the refinement inline (fire-and-forget) like the
		// transcription trigger. The workflow writes the terminal COMPLETE/ERROR.
		// Atomic row-locked read-modify-write so this flip cannot clobber a
		// concurrent metadata write (and vice versa).
		await patchVideoMetadata(videoId as Video.VideoId, (current) => ({
			...current,
			timestampRefineStatus: "PROCESSING",
			timestampRefineError: undefined,
			timestampRefinedAt: new Date().toISOString(),
		}));

		refineVideoTimestampsWorkflow({ videoId, userId: user.id }).catch((err) => {
			console.error(
				`[refine-timestamps] Inline workflow failed for video ${videoId}:`,
				err,
			);
		});

		revalidatePath("/dashboard/caps");
		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: true,
			message: "Timestamp refinement started",
		});
	} catch (error) {
		console.error("Error refining timestamps:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
