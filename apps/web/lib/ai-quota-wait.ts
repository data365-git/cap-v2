/**
 * Signals that a cheap-mode AI job hit a free/quota wall and is now PARKED
 * (PROCESSING + aiQuotaWaiting) waiting for the Batch collector / patience cron,
 * rather than having failed. The workflow catches this to avoid marking ERROR.
 */
export class AiQuotaWaitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiQuotaWaitError";
	}
}

export function isAiQuotaWaitError(error: unknown): error is AiQuotaWaitError {
	return (
		error instanceof AiQuotaWaitError ||
		(error instanceof Error && error.name === "AiQuotaWaitError")
	);
}

/**
 * True when an error looks like a Gemini quota / rate-limit wall. Recognizes
 * cap-v2's existing `QuotaExceededError` (thrown by gemini-transcribe on
 * 429/quota/RESOURCE_EXHAUSTED) BY NAME so we extend the existing quota concept
 * instead of adding a parallel one, plus the raw upstream messages a Batch or
 * generation call can surface.
 */
export function isQuotaLikeAiError(error: unknown): boolean {
	if (error instanceof Error && error.name === "QuotaExceededError")
		return true;
	const message = error instanceof Error ? error.message : String(error);
	return /\b429\b|RESOURCE_EXHAUSTED|quota|rate[- ]?limit|too many requests|generate_content_free_tier|limit: 0/i.test(
		message,
	);
}
