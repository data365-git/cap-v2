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
