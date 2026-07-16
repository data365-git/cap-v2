import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { aiUsageEvents, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { priceForMicros } from "@cap/utils";
import type { Organisation, User, Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { continueAiJobOnPaid } from "@/lib/ai-job-control";
import {
	mergeCollectedChunkIntoCompletedChunks,
	removeBatchJob,
} from "@/lib/batch-merge";
import {
	type CollectBatchResult,
	cancelBatch,
	collectBatchResult,
	deleteBatchFile,
} from "@/lib/gemini-batch-transcribe";
import { transcribeVideo } from "@/lib/transcribe";
import { patchVideoMetadata } from "@/lib/video-metadata";

export const dynamic = "force-dynamic";

// The Batch submits with the synchronous primary model; usage is billed at that
// model's audio rate (no batch-discount row in the pricing table — conservative).
const BATCH_USAGE_MODEL = "gemini-3-flash-preview";

/** Deterministic ai_usage_events id per Batch so re-recording is a no-op. */
function batchUsageId(batchName: string): string {
	return createHash("sha256").update(batchName).digest("hex").slice(0, 15);
}

async function handler(request: Request) {
	const cronSecret = process.env.CRON_SECRET;

	// Fail safe: when the secret isn't configured, no-op with 200 so the cron
	// workflow doesn't error on every run before the secret has been provisioned.
	if (!cronSecret) {
		return NextResponse.json(
			{ skipped: "CRON_SECRET not configured" },
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

	const paidKey = serverEnv().GEMINI_API_KEY;
	if (!paidKey) {
		// No paid key → nothing to collect with. Fail safe (no-op 200).
		return NextResponse.json(
			{ skipped: "No GEMINI_API_KEY configured" },
			{ status: 200 },
		);
	}

	const patienceMs = serverEnv().AI_CHEAP_PATIENCE_MINUTES * 60_000;

	const candidates = await db()
		.select({ video: videos })
		.from(videos)
		.where(
			sql`JSON_LENGTH(JSON_EXTRACT(${videos.metadata}, '$.aiBatchJobs')) > 0`,
		);

	let pending = 0;
	let succeeded = 0;
	let failed = 0;
	let retried = 0;
	let cleared = 0;
	let flippedToPaid = 0;
	let errors = 0;

	for (const { video } of candidates) {
		try {
			const metadata = (video.metadata as VideoMetadata) ?? {};
			const jobs = metadata.aiBatchJobs ?? [];
			if (jobs.length === 0) continue;

			// Patience window elapsed → auto-continue on the paid synchronous tier.
			// continueAiJobOnPaid abandons the pending Batch(es) and re-runs from the
			// checkpoint, so no chunk is lost.
			const startedAt = metadata.aiJobStartedAt
				? Date.parse(metadata.aiJobStartedAt)
				: Number.NaN;
			if (
				metadata.aiMode === "cheap" &&
				Number.isFinite(startedAt) &&
				Date.now() - startedAt >= patienceMs
			) {
				await continueAiJobOnPaid({
					videoId: video.id as Video.VideoId,
					ownerId: video.ownerId,
					phase: "transcription",
				});
				flippedToPaid++;
				continue;
			}

			// The video is no longer cheap (paid takeover elsewhere): cancel any stray
			// Batch and clear the jobs so paid Standard owns the checkpoint.
			if (metadata.aiMode !== "cheap") {
				await Promise.allSettled(
					jobs.flatMap((j) => [
						cancelBatch(j.batchName, paidKey),
						deleteBatchFile(j.fileName, paidKey),
					]),
				);
				await patchVideoMetadata(video.id, (m) => ({
					...m,
					aiBatchJobs: undefined,
				}));
				cleared++;
				continue;
			}

			let remaining = jobs;
			let terminal = false;

			for (const job of jobs) {
				const result: CollectBatchResult = await collectBatchResult(
					job.batchName,
					{
						apiKey: paidKey,
						fileName: job.fileName,
						audioDurationSec: job.durationSec,
						startOffsetSec: job.startSec,
					},
				);

				if (result.status === "pending") {
					pending++;
					continue;
				}

				if (result.status === "failed") {
					console.warn(
						`[poll-batch-jobs] Batch ${job.batchName} failed for video=${video.id}: ${result.reason}`,
					);
					remaining = removeBatchJob(remaining, job.batchName);
					terminal = true;
					failed++;
					continue;
				}

				// Succeeded: drop the collected (already absolute-timed) chunk onto the
				// completedChunks grid at its index. A DB write failure KEEPS the job so
				// we never lose the result or re-kick on an ambiguous write.
				try {
					await patchVideoMetadata(video.id, (m) => ({
						...m,
						completedChunks: mergeCollectedChunkIntoCompletedChunks(
							m.completedChunks,
							job.chunkIndex,
							result.chunkVtt,
						),
					}));
				} catch (writeError) {
					console.error(
						`[poll-batch-jobs] completedChunks write failed for video=${video.id}; keeping job for next tick:`,
						writeError,
					);
					continue;
				}

				// Record Batch usage best-effort (already paid for — an accounting
				// failure must never discard the merged result or gate on budget).
				try {
					const audioInTokens = result.audioInTokens;
					const textInTokens = Math.max(0, result.inputTokens - audioInTokens);
					const costUsdMicros = priceForMicros(
						BATCH_USAGE_MODEL,
						result.inputTokens,
						result.outputTokens,
						{ audio: audioInTokens > 0 || textInTokens === 0 },
					);
					await db()
						.insert(aiUsageEvents)
						.values({
							id: batchUsageId(job.batchName),
							orgId: video.orgId as Organisation.OrganisationId,
							userId: video.ownerId as unknown as User.UserId,
							videoId: video.id as Video.VideoId,
							operation: "transcription",
							model: BATCH_USAGE_MODEL,
							inputTokens: result.inputTokens,
							outputTokens: result.outputTokens,
							costUsdMicros,
							billingMonth: new Date().toISOString().slice(0, 7),
							status: "success",
							attempt: null,
						})
						.onDuplicateKeyUpdate({ set: { id: sql`${aiUsageEvents.id}` } });
				} catch (accountingError) {
					console.error(
						`[poll-batch-jobs] Batch usage accounting failed for video=${video.id} (result kept):`,
						accountingError,
					);
				}

				remaining = removeBatchJob(remaining, job.batchName);
				terminal = true;
				succeeded++;
			}

			// Persist remaining jobs (read-modify-write; keep unrelated metadata).
			await patchVideoMetadata(video.id, (m) => ({
				...m,
				aiBatchJobs: remaining.length > 0 ? remaining : undefined,
			}));

			// All jobs resolved → re-kick cheap so the workflow resumes from the fuller
			// checkpoint (the collected chunk is now covered → skipped).
			if (terminal && remaining.length === 0) {
				await db()
					.update(videos)
					.set({ transcriptionStatus: null })
					.where(eq(videos.id, video.id as Video.VideoId));
				await patchVideoMetadata(video.id, (m) => ({
					...m,
					aiQuotaWaiting: false,
					aiProcessingStartedAt: undefined,
				}));
				await transcribeVideo(
					video.id as Video.VideoId,
					video.ownerId,
					true,
					true,
					"cheap",
				);
				retried++;
			}
		} catch (error) {
			errors++;
			console.error(
				`[poll-batch-jobs] Failed to process batch jobs for video ${video.id}:`,
				error,
			);
		}
	}

	return NextResponse.json({
		success: true,
		pending,
		succeeded,
		failed,
		retried,
		cleared,
		flippedToPaid,
		errors,
	});
}

export async function GET(request: Request) {
	return handler(request);
}

export async function POST(request: Request) {
	return handler(request);
}
