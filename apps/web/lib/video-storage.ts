import type { videos } from "@cap/database/schema";
import { Storage } from "@cap/web-backend";
import { Video } from "@cap/web-domain";
import { Option } from "effect";

type DbVideo = typeof videos.$inferSelect;

export const decodeStorageVideo = (video: DbVideo) =>
	Video.Video.make({
		...video,
		metadata: Option.fromNullable(video.metadata),
		bucketId: Option.fromNullable(video.bucket),
		storageIntegrationId: Option.fromNullable(video.storageIntegrationId),
		folderId: Option.fromNullable(video.folderId),
		transcriptionStatus: Option.fromNullable(video.transcriptionStatus),
		width: Option.fromNullable(video.width),
		height: Option.fromNullable(video.height),
		duration: Option.fromNullable(video.duration),
	});

/**
 * Resolve the storage bucket(s) for a raw DB video row. Thin wrapper over
 * `Storage.getAccessForVideo(decodeStorageVideo(video))` so server actions can
 * `.pipe(runPromise)` without re-decoding — and so the decode/access seam is a
 * single mockable import for unit tests. Returns `[bucket, customBucket]`.
 */
export const getStorageAccessForVideo = (video: DbVideo) =>
	Storage.getAccessForVideo(decodeStorageVideo(video));
