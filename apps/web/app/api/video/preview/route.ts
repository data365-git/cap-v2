import { provideOptionalAuth, Storage, Videos } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Effect, Option } from "effect";
import { type NextRequest, NextResponse } from "next/server";
import { runPromise } from "@/lib/server";

export const dynamic = "force-dynamic";

const PREVIEW_GIF_EXPIRES_SECONDS = 60 * 60;

function getPreviewGifKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/preview/animated-preview.gif`;
}

function getScreenshotKey(ownerId: string, videoId: string) {
	return `${ownerId}/${videoId}/screenshot/screen-capture.jpg`;
}

function getFallbackResponse(request: NextRequest, videoId: string) {
	if (request.nextUrl.searchParams.get("fallback") !== "og") {
		return new NextResponse(null, { status: 404 });
	}

	const fallbackUrl = new URL("/api/video/og", request.url);
	fallbackUrl.searchParams.set("videoId", videoId);
	const response = NextResponse.redirect(fallbackUrl, 302);
	response.headers.set("Cache-Control", "private, no-store, max-age=0");
	return response;
}

export async function GET(request: NextRequest) {
	const rawVideoId = request.nextUrl.searchParams.get("videoId");
	if (!rawVideoId) {
		return new NextResponse(null, { status: 400 });
	}

	const videoId = Video.VideoId.make(rawVideoId);
	let previewUrl: string | null;
	try {
		previewUrl = await Effect.gen(function* () {
			const videos = yield* Videos;
			const maybeVideo = yield* videos.getByIdForViewing(videoId);
			if (Option.isNone(maybeVideo)) return null;

			const [video] = maybeVideo.value;
			const [bucket] = yield* Storage.getAccessForVideo(video);

			// Prefer the animated GIF preview; fall back to the static screenshot
			// (screen-capture.jpg) when no GIF exists. Recordings with neither
			// return null → the client renders a frame via VideoFrameFallback.
			for (const key of [
				getPreviewGifKey(video.ownerId, video.id),
				getScreenshotKey(video.ownerId, video.id),
			]) {
				const exists = yield* bucket.headObject(key).pipe(
					Effect.as(true),
					Effect.catchAll(() => Effect.succeed(false)),
				);
				if (exists) {
					return yield* bucket.getSignedObjectUrl(key, {
						expiresIn: PREVIEW_GIF_EXPIRES_SECONDS,
					});
				}
			}

			return null;
		}).pipe(provideOptionalAuth, runPromise);
	} catch (error) {
		console.warn("[video/preview] Failed to resolve preview GIF:", error);
		return new NextResponse(null, { status: 404 });
	}

	if (!previewUrl) {
		return getFallbackResponse(request, rawVideoId);
	}

	const response = NextResponse.redirect(previewUrl, 302);
	response.headers.set("Cache-Control", "public, max-age=300");
	return response;
}

export const HEAD = GET;
