import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { Storage } from "@cap/web-backend";
import { and, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Effect } from "effect";
import { NextResponse } from "next/server";
import { sendOpsAlert } from "@/lib/ops-alert";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

export const dynamic = "force-dynamic";

const CHECK_OLDER_THAN_MS = 2 * 60 * 60 * 1000;
const STALE_UPLOAD_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const MAX_VIDEOS_PER_RUN = 200;

const NON_TERMINAL_UPLOAD_PHASES = [
	"uploading",
	"processing",
	"generating_thumbnail",
] as const;

type ReconcileCandidate = typeof videos.$inferSelect;

async function objectExists(video: ReconcileCandidate, key: string) {
	const [bucket] = await Storage.getAccessForVideo(
		decodeStorageVideo(video),
	).pipe(runPromise);

	return await bucket.headObject(key).pipe(
		Effect.as(true),
		Effect.catchAll(() => Effect.succeed(false)),
		runPromise,
	);
}

async function resolveVideoKey(video: ReconcileCandidate): Promise<string> {
	const [uploadRow] = await db()
		.select({ rawFileKey: videoUploads.rawFileKey })
		.from(videoUploads)
		.where(eq(videoUploads.videoId, video.id))
		.limit(1);

	// Same candidate order as video-proxy/playlist resolution: prefer the
	// recorded raw upload key, then the produced result fallback.
	if (uploadRow?.rawFileKey) return uploadRow.rawFileKey;
	return `${video.ownerId}/${video.id}/result.mp4`;
}

export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const olderThan = new Date(Date.now() - CHECK_OLDER_THAN_MS);

	const candidates = await db()
		.select()
		.from(videos)
		.where(
			and(
				lt(videos.createdAt, olderThan),
				sql`JSON_EXTRACT(${videos.metadata}, '$.storageMissing') IS NULL`,
			),
		)
		.orderBy(desc(videos.createdAt))
		.limit(MAX_VIDEOS_PER_RUN);

	let checked = 0;
	let missing = 0;
	const missingVideoIds: string[] = [];

	for (const video of candidates) {
		checked++;
		try {
			const key = await resolveVideoKey(video);
			const exists = await objectExists(video, key);
			if (!exists) {
				missing++;
				missingVideoIds.push(video.id);
				const metadata = (video.metadata as VideoMetadata) ?? {};
				await db()
					.update(videos)
					.set({ metadata: { ...metadata, storageMissing: true } })
					.where(eq(videos.id, video.id));
			}
		} catch (error) {
			console.error(
				`[reconcile-storage] Failed to check video ${video.id}:`,
				error,
			);
		}
	}

	const staleUploadBefore = new Date(Date.now() - STALE_UPLOAD_THRESHOLD_MS);
	const staleUploadCandidates = await db()
		.select({ videoId: videoUploads.videoId })
		.from(videoUploads)
		.where(
			and(
				inArray(videoUploads.phase, [...NON_TERMINAL_UPLOAD_PHASES]),
				lt(videoUploads.updatedAt, staleUploadBefore),
			),
		);

	const staleUploads = staleUploadCandidates.length;
	if (staleUploads > 0) {
		await db()
			.update(videoUploads)
			.set({ phase: "error" })
			.where(
				inArray(
					videoUploads.videoId,
					staleUploadCandidates.map((row) => row.videoId),
				),
			);
	}

	if (missing > 0) {
		await sendOpsAlert(
			`Storage reconcile: ${missing} video(s) missing S3 object: ${missingVideoIds.join(", ")}`,
		);
	}

	return NextResponse.json({ checked, missing, staleUploads });
}
