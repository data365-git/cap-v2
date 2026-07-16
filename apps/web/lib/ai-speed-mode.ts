/**
 * Org-level transcription speed/cost mode.
 *   fast  = synchronous Gemini generateContent (default; lowest latency). This
 *           is byte-for-byte cap-v2's existing transcription behavior.
 *   cheap = patient path: on a free/quota wall the uncovered chunk is submitted
 *           to the paid Gemini Batch API (cheaper tier), the video parks in
 *           PROCESSING + aiQuotaWaiting, a cron collects the result, and after a
 *           patience window it auto-continues on the synchronous paid tier.
 *
 * Stored in `organizations.settings.aiSpeedMode`. Resolved once at workflow
 * start and threaded through the transcription steps as a plain string (the
 * workflow `"use step"` boundary requires JSON-serializable args).
 */
export type AiSpeedMode = "fast" | "cheap";

export const DEFAULT_AI_SPEED_MODE: AiSpeedMode = "fast";

export function isAiSpeedMode(value: unknown): value is AiSpeedMode {
	return value === "fast" || value === "cheap";
}

/** Normalize any stored/unknown value to a valid mode, defaulting to `fast`. */
export function resolveAiSpeedMode(value: unknown): AiSpeedMode {
	return isAiSpeedMode(value) ? value : DEFAULT_AI_SPEED_MODE;
}
