import * as Db from "@cap/database/schema";
import {
	Database,
	provideOptionalAuth,
	Storage,
	Videos,
} from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import {
	HttpApi,
	HttpApiBuilder,
	HttpApiEndpoint,
	HttpApiError,
	HttpApiGroup,
	HttpServerRequest,
	HttpServerResponse,
} from "@effect/platform";
import { eq } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";
import { apiToHandler } from "@/lib/server";
import { CACHE_CONTROL_HEADERS } from "@/utils/helpers";

export const dynamic = "force-dynamic";

const GetPlaylistParams = Schema.Struct({
	videoId: Video.VideoId,
	videoType: Schema.Literal(
		"mp4",
		"raw-preview",
		"segments-master",
		"segments-video",
		"segments-audio",
	),
	requireComplete: Schema.OptionFromUndefinedOr(Schema.String),
	thumbnail: Schema.OptionFromUndefinedOr(Schema.String),
	fileType: Schema.OptionFromUndefinedOr(Schema.String),
});

class Api extends HttpApi.make("CapWebApi").add(
	HttpApiGroup.make("root").add(
		HttpApiEndpoint.get("getVideoSrc")`/api/playlist`
			.setUrlParams(GetPlaylistParams)
			.addError(HttpApiError.Forbidden)
			.addError(HttpApiError.BadRequest)
			.addError(HttpApiError.Unauthorized)
			.addError(HttpApiError.InternalServerError)
			.addError(HttpApiError.NotFound),
	),
) {}

const ApiLive = HttpApiBuilder.api(Api).pipe(
	Layer.provide(
		HttpApiBuilder.group(Api, "root", (handlers) =>
			Effect.gen(function* () {
				const storage = yield* Storage;
				const videos = yield* Videos;

				return handlers.handle("getVideoSrc", ({ urlParams }) =>
					Effect.gen(function* () {
						const [video] = yield* videos
							.getByIdForViewing(urlParams.videoId)
							.pipe(
								Effect.flatten,
								Effect.catchTag(
									"NoSuchElementException",
									() => new HttpApiError.NotFound(),
								),
							);

						return yield* getPlaylistResponse(video, urlParams);
					}).pipe(
						provideOptionalAuth,
						Effect.tapErrorCause(Effect.logError),
						Effect.catchTags({
							VerifyVideoPasswordError: () => new HttpApiError.Forbidden(),
							PolicyDenied: () => new HttpApiError.Unauthorized(),
							DatabaseError: () => new HttpApiError.InternalServerError(),
							StorageError: () => new HttpApiError.InternalServerError(),
							UnknownException: () => new HttpApiError.InternalServerError(),
						}),
						Effect.provideService(Storage, storage),
					),
				);
			}),
		),
	),
);

const resolveRawPreviewKey = (video: Video.Video) =>
	Effect.gen(function* () {
		const db = yield* Database;
		const [bucket] = yield* Storage.getAccessForVideo(video);
		const [uploadRecord] = yield* db.use((db) =>
			db
				.select({ rawFileKey: Db.videoUploads.rawFileKey })
				.from(Db.videoUploads)
				.where(eq(Db.videoUploads.videoId, video.id)),
		);

		if (uploadRecord?.rawFileKey) {
			return uploadRecord.rawFileKey;
		}

		if (
			video.source.type !== "webMP4" &&
			video.source.type !== "extensionWeb"
		) {
			return yield* Effect.fail(new HttpApiError.NotFound());
		}

		const candidateKeys = [
			`${video.ownerId}/${video.id}/raw-upload.mp4`,
			`${video.ownerId}/${video.id}/raw-upload.webm`,
		];
		const headResults = yield* Effect.all(
			candidateKeys.map((key) => bucket.headObject(key).pipe(Effect.option)),
			{ concurrency: "unbounded" },
		);
		for (const [index, candidateKey] of candidateKeys.entries()) {
			const rawHead = headResults[index];
			if (
				rawHead &&
				Option.isSome(rawHead) &&
				(rawHead.value.ContentLength ?? 0) > 0
			) {
				return candidateKey;
			}
		}

		return yield* Effect.fail(new HttpApiError.NotFound());
	});

