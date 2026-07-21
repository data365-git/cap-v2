import { beforeEach, describe, expect, it, vi } from "vitest";

const updateWhereMock = vi.fn();
const selectWhereMock = vi.fn();
// The processing workflow is invoked INLINE (fire-and-forget) because the
// Workflow DevKit plugin is disabled (see next.config.mjs) — so we mock the
// workflow function itself, not `start()` from workflow/api.
const processVideoWorkflowMock = vi.fn();

const dbMock = vi.fn(() => ({
	update: vi.fn(() => ({
		set: vi.fn(() => ({
			where: updateWhereMock,
		})),
	})),
	select: vi.fn(() => ({
		from: vi.fn(() => ({
			where: selectWhereMock,
		})),
	})),
}));

vi.mock("@cap/database", () => ({
	db: dbMock,
}));

vi.mock("server-only", () => ({}));

vi.mock("@/workflows/process-video", () => ({
	processVideoWorkflow: processVideoWorkflowMock,
}));

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

const baseArgs = {
	videoId: "video-123" as never,
	userId: "user-123",
	rawFileKey: "user-123/video-123/raw-upload.webm",
	bucketId: null,
	processingMessage: "Starting video processing...",
	startFailureMessage: "Video processing could not start.",
};

describe("video processing starts", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not start a duplicate workflow when processing is already running", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 0 });
		selectWhereMock.mockResolvedValueOnce([
			{
				videoId: "video-123",
				phase: "processing",
				rawFileKey: "user-123/video-123/raw-upload.webm",
			},
		]);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(startVideoProcessingWorkflow(baseArgs)).resolves.toBe(
			"already-processing",
		);

		expect(processVideoWorkflowMock).not.toHaveBeenCalled();
	});

	it("starts the workflow inline after claiming the upload row", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 1 });
		processVideoWorkflowMock.mockResolvedValueOnce(undefined);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({ ...baseArgs, mode: "multipart" }),
		).resolves.toBe("started");

		expect(processVideoWorkflowMock).toHaveBeenCalledTimes(1);
	});

	it("starts the workflow when mysql returns affectedRows in the first tuple slot", async () => {
		updateWhereMock.mockResolvedValueOnce([{ affectedRows: 1 }]);
		processVideoWorkflowMock.mockResolvedValueOnce(undefined);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({ ...baseArgs, mode: "multipart" }),
		).resolves.toBe("started");

		expect(processVideoWorkflowMock).toHaveBeenCalledTimes(1);
	});

	it("force restarts a stale processing row", async () => {
		updateWhereMock.mockResolvedValueOnce({ affectedRows: 1 });
		processVideoWorkflowMock.mockResolvedValueOnce(undefined);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		await expect(
			startVideoProcessingWorkflow({
				...baseArgs,
				processingMessage: "Retrying video processing...",
				startFailureMessage: "Video processing could not restart.",
				forceRestart: true,
			}),
		).resolves.toBe("started");

		expect(processVideoWorkflowMock).toHaveBeenCalledTimes(1);
	});

	it("records a processing error when the background workflow fails", async () => {
		// transition claim + the setVideoProcessingError update from the .catch
		updateWhereMock
			.mockResolvedValueOnce({ affectedRows: 1 })
			.mockResolvedValueOnce({ affectedRows: 1 });
		processVideoWorkflowMock.mockRejectedValueOnce(
			new Error("temporary failure"),
		);

		const { startVideoProcessingWorkflow } = await import(
			"@/lib/video-processing"
		);

		// The trigger returns "started" immediately — processing is fire-and-forget,
		// so a workflow failure must NOT surface as a synchronous throw.
		await expect(startVideoProcessingWorkflow(baseArgs)).resolves.toBe(
			"started",
		);
		expect(processVideoWorkflowMock).toHaveBeenCalledTimes(1);

		// The background .catch records the failure on the video row.
		await flushMicrotasks();
		expect(updateWhereMock).toHaveBeenCalledTimes(2);
	});
});
