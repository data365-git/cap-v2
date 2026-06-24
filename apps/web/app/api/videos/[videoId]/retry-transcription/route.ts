import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { revalidatePath } from "next/cache";
import { runPromise } from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { decodeStorageVideo } from "@/lib/video-storage";

export async function POST(
	request: Request,
	props: RouteContext<"/api/videos/[videoId]/retry-transcription">,
) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const force =
			new URL(request.url).searchParams.get("force") === "1";

		// Verify user owns the video
		const videoQuery = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		if (videoQuery.length === 0) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		const video = videoQuery[0];
		if (!video || video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		if (!serverEnv().GEMINI_API_KEY) {
			return Response.json(
				{ error: "Transcription is not configured on this server" },
				{ status: 503 },
			);
		}

		// Gate: if status is COMPLETE we normally block retry. Allow when:
		//  - ?force=1 (explicit owner override from the Generate strip), or
		//  - the saved transcript text is suspiciously short (< 200 chars),
		//    a rough proxy for truncated/empty transcription.
		let retryReason:
			| "force"
			| "short-transcript"
			| "error-or-skipped"
			| "not-complete"
			| null = null;

		if (force) {
			retryReason = "force";
		} else if (video.transcriptionStatus !== "COMPLETE") {
			// ERROR / SKIPPED / null / PROCESSING all fall through here. The
			// existing path always permitted retry in these cases.
			retryReason = "error-or-skipped";
		} else {
			// COMPLETE — only retry if transcript text is suspiciously short.
			const vtt = await Effect.gen(function* () {
				const [bucket] = yield* Storage.getAccessForVideo(
					decodeStorageVideo(video),
				);
				return yield* bucket.getObject(
					`${video.ownerId}/${videoId}/transcription.vtt`,
				);
			}).pipe(runPromise);

			const transcriptText = Option.isSome(vtt)
				? vtt.value
						.replace(/WEBVTT[\s\S]*?\n\n/, "")
						.replace(/\d{2}:\d{2}:\d{2}\.\d{3} --> \d{2}:\d{2}:\d{2}\.\d{3}/g, "")
						.replace(/\s+/g, " ")
						.trim()
				: "";

			if (transcriptText.length < 200) {
				retryReason = "short-transcript";
			}
		}

		if (!retryReason) {
			return Response.json(
				{
					error:
						"Transcription is already complete. Pass ?force=1 to re-run.",
					transcriptionStatus: video.transcriptionStatus,
				},
				{ status: 400 },
			);
		}

		console.info(
			`[CAP-RETRY] retry-transcription video=${videoId} reason=${retryReason}`,
		);

		// Reset status so transcribeVideo starts cleanly, then explicitly kick it
		// off on demand. (get-status no longer auto-starts transcription.)
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		// Pass aiGenerationEnabled=false: this only transcribes. Summary/Tasks/
		// Refined are generated separately via their own Generate buttons.
		transcribeVideo(videoId, video.ownerId, false).catch((error) => {
			console.error(
				`[retry-transcription] Error transcribing video ${videoId}:`,
				error,
			);
		});

		// Revalidate the video page to ensure UI updates with fresh data
		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: true,
			message: "Transcription started",
		});
	} catch (error) {
		console.error("Error resetting transcription status:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