const getPlaylistResponse = (
	video: Video.Video,
	urlParams: (typeof GetPlaylistParams)["Type"],
) =>
	Effect.gen(function* () {
		const [bucket, customBucket] = yield* Storage.getAccessForVideo(video);
		const isMp4Source =
			video.source.type === "desktopMP4" ||
			video.source.type === "webMP4" ||
			video.source.type === "extensionWeb";
		const isAudioSource = video.source.type === "webAudio";

		// Stream an R2/S3 object through this same-origin endpoint instead of
		// 302-redirecting the browser straight to the bucket. This removes the
		// cross-origin (CORS) dependency entirely: the browser only ever talks to
		// our origin. HTTP Range requests are forwarded so the <video> element can
		// seek/scrub — R2 replies 206 + Content-Range, which we relay verbatim.
		// `defaultContentType` is used only when neither upstream nor headObject
		// reports one (e.g. octet-stream uploads). Default is video/mp4; pass an
		// audio MIME for webAudio sources so the browser dispatches the bytes to
		// <audio>.
		const proxyObject = (
			objectKey: string,
			defaultContentType: string = "video/mp4",
		) =>
			Effect.gen(function* () {
				const request = yield* HttpServerRequest.HttpServerRequest;

				// Presigned GET URLs are signed for the GET method only, so a HEAD
				// must use the internal client (headObject) rather than fetching the
				// signed URL with method HEAD (which would fail the SigV4 check).
				if (request.method === "HEAD") {
					const head = yield* bucket.headObject(objectKey).pipe(Effect.option);
					if (Option.isNone(head) || (head.value.ContentLength ?? 0) === 0) {
						return yield* Effect.fail(new HttpApiError.NotFound());
					}
					return HttpServerResponse.empty().pipe(
						HttpServerResponse.setHeaders({
							"Accept-Ranges": "bytes",
							"Content-Length": String(head.value.ContentLength ?? 0),
							"Content-Type": head.value.ContentType ?? defaultContentType,
						}),
					);
				}

				const signedUrl = yield* bucket.getSignedObjectUrl(objectKey);
				const range = request.headers.range;

				const upstream = yield* Effect.tryPromise({
					try: (signal) =>
						fetch(signedUrl, {
							headers: range ? { Range: range } : undefined,
							signal,
						}),
					catch: () => new HttpApiError.InternalServerError(),
				});

				if (!upstream.ok && upstream.status !== 206) {
					return yield* Effect.fail(
						upstream.status === 404
							? new HttpApiError.NotFound()
							: new HttpApiError.InternalServerError(),
					);
				}

				// fetch() Response headers are immutable, so build a fresh header
				// set forwarding exactly what the <video> element needs for seeking.
				const forwarded: Record<string, string> = {
					"Accept-Ranges": "bytes",
					"Content-Type":
						upstream.headers.get("content-type") ?? defaultContentType,
				};
				const pass = (from: string, to: string) => {
					const value = upstream.headers.get(from);
					if (value !== null) forwarded[to] = value;
				};
				pass("content-length", "Content-Length");
				pass("content-range", "Content-Range");
				pass("etag", "ETag");
				pass("last-modified", "Last-Modified");

				return HttpServerResponse.raw(upstream.body, {
					status: upstream.status,
					statusText: upstream.statusText,
					headers: forwarded,
				});
			});

		// webAudio: resolve the raw upload key (extension may be mp3/m4a/wav/…)
		// and pick a sensible audio default Content-Type.
		const AUDIO_EXT_TO_MIME: Record<string, string> = {
			mp3: "audio/mpeg",
			m4a: "audio/mp4",
			aac: "audio/aac",
			wav: "audio/wav",
			ogg: "audio/ogg",
			opus: "audio/opus",
			flac: "audio/flac",
		};
		const resolveAudioKey = (v: Video.Video) =>
			Effect.gen(function* () {
				const db = yield* Database;
				const [uploadRecord] = yield* db.use((db) =>
					db
						.select({ rawFileKey: Db.videoUploads.rawFileKey })
						.from(Db.videoUploads)
						.where(eq(Db.videoUploads.videoId, v.id)),
				);
				if (uploadRecord?.rawFileKey) {
					return uploadRecord.rawFileKey;
				}
				// Upload row may have been cleared after processing. Probe known
				// audio extensions under raw-upload.<ext>.
				const base = `${v.ownerId}/${v.id}/raw-upload`;
				for (const ext of Object.keys(AUDIO_EXT_TO_MIME)) {
					const key = `${base}.${ext}`;
					const head = yield* bucket.headObject(key).pipe(Effect.option);
					if (Option.isSome(head) && (head.value.ContentLength ?? 0) > 0) {
						return key;
					}
				}
				return yield* Effect.fail(new HttpApiError.NotFound());
			});
		const audioMimeForKey = (key: string): string => {
			const m = key.match(/\.([a-zA-Z0-9]+)$/);
			const ext = m?.[1]?.toLowerCase() ?? "";
			return AUDIO_EXT_TO_MIME[ext] ?? "audio/mpeg";
		};

		// The single-file recording is stored under a key that reflects its real
		// container: extension/web MediaRecorder uploads are usually WebM
		// (result.webm); desktop MP4 is result.mp4. Resolve whichever actually
		// exists so the key and the upload agree (fixes the result.mp4 404).
		//
		// `transcoded.mp4` is the server-rendered Safari-friendly variant
		// produced by the process-video workflow. Prefer it over the raw
		// upload whenever it exists so WebM-source videos play in Safari.
		const resolveResultKey = (v: Video.Video) =>
			Effect.gen(function* () {
				const base = `${v.ownerId}/${v.id}`;
				for (const key of [
					`${base}/transcoded.mp4`,
					`${base}/result.mp4`,
					`${base}/result.webm`,
				]) {
					const head = yield* bucket.headObject(key).pipe(Effect.option);
					if (Option.isSome(head) && (head.value.ContentLength ?? 0) > 0) {
						return Option.some(key);
					}
				}
				return Option.none<string>();
			});

		// webAudio sources have no transcoded video — the raw upload IS the audio
		// file. Bypass the mp4/webm/raw resolution dance and serve the audio file
		// directly with an audio Content-Type so <audio src=...> plays it.
		if (isAudioSource) {
			const audioKey = yield* resolveAudioKey(video);
			return yield* proxyObject(audioKey, audioMimeForKey(audioKey));
		}

		if (urlParams.videoType === "raw-preview") {
			const rawFileKey = yield* resolveRawPreviewKey(video);
			return yield* proxyObject(rawFileKey);
		}

		if (
			urlParams.videoType === "segments-master" ||
			urlParams.videoType === "segments-video" ||
			urlParams.videoType === "segments-audio"
		) {
			const segSource = new Video.SegmentsSource({
				videoId: video.id,
				ownerId: video.ownerId,
			});

			const manifestKey = segSource.getManifestKey();
			const manifestContent = yield* bucket.getObject(manifestKey).pipe(
				Effect.andThen(
					Option.match({
						onNone: () => Effect.fail(new HttpApiError.NotFound()),
						onSome: (c) => Effect.succeed(c),
					}),
				),
			);

			let parsed: unknown;
			try {
				parsed = JSON.parse(manifestContent);
			} catch {
				return yield* Effect.fail(new HttpApiError.InternalServerError());
			}

			const manifest = yield* Schema.decodeUnknown(Video.SegmentManifest)(
				parsed,
			).pipe(Effect.mapError(() => new HttpApiError.InternalServerError()));
			const requireComplete = Option.match(urlParams.requireComplete, {
				onNone: () => false,
				onSome: (value) => value === "1" || value === "true",
			});
			if (requireComplete && !manifest.is_complete) {
				return yield* Effect.fail(new HttpApiError.NotFound());
			}
			const hasVideoSegments =
				manifest.video_init_uploaded && manifest.video_segments.length > 0;

			if (urlParams.videoType === "segments-master") {
				if (!hasVideoSegments) {
					return yield* Effect.fail(new HttpApiError.NotFound());
				}

				const videoPlaylistUrl = `/api/playlist?videoId=${video.id}&videoType=segments-video`;
				const requireCompleteSuffix = requireComplete
					? "&requireComplete=1"
					: "";
				const audioPlaylistUrl =
					manifest.audio_init_uploaded && manifest.audio_segments.length > 0
						? `/api/playlist?videoId=${video.id}&videoType=segments-audio${requireCompleteSuffix}`
						: null;

				let playlist =
					"#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n";
				if (audioPlaylistUrl) {
					playlist += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="default",DEFAULT=YES,AUTOSELECT=YES,URI="${audioPlaylistUrl}"\n`;
					playlist += `#EXT-X-STREAM-INF:BANDWIDTH=2000000,AUDIO="audio"\n`;
				} else {
					playlist += "#EXT-X-STREAM-INF:BANDWIDTH=2000000\n";
				}
				playlist += `${videoPlaylistUrl}${requireCompleteSuffix}\n`;

				return HttpServerResponse.text(playlist, {
					headers: {
						...CACHE_CONTROL_HEADERS,
						"Content-Type": "application/vnd.apple.mpegurl",
					},
				});
			}

			const isVideo = urlParams.videoType === "segments-video";
			const initKey = isVideo
				? segSource.getVideoInitKey()
				: segSource.getAudioInitKey();
			const rawSegments = isVideo
				? manifest.video_segments
				: manifest.audio_segments;
			const segments = rawSegments.map(Video.normalizeSegmentEntry);
			const initUploaded = isVideo
				? manifest.video_init_uploaded
				: manifest.audio_init_uploaded;

			if (!initUploaded || segments.length === 0) {
				return yield* Effect.fail(new HttpApiError.NotFound());
			}

			const initUrl = yield* bucket.getSignedObjectUrl(initKey);
			const segmentUrls = yield* Effect.all(
				segments.map((seg) => {
					const key = isVideo
						? segSource.getVideoSegmentKey(seg.index)
						: segSource.getAudioSegmentKey(seg.index);
					return bucket.getSignedObjectUrl(key);
				}),
				{ concurrency: "unbounded" },
			);

			const targetDuration = Math.ceil(
				segments.reduce((max, seg) => Math.max(max, seg.duration), 0),
			);

			let playlist = `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:${Math.max(targetDuration, 1)}\n#EXT-X-MEDIA-SEQUENCE:0\n`;
			if (manifest.is_complete) {
				playlist += "#EXT-X-PLAYLIST-TYPE:VOD\n";
			}
			playlist += `#EXT-X-MAP:URI="${initUrl}"\n`;

			for (let i = 0; i < segmentUrls.length; i++) {
				const dur = segments[i]?.duration ?? 3.0;
				playlist += `#EXTINF:${dur.toFixed(3)},\n`;
				playlist += `${segmentUrls[i]}\n`;
			}

			if (manifest.is_complete) {
				playlist += "#EXT-X-ENDLIST\n";
			}

			return HttpServerResponse.text(playlist, {
				headers: {
					...CACHE_CONTROL_HEADERS,
					"Content-Type": "application/vnd.apple.mpegurl",
				},
			});
		}

		if (bucket.provider === "s3" && Option.isNone(customBucket)) {
			// Single-file recordings (desktop MP4, web/extension uploads) — proxy the
			// actual stored object (result.mp4 OR result.webm) same-origin, so there
			// is no CORS dependency and the browser receives the real Content-Type.
			if (isMp4Source || urlParams.videoType === "mp4") {
				const resultKey = yield* resolveResultKey(video);
				if (Option.isSome(resultKey)) {
					return yield* proxyObject(resultKey.value);
				}
				// result.* not present — fall back to the raw preview if available.
				const rawKey = yield* resolveRawPreviewKey(video).pipe(Effect.option);
				if (Option.isSome(rawKey)) {
					return yield* proxyObject(rawKey.value);
				}
				return yield* Effect.fail(new HttpApiError.NotFound());
			}

			// HLS sources keep redirecting to the bucket (the player resolves the
			// segment URLs embedded in the .m3u8 directly).
			const redirect =
				video.source.type === "MediaConvert"
					? `${video.ownerId}/${video.id}/output/video_recording_000.m3u8`
					: `${video.ownerId}/${video.id}/combined-source/stream.m3u8`;
			return HttpServerResponse.redirect(
				yield* bucket.getSignedObjectUrl(redirect),
			);
		}

		if (
			Option.isSome(urlParams.fileType) &&
			urlParams.fileType.value === "transcription"
		) {
			return yield* bucket
				.getObject(`${video.ownerId}/${video.id}/transcription.vtt`)
				.pipe(
					Effect.andThen(
						Option.match({
							onNone: () => new HttpApiError.NotFound(),
							onSome: (c) =>
								HttpServerResponse.text(c).pipe(
									HttpServerResponse.setHeaders({
										...CACHE_CONTROL_HEADERS,
										"Content-Type": "text/vtt",
									}),
								),
						}),
					),
					Effect.withSpan("fetchTranscription"),
				);
		}

		if (
			Option.isSome(urlParams.fileType) &&
			urlParams.fileType.value === "enhanced-audio"
		) {
			const enhancedAudioKey = `${video.ownerId}/${video.id}/enhanced-audio.mp3`;
			return yield* bucket.getSignedObjectUrl(enhancedAudioKey).pipe(
				Effect.map(HttpServerResponse.redirect),
				Effect.catchTag("StorageError", () => new HttpApiError.NotFound()),
				Effect.withSpan("fetchEnhancedAudio"),
			);
		}

		yield* Effect.log("Resolving path with custom bucket");

		if (isMp4Source) {
			const resultKey = yield* resolveResultKey(video);
			if (Option.isSome(resultKey)) {
				yield* Effect.log(`Returning path ${resultKey.value}`);
				return yield* proxyObject(resultKey.value);
			}
			return yield* Effect.fail(new HttpApiError.NotFound());
		}

		return yield* Effect.fail(new HttpApiError.NotFound());
	});

const handler = apiToHandler(ApiLive);

export const GET = (r: Request) => handler(r);
export const HEAD = (r: Request) => handler(r);
