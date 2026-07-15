/**
 * Pure policy for how a recording is fed to Gemini for transcription.
 *
 * Kept free of any app imports (db, env, server-only) so the decision can be
 * unit-tested directly — it is the single rule that, when wrong, silently
 * truncates transcripts.
 */

/** Video source: chunk beyond 12 minutes. */
export const CHUNK_THRESHOLD_SEC = 12 * 60;
/** webAudio source: same 12-minute ceiling before chunking. */
export const AUDIO_SINGLE_SHOT_MAX_SEC = 12 * 60;

/**
 * Whether this recording must be split into windows before transcription.
 *
 * Single-shot is only safe for short audio. Gemini's *context* comfortably
 * holds an hour, but its *timestamp accuracy* degrades well before that: on a
 * 36-min single-shot call it returned a full meeting's worth of text with the
 * cue times compressed into ~27 min (and in other runs drifting past the end of
 * the video). Clamping cues to the real duration then discarded the last ~10
 * minutes. Short windows keep each cue's time trustworthy; the per-chunk offset
 * shift reassembles the real timeline afterwards.
 *
 * An unknown duration is treated as long — guessing "short" and being wrong
 * truncates the transcript with no error.
 */
export function shouldChunkForTranscription(input: {
	isAudioSource: boolean;
	knownDurationSec: number | null;
}): boolean {
	const { isAudioSource, knownDurationSec } = input;
	if (knownDurationSec == null) return true;
	const limit = isAudioSource ? AUDIO_SINGLE_SHOT_MAX_SEC : CHUNK_THRESHOLD_SEC;
	return knownDurationSec > limit;
}

/**
 * Whether a VTT string contains a real transcript (at least one cue), as opposed
 * to an empty result — a bare/blank WEBVTT header, whitespace, or "". Used to
 * refuse saving an empty re-transcription over an existing good one. A genuine
 * cue always has a `-->` time range.
 */
export function transcriptHasCues(vtt: string | null | undefined): boolean {
	if (!vtt) return false;
	const body = vtt.replace(/^﻿?WEBVTT/i, "").trim();
	return body.length > 0 && vtt.includes("-->");
}

export interface RepeatCollapsibleCue {
	index: number;
	startSec: number;
	endSec: number;
	text: string;
}

const normForDedup = (t: string): string =>
	t
		.replace(/<[^>]+>/g, "")
		.replace(/[\s.,!?…-]+/g, " ")
		.trim()
		.toLowerCase();

/**
 * Collapse a word repeated 3+ times in a row inside one cue:
 * "Ha, ha, ha, ha, ha." → "Ha." — a Gemini audio loop artifact.
 */
export function collapseInCueRepeats(text: string): string {
	return text.replace(
		/(\p{L}{1,8})((?:[\s,.!?…-]+\1\b){2,})/giu,
		(_m, first) => first,
	);
}

/**
 * Remove Gemini audio repetition-loop artifacts. On silence / noise / glitches
 * the model can emit the same short token ("Ha.", "Hm.") for dozens of
 * consecutive cues, or repeat a word within a cue — observed as 148 "Ha." cues
 * in a row. Collapse consecutive cues whose text is identical (ignoring speaker
 * tag/punctuation) into one spanning cue, and collapse in-cue word loops.
 * Genuine backchannel (a single "ha" between real sentences) is untouched.
 */
export function collapseRepeatedCues<T extends RepeatCollapsibleCue>(
	cues: T[],
): T[] {
	const out: T[] = [];
	for (const cue of cues) {
		const cleaned = { ...cue, text: collapseInCueRepeats(cue.text) };
		const prev = out[out.length - 1];
		if (prev && normForDedup(prev.text) === normForDedup(cleaned.text)) {
			prev.endSec = Math.max(prev.endSec, cleaned.endSec);
			continue;
		}
		out.push(cleaned);
	}
	return out.map((c, i) => ({ ...c, index: i + 1 }));
}
