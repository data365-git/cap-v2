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

export interface SilenceInterval {
	startSec: number;
	endSec: number;
}

export interface VadChunk {
	startSec: number;
	endSec: number;
}

export interface VadPlanOptions {
	/** Preferred chunk length. */
	targetSec?: number;
	/** Hard maximum chunk length (a run of continuous speech is force-cut here). */
	maxSec?: number;
	/** Silences shorter than this stay INSIDE a chunk (natural pauses); silences
	 *  at least this long separate speech blocks and are skipped entirely (dead
	 *  air / music / hold), so they are never sent to the model. */
	gapSkipSec?: number;
}

const DEFAULT_VAD: Required<VadPlanOptions> = {
	targetSec: 240,
	maxSec: 300,
	gapSkipSec: 2,
};

/**
 * Turn detected silence intervals into a chunk plan for transcription.
 *
 * Boundaries land on silence (never mid-word), long silences are excluded from
 * every chunk (they are the repetition-loop trigger and cost dead weight), and
 * no chunk exceeds maxSec. Each chunk keeps its real start offset so timestamps
 * remap onto the original timeline. If no usable silence is found the whole
 * recording comes back as one block for the caller to fall back on.
 */
export function planVadChunks(
	silences: SilenceInterval[],
	totalDurationSec: number,
	opts: VadPlanOptions = {},
): VadChunk[] {
	const { targetSec, maxSec, gapSkipSec } = { ...DEFAULT_VAD, ...opts };
	if (!(totalDurationSec > 0)) return [];

	const clean = silences
		.map((s) => ({
			startSec: Math.max(0, s.startSec),
			endSec: Math.min(totalDurationSec, s.endSec),
		}))
		.filter((s) => s.endSec > s.startSec)
		.sort((a, b) => a.startSec - b.startSec);

	// Long silences split the timeline into speech blocks and are dropped.
	const bigGaps = clean.filter((s) => s.endSec - s.startSec >= gapSkipSec);

	const blocks: VadChunk[] = [];
	let cursor = 0;
	for (const gap of bigGaps) {
		if (gap.startSec > cursor) blocks.push({ startSec: cursor, endSec: gap.startSec });
		cursor = gap.endSec;
	}
	if (cursor < totalDurationSec) {
		blocks.push({ startSec: cursor, endSec: totalDurationSec });
	}

	// Short silences (natural pauses) are the preferred cut points inside a block
	// that is longer than maxSec.
	const shortSilenceMids = clean
		.filter((s) => s.endSec - s.startSec < gapSkipSec)
		.map((s) => (s.startSec + s.endSec) / 2);

	const chunks: VadChunk[] = [];
	for (const block of blocks) {
		let start = block.startSec;
		while (block.endSec - start > maxSec) {
			// Prefer a natural pause near the target; else hard-cut at max.
			const lo = start + targetSec;
			const hi = start + maxSec;
			const cut =
				shortSilenceMids.find((m) => m >= lo && m <= hi) ?? start + maxSec;
			chunks.push({ startSec: start, endSec: cut });
			start = cut;
		}
		if (block.endSec > start) chunks.push({ startSec: start, endSec: block.endSec });
	}
	return chunks;
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
