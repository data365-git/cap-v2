import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { users, videos } from "@cap/database/schema";
import type { TranslationStatus, VideoMetadata } from "@cap/database/types";
import { isLanguageCode, type Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { after, type NextRequest } from "next/server";
import { translateAiContent } from "@/lib/translate-ai";
import { isAiGenerationEnabled } from "@/utils/flags";

export const dynamic = "force-dynamic";

/**
 * POST — owner-only. Requests an on-demand translation of the video's stored AI
 * summary + transcript into `language`, cached additively under
 * `metadata.translations[language]`. Runs the translation in the background
 * (after the response) and returns the current status.
 */
export async function POST(
	request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/translate">,
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

		let body: { language?: unknown };
		try {
			body = await request.json();
		} catch {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}

		if (!isLanguageCode(body.language)) {
			return Response.json(
				{ error: "invalid or unsupported language" },
				{ status: 400 },
			);
		}
		const language = body.language;

		const videoQuery = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		const video = videoQuery[0];
		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		if (video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		const ownerQuery = await db()
			.select({
				email: users.email,
				stripeSubscriptionStatus: users.stripeSubscriptionStatus,
				thirdPartyStripeSubscriptionId: users.thirdPartyStripeSubscriptionId,
			})
			.from(users)
			.where(eq(users.id, video.ownerId))
			.limit(1);

		if (!ownerQuery[0] || !(await isAiGenerationEnabled(ownerQuery[0]))) {
			return Response.json(
				{ error: "AI generation feature is not available for this user" },
				{ status: 403 },
			);
		}

		const metadata = (video.metadata as VideoMetadata) || {};

		if (!metadata.aiSummary) {
			return Response.json(
				{ error: "No AI summary to translate. Generate AI content first." },
				{ status: 409 },
			);
		}

		const existing = metadata.translations?.[language];

		if (existing?.status === "COMPLETE" && existing.aiSummary) {
			return Response.json({ status: "COMPLETE" });
		}
		if (existing?.status === "PROCESSING") {
			return Response.json({ status: "PROCESSING" });
		}

		const run = () =>
			translateAiContent({
				videoId,
				userId: video.ownerId,
				language,
			}).catch((err) => {
				console.error("[translate route] translateAiContent failed", {
					videoId,
					language,
					err,
				});
			});

		try {
			after(run);
		} catch {
			void run();
		}

		return Response.json({ status: "PROCESSING" });
	} catch (error) {
		console.error("[translate/route] POST error:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}

/**
 * GET — poll translation status for `?language=`. Readable by anyone who can
 * reach the video row (share pages are already gated upstream); returns only
 * the status + whether translated content exists.
 */
export async function GET(
	request: NextRequest,
	props: RouteContext<"/api/videos/[videoId]/translate">,
) {
	try {
		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const rawLanguage = new URL(request.url).searchParams.get("language");
		if (!isLanguageCode(rawLanguage)) {
			return Response.json(
				{ error: "invalid or unsupported language" },
				{ status: 400 },
			);
		}

		const videoQuery = await db()
			.select({ metadata: videos.metadata })
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		const video = videoQuery[0];
		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		const metadata = (video.metadata as VideoMetadata) || {};
		const entry = metadata.translations?.[rawLanguage];

		return Response.json({
			status: (entry?.status ?? null) as TranslationStatus | null,
			hasContent: Boolean(entry?.aiSummary),
		});
	} catch (error) {
		console.error("[translate/route] GET error:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
