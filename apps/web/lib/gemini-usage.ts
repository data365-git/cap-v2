/**
 * Shared token accounting for Gemini responses.
 *
 * Kept free of app imports so it can be unit-tested directly — it decides what
 * we believe every AI call costs.
 */

export interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	/**
	 * Thinking tokens. Gemini 3 thinks by default and Google bills these at the
	 * **output** rate, but reports them separately from `candidatesTokenCount`.
	 */
	thoughtsTokenCount?: number;
}

/**
 * Tokens billed at the output rate: the answer *plus* the thinking that produced
 * it. Counting only `candidatesTokenCount` under-reports spend, and thinking
 * routinely dwarfs the answer — a real gemini-3-flash-preview reply spent 65
 * thinking tokens to emit the single token "OK".
 */
export function billedOutputTokens(usage?: GeminiUsageMetadata): number {
	return (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0);
}

/** Tokens billed at the input rate. */
export function billedInputTokens(usage?: GeminiUsageMetadata): number {
	return usage?.promptTokenCount ?? 0;
}
