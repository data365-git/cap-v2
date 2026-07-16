import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for the durable-Batch collector cron (poll-batch-jobs). It
// runs UNATTENDED, spends money (paid Batch) and moves transcription data, so its
// branch behavior is the highest-risk surface: succeeded → merge into
// completedChunks + usage + re-kick; failed → drop + re-kick; pending → keep;
// no-longer-cheap → cancel + clear; patience elapsed → flip to paid; and —
// critically — a metadata write error on a succeeded batch KEEPS the job (never
// loses the result, never re-kicks on an ambiguous write).

const H = vi.hoisted(() => ({
	candidates: [] as Array<{ video: unknown }>,
	getObjectThrows: false,
	cancelBatch: vi.fn(async (_n: string, _k: string) => {}),
	deleteBatchFile: vi.fn(async (_n: string, _k: string) => {}),
	collectBatchResult: vi.fn((_n: string, _o: unknown) => undefined as unknown),
	transcribeVideo: vi.fn(async (..._a: unknown[]) => ({ success: true })),
	continueAiJobOnPaid: vi.fn(async (..._a: unknown[]) => ({ success: true })),
	patchVideoMetadata: vi.fn(
		async (_id: string, _u: (m: Record<string, unknown>) => unknown) =>
			undefined as unknown,
	),
	insertUsage: vi.fn(async () => {}),
	updateVideo: vi.fn(async (_v: unknown) => {}),
	currentMetadata: {} as Record<string, unknown>,
	geminiKey: "server-paid-key" as string | undefined,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: async () => H.candidates }) }),
		insert: () => ({
			values: () => ({ onDuplicateKeyUpdate: async () => H.insertUsage() }),
		}),
		update: () => ({
			set: (v: unknown) => ({ where: async () => H.updateVideo(v) }),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	aiUsageEvents: { id: "aiUsageEvents.id" },
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		deletedAt: "videos.deletedAt",
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({
		GEMINI_API_KEY: H.geminiKey,
		AI_CHEAP_PATIENCE_MINUTES: 240,
	}),
}));
vi.mock("@cap/utils", () => ({ priceForMicros: () => 1234 }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("drizzle-orm", () => ({
	and: (...a: unknown[]) => a,
	eq: (f: unknown, v: unknown) => ({ f, v }),
	isNull: (f: unknown) => ({ isNull: f }),
	sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v }), {
		raw: (s: string) => s,
	}),
}));
vi.mock("next/server", () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));
vi.mock("@/lib/ai-job-control", () => ({
	continueAiJobOnPaid: (...a: unknown[]) => H.continueAiJobOnPaid(...a),
}));
vi.mock("@/lib/batch-merge", () => ({
	mergeCollectedChunkIntoCompletedChunks: (
		completedChunks: Record<string, string> | undefined,
		chunkIndex: number,
		chunkVtt: string,
	) => ({ ...(completedChunks ?? {}), [String(chunkIndex)]: chunkVtt }),
	removeBatchJob: (
		jobs: Array<{ batchName: string }> | undefined,
		name: string,
	) => (jobs ?? []).filter((j) => j.batchName !== name),
}));
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	cancelBatch: (n: string, k: string) => H.cancelBatch(n, k),
	collectBatchResult: (n: string, o: unknown) => H.collectBatchResult(n, o),
	deleteBatchFile: (n: string, k: string) => H.deleteBatchFile(n, k),
}));
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: (...a: unknown[]) => H.transcribeVideo(...a),
}));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (
		id: string,
		updater: (m: Record<string, unknown>) => unknown,
	) => H.patchVideoMetadata(id, updater),
}));

const { GET } = await import("@/app/api/cron/poll-batch-jobs/route");

const SECRET = "cron-secret-xyz";
const JOB = {
	batchName: "batches/a",
	fileName: "files/a",
	chunkIndex: 0,
	startSec: 0,
	durationSec: 180,
	submittedAt: "t1",
};

function videoWith(metadata: Record<string, unknown>) {
	return {
		id: "v1",
		ownerId: "owner1",
		orgId: "org1",
		metadata,
		deletedAt: null,
	};
}

function authedRequest(secret = SECRET) {
	return new Request("http://localhost/api/cron/poll-batch-jobs", {
		headers: { authorization: `Bearer ${secret}` },
	});
}

async function bodyOf(res: { json: () => Promise<unknown> }) {
	return (await res.json()) as Record<string, number | string>;
}

beforeEach(() => {
	process.env.CRON_SECRET = SECRET;
	H.candidates = [];
	H.geminiKey = "server-paid-key";
	H.cancelBatch.mockReset().mockResolvedValue(undefined);
	H.deleteBatchFile.mockReset().mockResolvedValue(undefined);
	H.collectBatchResult.mockReset();
	H.transcribeVideo.mockReset().mockResolvedValue({ success: true });
	H.continueAiJobOnPaid.mockReset().mockResolvedValue({ success: true });
	H.insertUsage.mockReset().mockResolvedValue(undefined);
	H.updateVideo.mockReset().mockResolvedValue(undefined);
	H.patchVideoMetadata
		.mockReset()
		.mockImplementation(
			async (_id: string, updater: (m: Record<string, unknown>) => unknown) =>
				updater(H.currentMetadata),
		);
});

