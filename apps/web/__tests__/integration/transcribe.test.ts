import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		GEMINI_API_KEY: "test-gemini-api-key",
		DATABASE_URL: "mysql://test@localhost/test",
	})),
}));

const schemaMocks = vi.hoisted(() => ({
	videos: { id: "id", settings: "settings" },
	organizations: { id: "id", settings: "settings" },
	videoUploads: { videoId: "videoId", phase: "phase" },
}));

// transcribeVideo no longer hands the job to `workflow/api`.start(); it invokes
// the workflow function directly (fire-and-forget) and returns immediately.
const mockWorkflow = vi.hoisted(() => vi.fn());
vi.mock("@/workflows/transcribe", () => ({
	transcribeVideoWorkflow: mockWorkflow,
}));

let mockQueryResult: unknown[] = [];
let mockUploadQueryResult: unknown[] = [];
const mockUpdateSet = vi.fn();

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => {
				if (table === schemaMocks.videoUploads) {
					return {
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue(mockUploadQueryResult),
						}),
					};
				}

				const query = {
					leftJoin: vi.fn(() => query),
					where: vi
						.fn()
						.mockImplementation(() => Promise.resolve(mockQueryResult)),
				};
				return query;
			},
		}),
		update: () => ({
			set: (values: unknown) => {
				mockUpdateSet(values);
				return {
					where: vi.fn().mockResolvedValue([]),
				};
			},
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: schemaMocks.videos,
	organizations: schemaMocks.organizations,
	videoUploads: schemaMocks.videoUploads,
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field, value) => ({ field, value })),
}));

import type { Video } from "@cap/web-domain";
import { transcribeVideo } from "@/lib/transcribe";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

describe("transcribeVideo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockQueryResult = [];
		mockUploadQueryResult = [];
		mockWorkflow.mockResolvedValue(undefined);
	});

	describe("input validation", () => {
		it("requires GEMINI_API_KEY environment variable", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValueOnce({
				GEMINI_API_KEY: undefined,
			} as ReturnType<typeof serverEnv>);

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toContain("environment variables");
		});

		it("rejects empty videoId", async () => {
			const result = await transcribeVideo("" as Video.VideoId, "user-456");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});

		it("rejects empty userId", async () => {
			const result = await transcribeVideo("video-123" as Video.VideoId, "");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});

		it("rejects when both videoId and userId are empty", async () => {
			const result = await transcribeVideo("" as Video.VideoId, "");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});
	});

	describe("video lookup", () => {
		it("returns error when video does not exist", async () => {
			mockQueryResult = [];

			const result = await transcribeVideo(
				"nonexistent-video" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Video does not exist");
		});

		it("returns error when video result is malformed", async () => {
			mockQueryResult = [{ video: null, settings: null, orgSettings: null }];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Video information is missing");
		});
	});

	describe("transcription disabled scenarios", () => {
		it("skips transcription when video settings disable it", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: { disableTranscript: true },
					},
					settings: { disableTranscript: true },
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("disabled");
			// Disabled videos are persisted as SKIPPED so they are not retried.
			expect(mockUpdateSet).toHaveBeenCalledWith({
				transcriptionStatus: "SKIPPED",
			});
			expect(mockWorkflow).not.toHaveBeenCalled();
		});

		it("skips transcription when org settings disable it", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: null,
					},
					settings: null,
					orgSettings: { disableTranscript: true },
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("disabled");
			expect(mockWorkflow).not.toHaveBeenCalled();
		});

		it("video settings take precedence over org settings", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: { disableTranscript: false },
					},
					settings: { disableTranscript: false },
					orgSettings: { disableTranscript: true },
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(mockWorkflow).toHaveBeenCalled();
		});
	});

	describe("existing transcription status", () => {
		for (const status of [
			"COMPLETE",
			"PROCESSING",
			"SKIPPED",
			"NO_AUDIO",
		] as const) {
			it(`returns early when transcription status is ${status}`, async () => {
				mockQueryResult = [
					{
						video: {
							id: "video-123",
							transcriptionStatus: status,
							settings: null,
						},
						settings: null,
						orgSettings: null,
					},
				];

				const result = await transcribeVideo(
					"video-123" as Video.VideoId,
					"user-456",
				);

				expect(result.success).toBe(true);
				expect(result.message).toBe(
					"Transcription already completed or in progress",
				);
				expect(mockWorkflow).not.toHaveBeenCalled();
			});
		}

		it("proceeds when transcription previously ERRORed", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "ERROR",
						settings: null,
					},
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(mockWorkflow).toHaveBeenCalledTimes(1);
		});
	});

	describe("workflow triggering", () => {
		beforeEach(() => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: null,
					},
					settings: null,
					orgSettings: null,
				},
			];
		});

		it("does not trigger while upload is still active", async () => {
			mockUploadQueryResult = [{ phase: "processing" }];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe("Video upload is still in progress");
			expect(mockWorkflow).not.toHaveBeenCalled();
		});

		it("triggers the workflow for a valid video", async () => {
			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe("Transcription started inline");
			expect(mockWorkflow).toHaveBeenCalledTimes(1);
		});

		it("passes correct payload to workflow", async () => {
			await transcribeVideo("video-123" as Video.VideoId, "user-456", true);

			expect(transcribeVideoWorkflow).toHaveBeenCalledWith({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: true,
			});
		});

		it("defaults aiGenerationEnabled to false", async () => {
			await transcribeVideo("video-123" as Video.VideoId, "user-456");

			expect(transcribeVideoWorkflow).toHaveBeenCalledWith({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			});
		});

		it("handles a workflow trigger failure gracefully", async () => {
			mockWorkflow.mockImplementation(() => {
				throw new Error("Workflow service unavailable");
			});

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Failed to start transcription workflow");
			// The video is reset so a retry can pick it up again.
			expect(mockUpdateSet).toHaveBeenCalledWith({ transcriptionStatus: null });
		});

		it("does not fail the caller when the fire-and-forget workflow rejects later", async () => {
			mockWorkflow.mockRejectedValue(new Error("Workflow crashed mid-run"));

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			// The workflow runs detached: the caller returns as soon as it is kicked
			// off, and a later rejection is logged rather than surfaced here.
			expect(result.success).toBe(true);
			expect(result.message).toBe("Transcription started inline");
		});
	});
});
