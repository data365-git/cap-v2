import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ffmpeg-static", () => ({
	default: "/usr/local/bin/ffmpeg",
}));

const mockUnlink = vi.fn(() => Promise.resolve(undefined));
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => path === "/usr/local/bin/ffmpeg",
		promises: {
			...actual.promises,
			unlink: () => mockUnlink(),
		},
	};
});

class MockChildProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	stdin = { write: vi.fn(), end: vi.fn() };
	// `armFfmpegTimeout` SIGKILLs the process when ffmpeg exceeds its wall-clock
	// cap, so the double must expose kill().
	kill = vi.fn(() => true);
}

type SpawnCall = {
	command: string;
	args: string[];
	options?: { stdio?: unknown };
};

let mockProcess: MockChildProcess | undefined;
let spawnArgs: SpawnCall[] = [];

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[], options?: { stdio?: unknown }) => {
		spawnArgs.push({ command, args, options });
		mockProcess = new MockChildProcess();
		return mockProcess;
	},
}));

/**
 * `extractAudioFromUrl` awaits a HEAD request (detectAudioInput) before it
 * spawns ffmpeg, so the child process does not exist synchronously. Wait for
 * the spawn instead of guessing with a fixed timer.
 */
async function waitForSpawn(): Promise<MockChildProcess> {
	for (let i = 0; i < 200; i++) {
		if (mockProcess) return mockProcess;
		await new Promise((r) => setTimeout(r, 5));
	}
	throw new Error("ffmpeg was never spawned");
}

describe("audio-extract", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		spawnArgs = [];
		mockProcess = undefined;
		// detectAudioInput() HEADs the source URL. Without a stub this is a real
		// network call and the test hangs until the ffmpeg mock is never reached.
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(null, {
						status: 200,
						headers: { "content-type": "video/mp4" },
					}),
			),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	describe("checkHasAudioTrack", () => {
		it("reports hasAudio and the parsed duration when the video has an audio stream", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			const proc = await waitForSpawn();
			proc.stderr.emit(
				"data",
				Buffer.from(
					"  Duration: 00:01:30.25, start: 0.000000, bitrate: 1000 kb/s\n  Stream #0:0: Video: h264\n  Stream #0:1: Audio: aac, 44100 Hz",
				),
			);
			proc.emit("close", 1);

			const result = await resultPromise;
			expect(result.hasAudio).toBe(true);
			expect(result.durationSec).toBeCloseTo(90.25, 2);
		});

		it("reports hasAudio false when the video has no audio stream", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			const proc = await waitForSpawn();
			proc.stderr.emit(
				"data",
				Buffer.from(
					"  Duration: 00:00:10.00, start: 0.000000\n  Stream #0:0: Video: h264, 1920x1080",
				),
			);
			proc.emit("close", 1);

			const result = await resultPromise;
			expect(result.hasAudio).toBe(false);
			expect(result.durationSec).toBeCloseTo(10, 2);
		});

		it("accepts audio-only sources (no video stream)", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/audio.mp3");

			const proc = await waitForSpawn();
			proc.stderr.emit(
				"data",
				Buffer.from(
					"  Duration: 00:02:00.50, start: 0.000000\n  Stream #0:0: Audio: mp3, 44100 Hz",
				),
			);
			proc.emit("close", 1);

			const result = await resultPromise;
			expect(result.hasAudio).toBe(true);
			expect(result.durationSec).toBeCloseTo(120.5, 2);
		});

		it("returns a null duration when ffmpeg prints no Duration line", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			const proc = await waitForSpawn();
			proc.stderr.emit(
				"data",
				Buffer.from("  Stream #0:1: Audio: aac, 44100 Hz"),
			);
			proc.emit("close", 1);

			const result = await resultPromise;
			expect(result.hasAudio).toBe(true);
			expect(result.durationSec).toBeNull();
		});

		it("rejects when ffmpeg errors", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			const proc = await waitForSpawn();
			proc.emit("error", new Error("spawn failed"));

			await expect(resultPromise).rejects.toThrow(
				"ffmpeg process error: spawn failed",
			);
		});

		it("uses correct ffmpeg arguments and rejects when no streams are detected", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			const proc = await waitForSpawn();
			proc.stderr.emit("data", Buffer.from(""));
			proc.emit("close", 1);

			await expect(resultPromise).rejects.toThrow(
				"ffmpeg could not read media file: no streams detected",
			);

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-i");
			expect(args).toContain("-hide_banner");
			expect(args).toContain("https://example.com/video.mp4");
			// stdout is never drained for the probe — piping it can block ffmpeg.
			expect(spawnArgs[0]?.options?.stdio).toEqual([
				"ignore",
				"ignore",
				"pipe",
			]);
		});
	});

	describe("extractAudioFromUrl", () => {
		it("uses correct ffmpeg arguments", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			(await waitForSpawn()).emit("close", 0);
			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-i");
			expect(args).toContain("https://example.com/video.mp4");
			expect(args).toContain("-vn");
			expect(args).toContain("-acodec");
			expect(args).toContain("libmp3lame");
			expect(args).toContain("-b:a");
			expect(args).toContain("128k");
			expect(spawnArgs[0]?.options?.stdio).toEqual([
				"ignore",
				"ignore",
				"pipe",
			]);
		});

		it("returns audio/mpeg mime type", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			(await waitForSpawn()).emit("close", 0);

			const result = await resultPromise;
			expect(result.mimeType).toBe("audio/mpeg");
		});

		it("generates .mp3 file in temp directory", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			(await waitForSpawn()).emit("close", 0);

			const result = await resultPromise;
			expect(result.filePath).toContain("audio-");
			expect(result.filePath).toContain(".mp3");
		});

		it("provides cleanup function", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			(await waitForSpawn()).emit("close", 0);

			const result = await resultPromise;
			expect(typeof result.cleanup).toBe("function");
			await result.cleanup();
			expect(mockUnlink).toHaveBeenCalled();
		});

		it("reports progress percentages from ffmpeg's time= markers", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const onProgress = vi.fn();
			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
				{ totalDurationSec: 200, onProgress },
			);

			const proc = await waitForSpawn();
			proc.stderr.emit("data", Buffer.from("time=00:00:50.00 bitrate=..."));
			proc.emit("close", 0);
			await resultPromise;

			expect(onProgress).toHaveBeenCalledWith(25);
		});

		it("rejects on ffmpeg error", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			const proc = await waitForSpawn();
			proc.stderr.emit("data", Buffer.from("Conversion failed"));
			proc.emit("close", 1);

			await expect(resultPromise).rejects.toThrow("Audio extraction failed");
		});
	});

	describe("extractAudioToBuffer", () => {
		it("uses pipe output for streaming", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			const proc = await waitForSpawn();
			proc.stdout.emit("data", Buffer.from("audio-data"));
			proc.emit("close", 0);

			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-pipe:1");
			// stdout carries the encoded output here, so it must be piped.
			expect(spawnArgs[0]?.options?.stdio).toEqual(["pipe", "pipe", "pipe"]);
		});

		it("returns Buffer instance", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			const proc = await waitForSpawn();
			proc.stdout.emit("data", Buffer.from("test-audio"));
			proc.emit("close", 0);

			const result = await resultPromise;
			expect(Buffer.isBuffer(result)).toBe(true);
		});

		it("concatenates multiple chunks", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			const proc = await waitForSpawn();
			proc.stdout.emit("data", Buffer.from("chunk1"));
			proc.stdout.emit("data", Buffer.from("chunk2"));
			proc.emit("close", 0);

			const result = await resultPromise;
			expect(result.toString()).toBe("chunk1chunk2");
		});
	});
});
