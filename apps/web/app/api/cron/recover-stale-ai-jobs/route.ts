import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { startAiGeneration } from "@/lib/generate-ai";
import { sendOpsAlert } from "@/lib/ops-alert";
import { transcribeVideo } from "@/lib/transcribe";

export const dynamic = "force-dynamic";

// A workflow that hasn't touched its row in this long is considered stranded
// (the fire-and-forget workflow crashed / the instance was redeployed).
const STALE_MINUTES = 60;

// Anti-cost-loop guards. Only a bounded number of videos are recovered per run,
// and any single video is only ever re-triggered a bounded number of times
// (tracked in metadata.recoveryAttempts) so a permanently-broken video can never
// be re-triggered forever.
const MAX_PER_RUN = 20;
const MAX_RECOVERY_ATTEMPTS = 3;

async function handler(request: Request) {
	const cronSecret = process.env.CRON_SECRET;

	// Fail safe: when the secret isn't configured, no-op with 200 so the cron
	// workflow doesn't error on every run before the secret has been provisioned.
	if (!cronSecret) {
		return NextResponse.json(
			{ recovered: 0, ids: [], skipped: "CRON_SECRET not configured" },
			{ status: 200 },
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

	const staleThreshold = new Date(Date.now() - STALE_MINUTES * 60 * 1000);

	// Stuck = not updated in > STALE_MINUTES AND under the per-video attempt cap
	// AND either transcription is still PROCESSING or AI generation is still
	// QUEUED/PROCESSING (read out of the metadata JSON column).
	const stuck = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			transcriptionStatus: videos.transcriptionStatus,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				lt(videos.updatedAt, staleThreshold),
				sql`COALESCE(JSON_EXTRACT(${videos.metadata}, '$.recoveryAttempts'), 0) < ${MAX_RECOVERY_ATTEMPTS}`,
				or(
					eq(videos.transcriptionStatus, "PROCESSING"),
					inArray(
						sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus'))`,
						["QUEUED", "PROCESSING"],
					),
				),
			),
		)
		.limit(MAX_PER_RUN);

	const recovered: string[] = [];

	for (const video of stuck) {
		const metadata = (video.metadata as VideoMetadata) || {};
		const attempts = (metadata.recoveryAttempts ?? 0) + 1;

		try {
			if (video.transcriptionStatus === "PROCESSING") {
				// Stranded transcription: reset the status so transcribeVideo starts
				// cleanly, record the recovery attempt, then re-fire the workflow
				// (same fire-and-forget invocation as retry-transcription).
				await db()
					.update(videos)
					.set({
						transcriptionStatus: null,
						metadata: { ...metadata, recoveryAttempts: attempts },
					})
					.where(eq(videos.id, video.id));

				transcribeVideo(video.id, video.ownerId, false).catch((error) => {
					console.error(
						`[recover-stale-ai-jobs] transcription failed for ${video.id}:`,
						error,
					);
				});
			} else {
				// Stranded AI generation: startAiGeneration bails out early when the
				// status is still QUEUED/PROCESSING, so clear it (and record the
				// attempt) first, then re-fire. force=true because a stranded job may
				// carry stale summary/chapters — without it the workflow's own
				// "already generated" guard throws and re-strands the job.
				await db()
					.update(videos)
					.set({
						metadata: {
							...metadata,
							aiGenerationStatus: "ERROR",
							recoveryAttempts: attempts,
						},
					})
					.where(eq(videos.id, video.id));

				await startAiGeneration(video.id, video.ownerId, true);
			}

			recovered.push(video.id);
			console.info(
				`[recover-stale-ai-jobs] recovered video=${video.id} kind=${
					video.transcriptionStatus === "PROCESSING" ? "transcription" : "ai"
				} attempt=${attempts}`,
			);
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] failed to recover ${video.id}:`,
				error,
			);
		}
	}

	// Recovering stranded jobs means something crashed/redeployed mid-run — worth
	// an ops ping so the owner notices a pattern. No-ops silently if Telegram env
	// isn't set; never throws.
	if (recovered.length > 0) {
		await sendOpsAlert(
			`♻️ recover-stale-ai-jobs re-fired ${recovered.length} stranded job(s): ${recovered.join(", ")}`,
		);
	}

	return NextResponse.json({ recovered: recovered.length, ids: recovered });
}

export async function GET(request: Request) {
	return handler(request);
}

export async function POST(request: Request) {
	return handler(request);
}
