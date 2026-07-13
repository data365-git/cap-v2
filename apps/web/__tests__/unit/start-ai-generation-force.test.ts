import { beforeEach, describe, expect, it, vi } from "vitest";

const mockTrigger = vi.fn((..._args: unknown[]) => Promise.resolve());
const mockUpdate = vi.fn(() => ({
	set: () => ({ where: () => Promise.resolve() }),
}));

let videoRow: {
	id: string;
	ownerId: string;
	transcriptionStatus: string;
	metadata: Record<string, unknown>;
};

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => Promise.resolve([{ video: videoRow }]),
			}),
		}),
		update: mockUpdate,
	}),
}));

vi.mock("@cap/database/schema", () => ({ videos: { id: "id" } }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ GEMINI_API_KEY: "test-key" }),
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("@/workflows/generate-ai", () => ({
	generateAiWorkflow: (...args: unknown[]) => mockTrigger(...args),
}));
vi.mock("server-only", () => ({}));

import { startAiGeneration } from "@/lib/generate-ai";

const VIDEO_ID = "vid_1" as never;
const USER_ID = "user_1";

/**
 * `?force=1` on retry-ai was a no-op: the route validated the flag but called
 * startAiGeneration without it, so a video with aiGenerationStatus=COMPLETE
 * short-circuited and the summary silently stayed stale. After a
 * re-transcription that meant the UI showed analysis of a transcript that no
 * longer existed.
 */
describe("startAiGeneration force", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		videoRow = {
			id: "vid_1",
			ownerId: USER_ID,
			transcriptionStatus: "COMPLETE",
			metadata: {
				aiGenerationStatus: "COMPLETE",
				summary: "an old summary",
				chapters: [{ title: "old" }],
			},
		};
	});

	it("skips regeneration when AI metadata already exists and force is not set", async () => {
		const result = await startAiGeneration(VIDEO_ID, USER_ID);

		expect(result).toEqual({
			success: true,
			message: "AI metadata already generated",
		});
		expect(mockTrigger).not.toHaveBeenCalled();
	});

	it("regenerates over existing AI metadata when force is set", async () => {
		const result = await startAiGeneration(VIDEO_ID, USER_ID, true);

		expect(result.success).toBe(true);
		expect(result.message).not.toBe("AI metadata already generated");
		expect(mockTrigger).toHaveBeenCalledTimes(1);
	});

	it("never interrupts an in-flight run, even with force", async () => {
		for (const status of ["PROCESSING", "QUEUED"]) {
			mockTrigger.mockClear();
			videoRow.metadata = { aiGenerationStatus: status };

			const result = await startAiGeneration(VIDEO_ID, USER_ID, true);

			expect(result).toEqual({
				success: true,
				message: "AI generation already in progress",
			});
			expect(mockTrigger).not.toHaveBeenCalled();
		}
	});

	it("still refuses to run when the transcript is not complete", async () => {
		videoRow.transcriptionStatus = "PROCESSING";

		const result = await startAiGeneration(VIDEO_ID, USER_ID, true);

		expect(result).toEqual({
			success: false,
			message: "Transcription not complete",
		});
		expect(mockTrigger).not.toHaveBeenCalled();
	});
});
