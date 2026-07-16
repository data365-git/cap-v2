import { beforeEach, describe, expect, it, vi } from "vitest";

// Paid-takeover continuation: the patience-window flip and the manual
// "Transcribe now (paid)" button both route through continueAiJobOnPaid, which
// MUST abandon any pending durable Batch jobs (cancel remote + delete Files API
// input) and clear aiBatchJobs before paid Standard repeats the chunk — otherwise
// a cancelled-but-alive Batch keeps spending.

const H = vi.hoisted(() => ({
	selectResult: [] as unknown[],
	updateSet: vi.fn(),
	patchVideoMetadata: vi.fn(
		async (
			_id: string,
			_u: (m: Record<string, unknown>) => Record<string, unknown>,
		) => undefined as unknown,
	),
	cancelBatch: vi.fn(async (_n: string, _k: string) => {}),
	deleteBatchFile: vi.fn(async (_n: string, _k: string) => {}),
	transcribeVideo: vi.fn(async (..._a: unknown[]) => ({
		success: true,
		message: "t",
	})),
	startAiGeneration: vi.fn(async (..._a: unknown[]) => ({
		success: true,
		message: "g",
	})),
	geminiKey: "server-paid-key" as string | undefined,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: () => ({ limit: async () => H.selectResult }) }),
		}),
		update: () => ({
			set: (v: unknown) => ({ where: async () => H.updateSet(v) }),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "videos.id" } }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ GEMINI_API_KEY: H.geminiKey }),
}));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("drizzle-orm", () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	cancelBatch: (n: string, k: string) => H.cancelBatch(n, k),
	deleteBatchFile: (n: string, k: string) => H.deleteBatchFile(n, k),
}));
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: (...a: unknown[]) => H.startAiGeneration(...a),
}));
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: (...a: unknown[]) => H.transcribeVideo(...a),
}));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (
		id: string,
		updater: (m: Record<string, unknown>) => Record<string, unknown>,
	) => H.patchVideoMetadata(id, updater),
}));

const { abandonPendingBatchJobs, continueAiJobOnPaid } = await import(
	"@/lib/ai-job-control"
);

const JOB_A = {
	batchName: "batches/a",
	fileName: "files/a",
	chunkIndex: 0,
	startSec: 0,
	durationSec: 180,
	submittedAt: "t1",
};

beforeEach(() => {
	H.selectResult = [];
	H.updateSet.mockReset();
	H.patchVideoMetadata.mockReset().mockResolvedValue(undefined);
	H.cancelBatch.mockReset().mockResolvedValue(undefined);
	H.deleteBatchFile.mockReset().mockResolvedValue(undefined);
	H.transcribeVideo
		.mockReset()
		.mockResolvedValue({ success: true, message: "t" });
	H.startAiGeneration
		.mockReset()
		.mockResolvedValue({ success: true, message: "g" });
	H.geminiKey = "server-paid-key";
});

describe("abandonPendingBatchJobs", () => {
	it("no-op with no jobs, or no paid key", async () => {
		await abandonPendingBatchJobs({});
		await abandonPendingBatchJobs({ aiBatchJobs: [] });
		H.geminiKey = undefined;
		await abandonPendingBatchJobs({ aiBatchJobs: [JOB_A] });
		expect(H.cancelBatch).not.toHaveBeenCalled();
		expect(H.deleteBatchFile).not.toHaveBeenCalled();
	});

	it("cancels the remote Batch AND deletes its Files API input for every job", async () => {
		await abandonPendingBatchJobs({ aiBatchJobs: [JOB_A] });
		expect(H.cancelBatch).toHaveBeenCalledWith("batches/a", "server-paid-key");
		expect(H.deleteBatchFile).toHaveBeenCalledWith(
			"files/a",
			"server-paid-key",
		);
	});

	it("never throws even if a cleanup call rejects", async () => {
		H.cancelBatch.mockRejectedValueOnce(new Error("network"));
		await expect(
			abandonPendingBatchJobs({ aiBatchJobs: [JOB_A] }),
		).resolves.toBeUndefined();
	});
});

