import { describe, expect, it } from "vitest";
import { buildTranscriptionSourceKeys } from "@/lib/transcription-chunking";

const OWNER = "owner1";
const VIDEO = "vid1";
const base = `${OWNER}/${VIDEO}`;

describe("buildTranscriptionSourceKeys", () => {
	it("webAudio: probes raw-upload.<ext> even when rawFileKey is missing (row deleted after processing)", () => {
		// This is the regression: process-video deletes the videoUploads row, so
		// rawFileKey is null and there is no result.mp4 for audio. The raw-upload.*
		// fallbacks MUST be present or transcription throws "Video file not accessible".
		const keys = buildTranscriptionSourceKeys({
			isAudioSource: true,
			ownerId: OWNER,
			videoId: VIDEO,
			rawFileKey: null,
		});
		expect(keys).toContain(`${base}/raw-upload.mp3`);
		expect(keys).toContain(`${base}/raw-upload.m4a`);
		expect(keys).toContain(`${base}/raw-upload.wav`);
		// raw-upload fallbacks come before the (nonexistent) result.mp4 last resort
		expect(keys.indexOf(`${base}/raw-upload.mp3`)).toBeLessThan(
			keys.indexOf(`${base}/result.mp4`),
		);
	});

	it("webAudio: tries the DB rawFileKey first when present", () => {
		const rawKey = `${base}/raw-upload.mp3`;
		const keys = buildTranscriptionSourceKeys({
			isAudioSource: true,
			ownerId: OWNER,
			videoId: VIDEO,
			rawFileKey: rawKey,
		});
		expect(keys[0]).toBe(rawKey);
		// de-duplicated: the same key isn't repeated by the fallback list
		expect(keys.filter((k) => k === rawKey)).toHaveLength(1);
	});

	it("video: tries result.mp4 first, then rawFileKey, then raw-upload fallbacks", () => {
		const rawKey = `${base}/raw-upload.mp4`;
		const keys = buildTranscriptionSourceKeys({
			isAudioSource: false,
			ownerId: OWNER,
			videoId: VIDEO,
			rawFileKey: rawKey,
		});
		expect(keys[0]).toBe(`${base}/result.mp4`);
		expect(keys[1]).toBe(rawKey);
	});

	it("drops null/undefined and de-duplicates", () => {
		const keys = buildTranscriptionSourceKeys({
			isAudioSource: true,
			ownerId: OWNER,
			videoId: VIDEO,
			rawFileKey: undefined,
		});
		expect(keys.every(Boolean)).toBe(true);
		expect(new Set(keys).size).toBe(keys.length);
	});
});
