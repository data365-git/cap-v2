import { describe, expect, it } from "vitest";
import { shouldChunkForTranscription } from "@/lib/transcription-chunking";

/**
 * Regression guard for the 36-minute truncation bug.
 *
 * Raising the single-shot ceiling to 90 min let a 36-min meeting go to Gemini
 * in one call. The model returned the full text but compressed the cue
 * timestamps into ~27 min, so clamping to the real duration silently threw away
 * the last ~10 minutes of the meeting. Anything past ~12 min must be chunked.
 */
describe("shouldChunkForTranscription", () => {
	const MIN = 60;

	it("single-shots a short video", () => {
		expect(
			shouldChunkForTranscription({
				isAudioSource: false,
				knownDurationSec: 5 * MIN,
			}),
		).toBe(false);
	});

	it("chunks a 36-minute video (the regression)", () => {
		expect(
			shouldChunkForTranscription({
				isAudioSource: false,
				knownDurationSec: 36 * MIN + 32,
			}),
		).toBe(true);
	});

	it("chunks any video longer than 12 minutes", () => {
		for (const minutes of [13, 20, 45, 90, 180]) {
			expect(
				shouldChunkForTranscription({
					isAudioSource: false,
					knownDurationSec: minutes * MIN,
				}),
			).toBe(true);
		}
	});

	it("chunks a long webAudio source too — the drift is the model's, not the source's", () => {
		expect(
			shouldChunkForTranscription({
				isAudioSource: true,
				knownDurationSec: 36 * MIN,
			}),
		).toBe(true);
	});

	it("single-shots a short webAudio source", () => {
		expect(
			shouldChunkForTranscription({
				isAudioSource: true,
				knownDurationSec: 8 * MIN,
			}),
		).toBe(false);
	});

	it("chunks when the duration is unknown rather than guessing short", () => {
		expect(
			shouldChunkForTranscription({
				isAudioSource: false,
				knownDurationSec: null,
			}),
		).toBe(true);
	});
});

import { transcriptHasCues } from "@/lib/transcription-chunking";

describe("transcriptHasCues", () => {
	it("accepts a real transcript with cues", () => {
		const vtt =
			"WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Aziz>Salom, xush kelibsiz.";
		expect(transcriptHasCues(vtt)).toBe(true);
	});

	it("rejects empty / header-only results that must not overwrite a good transcript", () => {
		expect(transcriptHasCues("")).toBe(false);
		expect(transcriptHasCues(null)).toBe(false);
		expect(transcriptHasCues(undefined)).toBe(false);
		expect(transcriptHasCues("WEBVTT")).toBe(false);
		expect(transcriptHasCues("WEBVTT\n\n")).toBe(false);
		expect(transcriptHasCues("WEBVTT\n   \n  ")).toBe(false);
		// text but no cue timings is not a usable transcript
		expect(transcriptHasCues("WEBVTT\n\njust some words")).toBe(false);
	});
});

import {
	collapseInCueRepeats,
	collapseRepeatedCues,
} from "@/lib/transcription-chunking";

describe("repetition-loop cleanup", () => {
	it("collapses a word repeated within a cue", () => {
		expect(collapseInCueRepeats("Ha, ha, ha, ha, ha, ha.")).toBe("Ha.");
		expect(collapseInCueRepeats("<v Speaker 3>Hm hm hm hm")).toBe(
			"<v Speaker 3>Hm",
		);
	});

	it("leaves a normal repeated-twice phrase alone", () => {
		// 2 in a row is not a loop
		expect(collapseInCueRepeats("Ha, ha.")).toBe("Ha, ha.");
	});

	it("collapses a run of 148 identical 'Ha.' cues into one spanning cue", () => {
		const cues = Array.from({ length: 148 }, (_, i) => ({
			index: i + 1,
			startSec: 4145 + i * 0.4,
			endSec: 4145 + i * 0.4 + 0.4,
			text: "<v Speaker 15>Ha.",
		}));
		const out = collapseRepeatedCues(cues);
		expect(out).toHaveLength(1);
		expect(out[0]?.startSec).toBeCloseTo(4145);
		// spans to the end of the run
		expect(out[0]?.endSec).toBeGreaterThan(4200);
	});

	it("collapses adjacent duplicate cues but keeps distinct speech", () => {
		const out = collapseRepeatedCues([
			{ index: 1, startSec: 0, endSec: 1, text: "Buni screenshot qilib." },
			{ index: 2, startSec: 1, endSec: 2, text: "Buni screenshot qilib." },
			{ index: 3, startSec: 2, endSec: 3, text: "Keyingi qadam." },
		]);
		expect(out.map((c) => c.text)).toEqual([
			"Buni screenshot qilib.",
			"Keyingi qadam.",
		]);
	});

	it("preserves genuine single backchannel between real sentences", () => {
		const out = collapseRepeatedCues([
			{ index: 1, startSec: 0, endSec: 1, text: "Tizimni tekshiramiz." },
			{ index: 2, startSec: 1, endSec: 2, text: "Ha." },
			{ index: 3, startSec: 2, endSec: 3, text: "Keyin davom etamiz." },
		]);
		expect(out).toHaveLength(3);
	});
});

import { planVadChunks } from "@/lib/transcription-chunking";

describe("planVadChunks (VAD chunk boundaries)", () => {
	it("returns one chunk for short speech with no big silence", () => {
		const chunks = planVadChunks([], 120, { targetSec: 240, maxSec: 300 });
		expect(chunks).toEqual([{ startSec: 0, endSec: 120 }]);
	});

	it("skips a long silence entirely (dead air is never in a chunk)", () => {
		// speech 0-60, silence 60-180 (2min), speech 180-240
		const chunks = planVadChunks([{ startSec: 60, endSec: 180 }], 240, {
			targetSec: 240,
			maxSec: 300,
			gapSkipSec: 2,
		});
		expect(chunks).toEqual([
			{ startSec: 0, endSec: 60 },
			{ startSec: 180, endSec: 240 },
		]);
		// the 120s of silence is in neither chunk
		const covered = chunks.reduce((s, c) => s + (c.endSec - c.startSec), 0);
		expect(covered).toBe(120); // not 240
	});

	it("splits a long speech block at a natural pause near the target", () => {
		// wall-to-wall speech 0-500 with a short pause at ~250
		const chunks = planVadChunks(
			[{ startSec: 250, endSec: 250.5 }], // short pause (< gapSkipSec)
			500,
			{ targetSec: 240, maxSec: 300, gapSkipSec: 2 },
		);
		// first cut lands on the pause midpoint (~250.25), not a blind 240
		expect(chunks.length).toBe(2);
		expect(chunks[0]?.endSec).toBeCloseTo(250.25, 1);
		expect(chunks[1]).toEqual({ startSec: 250.25, endSec: 500 });
	});

	it("hard-cuts continuous speech with no pause at maxSec", () => {
		const chunks = planVadChunks([], 700, {
			targetSec: 240,
			maxSec: 300,
			gapSkipSec: 2,
		});
		// 700s of unbroken speech → 300 + 300 + 100
		expect(chunks.map((c) => Math.round(c.endSec - c.startSec))).toEqual([
			300, 300, 100,
		]);
	});

	it("never exceeds maxSec on any chunk", () => {
		const chunks = planVadChunks(
			[
				{ startSec: 400, endSec: 401 },
				{ startSec: 900, endSec: 903 },
			],
			1200,
			{ targetSec: 240, maxSec: 300, gapSkipSec: 2 },
		);
		for (const c of chunks) {
			expect(c.endSec - c.startSec).toBeLessThanOrEqual(300 + 0.5);
		}
	});
});