describe("continueAiJobOnPaid", () => {
	it("fails cleanly and touches nothing when the video is missing", async () => {
		H.selectResult = [];
		const out = await continueAiJobOnPaid({
			videoId: "v1" as never,
			ownerId: "u1",
			phase: "transcription",
		});
		expect(out.success).toBe(false);
		expect(H.updateSet).not.toHaveBeenCalled();
		expect(H.patchVideoMetadata).not.toHaveBeenCalled();
		expect(H.transcribeVideo).not.toHaveBeenCalled();
	});

	it("transcription: abandons Batch, clears jobs, flips to fast, re-runs on paid", async () => {
		H.selectResult = [
			{
				metadata: {
					aiMode: "cheap",
					aiQuotaWaiting: true,
					aiBatchJobs: [JOB_A],
				},
			},
		];

		const out = await continueAiJobOnPaid({
			videoId: "v1" as never,
			ownerId: "u1",
			phase: "transcription",
		});

		expect(H.cancelBatch).toHaveBeenCalledWith("batches/a", "server-paid-key");
		expect(H.deleteBatchFile).toHaveBeenCalledWith(
			"files/a",
			"server-paid-key",
		);

		// transcriptionStatus is now its own plain column write (no metadata key).
		const setArg = H.updateSet.mock.calls[0]?.[0] as {
			transcriptionStatus: unknown;
			metadata?: unknown;
		};
		expect(setArg.transcriptionStatus).toBeNull();
		expect(setArg.metadata).toBeUndefined();

		// The metadata flip goes through the atomic row-locked helper. Apply the
		// captured updater to a freshly-locked row that ALSO carries a chunk the
		// poll cron just collected — it must survive (no lost update).
		const updater = H.patchVideoMetadata.mock.calls[0]?.[1] as (
			m: Record<string, unknown>,
		) => Record<string, unknown>;
		const next = updater({
			aiMode: "cheap",
			aiQuotaWaiting: true,
			aiBatchJobs: [JOB_A],
			completedChunks: { "0": "WEBVTT" },
		});
		expect(next.aiMode).toBe("fast");
		expect(next.aiBatchJobs).toBeUndefined();
		expect(next.aiQuotaWaiting).toBeUndefined();
		expect(next.completedChunks).toEqual({ "0": "WEBVTT" });

		// paid Standard resumes from the checkpoint (fast, not cheap).
		expect(H.transcribeVideo).toHaveBeenCalledWith(
			"v1",
			"u1",
			true,
			false,
			"fast",
		);
		expect(H.startAiGeneration).not.toHaveBeenCalled();
		expect(out.success).toBe(true);
	});

	it("generation: clears jobs + generation status and restarts generation on fast (paid)", async () => {
		H.selectResult = [{ metadata: { aiMode: "cheap", aiBatchJobs: [JOB_A] } }];

		await continueAiJobOnPaid({
			videoId: "v1" as never,
			ownerId: "u1",
			phase: "generation",
		});

		// Generation path has no column write — only the atomic metadata patch.
		expect(H.updateSet).not.toHaveBeenCalled();
		const updater = H.patchVideoMetadata.mock.calls[0]?.[1] as (
			m: Record<string, unknown>,
		) => Record<string, unknown>;
		const next = updater({
			aiMode: "cheap",
			aiBatchJobs: [JOB_A],
			aiGenerationStatus: "PROCESSING",
			aiSummary: { keep: true },
		});
		expect(next.aiBatchJobs).toBeUndefined();
		expect(next.aiGenerationStatus).toBeUndefined();
		expect(next.aiMode).toBe("fast");
		// Sibling AI content survives the flip.
		expect(next.aiSummary).toEqual({ keep: true });
		expect(H.startAiGeneration).toHaveBeenCalledWith("v1", "u1", true);
		expect(H.transcribeVideo).not.toHaveBeenCalled();
	});
});