describe("poll-batch-jobs GET — auth + config guards", () => {
	it("200 no-op when CRON_SECRET is not configured (fail-safe)", async () => {
		delete process.env.CRON_SECRET;
		const res = await GET(authedRequest());
		expect(res.status).toBe(200);
		expect(await bodyOf(res)).toMatchObject({ skipped: expect.any(String) });
	});

	it("401 on a wrong bearer token", async () => {
		const res = await GET(authedRequest("wrong-secret-of-len"));
		expect(res.status).toBe(401);
	});

	it("401 when the authorization header is missing", async () => {
		const res = await GET(
			new Request("http://localhost/api/cron/poll-batch-jobs"),
		);
		expect(res.status).toBe(401);
	});

	it("200 no-op when no paid GEMINI_API_KEY is set (fail-safe)", async () => {
		H.geminiKey = undefined;
		const res = await GET(authedRequest());
		expect(res.status).toBe(200);
		expect(await bodyOf(res)).toMatchObject({ skipped: expect.any(String) });
	});
});

describe("poll-batch-jobs GET — orchestration branches", () => {
	it("no-longer-cheap: cancels stray Batch, clears aiBatchJobs, never re-kicks", async () => {
		H.currentMetadata = { aiMode: "fast", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];

		const body = await bodyOf(await GET(authedRequest()));

		expect(H.cancelBatch).toHaveBeenCalledWith("batches/a", "server-paid-key");
		expect(H.deleteBatchFile).toHaveBeenCalledWith(
			"files/a",
			"server-paid-key",
		);
		const patched = H.patchVideoMetadata.mock.results[0]?.value;
		await expect(patched).resolves.toMatchObject({ aiBatchJobs: undefined });
		expect(H.transcribeVideo).not.toHaveBeenCalled();
		expect(body.cleared).toBe(1);
	});

	it("patience elapsed: flips to paid via continueAiJobOnPaid, does not collect", async () => {
		H.currentMetadata = {
			aiMode: "cheap",
			aiBatchJobs: [JOB],
			aiJobStartedAt: new Date(Date.now() - 300 * 60_000).toISOString(),
		};
		H.candidates = [{ video: videoWith(H.currentMetadata) }];

		const body = await bodyOf(await GET(authedRequest()));

		expect(H.continueAiJobOnPaid).toHaveBeenCalledWith({
			videoId: "v1",
			ownerId: "owner1",
			phase: "transcription",
		});
		expect(H.collectBatchResult).not.toHaveBeenCalled();
		expect(body.flippedToPaid).toBe(1);
	});

	it("pending: keeps the job and does not re-kick", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.collectBatchResult.mockResolvedValue({ status: "pending" });

		const body = await bodyOf(await GET(authedRequest()));

		expect(body.pending).toBe(1);
		expect(body.retried ?? 0).toBe(0);
		expect(H.transcribeVideo).not.toHaveBeenCalled();
	});

	it("succeeded: writes completedChunks, records usage, drops the job, re-kicks cheap", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.collectBatchResult.mockResolvedValue({
			status: "succeeded",
			cues: [],
			chunkVtt: "WEBVTT\n\nCHUNK",
			inputTokens: 100,
			outputTokens: 40,
			audioInTokens: 30,
		});

		const body = await bodyOf(await GET(authedRequest()));

		// First patch dropped the collected chunk onto completedChunks[0].
		const firstPatch = await H.patchVideoMetadata.mock.results[0]?.value;
		expect(firstPatch).toMatchObject({
			completedChunks: { "0": "WEBVTT\n\nCHUNK" },
		});
		expect(H.insertUsage).toHaveBeenCalledTimes(1);
		expect(H.transcribeVideo).toHaveBeenCalledWith(
			"v1",
			"owner1",
			true,
			true,
			"cheap",
		);
		expect(body.succeeded).toBe(1);
		expect(body.retried).toBe(1);
	});

	it("DATA SAFETY: a completedChunks write error KEEPS the job — no usage, no re-kick", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.collectBatchResult.mockResolvedValue({
			status: "succeeded",
			cues: [],
			chunkVtt: "WEBVTT\n\nCHUNK",
			inputTokens: 10,
			outputTokens: 5,
			audioInTokens: 3,
		});
		// The completedChunks write (first patch call) fails.
		H.patchVideoMetadata.mockRejectedValueOnce(new Error("db write boom"));

		const body = await bodyOf(await GET(authedRequest()));

		expect(H.insertUsage).not.toHaveBeenCalled();
		expect(H.transcribeVideo).not.toHaveBeenCalled();
		expect(body.succeeded).toBe(0);
		expect(body.retried ?? 0).toBe(0);
	});

	it("failed/expired: drops the job and re-kicks cheap so the chunk is redone", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.collectBatchResult.mockResolvedValue({
			status: "failed",
			reason: "terminal state",
		});

		const body = await bodyOf(await GET(authedRequest()));

		expect(H.insertUsage).not.toHaveBeenCalled();
		expect(H.transcribeVideo).toHaveBeenCalledWith(
			"v1",
			"owner1",
			true,
			true,
			"cheap",
		);
		expect(body.failed).toBe(1);
		expect(body.retried).toBe(1);
	});
});
