import { describe, expect, it } from "vitest";
import {
	type BatchJob,
	mergeCollectedChunkIntoCompletedChunks,
	removeBatchJob,
} from "@/lib/batch-merge";

const jobA: BatchJob = {
	batchName: "batches/a",
	fileName: "files/a",
	chunkIndex: 0,
	startSec: 0,
	durationSec: 180,
	submittedAt: "t1",
};
const jobB: BatchJob = {
	batchName: "batches/b",
	fileName: "files/b",
	chunkIndex: 1,
	startSec: 180,
	durationSec: 180,
	submittedAt: "t2",
};

describe("removeBatchJob", () => {
	it("drops the matching job and keeps the rest", () => {
		expect(removeBatchJob([jobA, jobB], "batches/a")).toEqual([jobB]);
	});

	it("is a no-op for a missing name and tolerates undefined", () => {
		expect(removeBatchJob([jobA], "batches/x")).toEqual([jobA]);
		expect(removeBatchJob(undefined, "batches/a")).toEqual([]);
	});
});

describe("mergeCollectedChunkIntoCompletedChunks", () => {
	it("adds the collected chunk at its index without mutating the input", () => {
		const existing = { "0": "WEBVTT\n\nA" };
		const merged = mergeCollectedChunkIntoCompletedChunks(
			existing,
			1,
			"WEBVTT\n\nB",
		);
		expect(merged).toEqual({ "0": "WEBVTT\n\nA", "1": "WEBVTT\n\nB" });
		// input untouched (read-modify-write safety)
		expect(existing).toEqual({ "0": "WEBVTT\n\nA" });
	});

	it("is idempotent — re-collecting the same chunk overwrites the same slot", () => {
		const once = mergeCollectedChunkIntoCompletedChunks(
			undefined,
			2,
			"WEBVTT\n\nX",
		);
		const twice = mergeCollectedChunkIntoCompletedChunks(
			once,
			2,
			"WEBVTT\n\nX",
		);
		expect(twice).toEqual({ "2": "WEBVTT\n\nX" });
		expect(Object.keys(twice)).toHaveLength(1);
	});
});
