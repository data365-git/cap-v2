/**
 * Rate limit for owner/admin-forced "Qayta analiz" (reprocess) requests on
 * /api/videos/[videoId]/generate: at most 3 forced reprocesses per rolling
 * hour, per video.
 *
 * Backed by a module-level in-memory Map (no Redis / new deps). This is
 * per-instance by design — acceptable at current single-instance scale.
 */

const ONE_HOUR_MS = 60 * 60 * 1000;
const MAX_REPROCESSES_PER_HOUR = 3;

/** Error code returned (HTTP 429) when the per-video reprocess limit is exceeded. */
export const REPROCESS_RATE_LIMIT_CODE = "reprocess_rate_limited";

/**
 * Pure helper: given the existing reprocess timestamps for a video and the
 * current time, decide whether another forced reprocess is allowed. Callers
 * are responsible for pruning/persisting the timestamps list (see
 * `recordReprocessAttempt` below).
 */
export function shouldAllowReprocess(
	timestamps: number[],
	now: number,
): boolean {
	const recent = timestamps.filter((t) => now - t < ONE_HOUR_MS);
	return recent.length < MAX_REPROCESSES_PER_HOUR;
}

const reprocessTimestampsByVideoId = new Map<string, number[]>();

/**
 * Checks whether a forced reprocess is currently allowed for `videoId` and,
 * if so, records this attempt's timestamp. Returns false (and does NOT
 * record) when the video is already at the rolling-hour limit.
 */
export function recordReprocessAttempt(
	videoId: string,
	now: number = Date.now(),
): boolean {
	const existing = reprocessTimestampsByVideoId.get(videoId) ?? [];
	const recent = existing.filter((t) => now - t < ONE_HOUR_MS);

	if (recent.length >= MAX_REPROCESSES_PER_HOUR) {
		reprocessTimestampsByVideoId.set(videoId, recent);
		return false;
	}

	recent.push(now);
	reprocessTimestampsByVideoId.set(videoId, recent);
	return true;
}
