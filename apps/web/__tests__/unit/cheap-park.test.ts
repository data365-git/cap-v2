import { describe, expect, it } from "vitest";
import {
	CHEAP_NO_PAID_KEY_MESSAGE,
	cheapWallDisposition,
	resumableChunkIndices,
} from "@/lib/cheap-park";

// Pure decision helpers for the cheap/Batch park. These guard REAL Gemini
// billing: the disposition decides strand-forever vs fail-safe, and the resume
// grid decides whether a paid takeover re-bills already-done chunks.

describe("cheapWallDisposition", () => {
	it("parks when a paid GEMINI_API_KEY exists (recoverable: cron collects / patience continues)", () => {
		expect(cheapWallDisposition(true)).toBe("park");
	});

	it("FAIL-SAFE: no paid key ⇒ 'fail' (parking would strand PROCESSING forever)", () => {
		// The bug this guards: with only a free key, a quota wall used to park the
		// video with no Batch to collect and no paid tier to auto-continue on — the
		// poll-batch-jobs cron early-returns without a paid key, so it stranded.
		expect(cheapWallDisposition(false)).toBe("fail");
	});

	it("exposes a clear, actionable error message for the fail-safe path", () => {
		expect(CHEAP_NO_PAID_KEY_MESSAGE).toMatch(/GEMINI_API_KEY/);
		expect(CHEAP_NO_PAID_KEY_MESSAGE.length).toBeGreaterThan(0);
	});
});

describe("resumableChunkIndices", () => {
	it("returns [] when there is no checkpoint (pure-fast path is inert)", () => {
		expect(resumableChunkIndices(3, undefined)).toEqual([]);
		expect(resumableChunkIndices(3, {})).toEqual([]);
	});

	it("returns the indices already present in the completedChunks grid", () => {
		expect(
			resumableChunkIndices(4, {
				"0": "WEBVTT\n\nA",
				"2": "WEBVTT\n\nC",
			}),
		).toEqual([0, 2]);
	});

	it("ignores indices beyond the current slice count and empty entries", () => {
		expect(
			resumableChunkIndices(2, {
				"0": "WEBVTT\n\nA",
				"1": "",
				"5": "WEBVTT\n\nZ",
			}),
		).toEqual([0]);
	});
});
