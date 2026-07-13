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
