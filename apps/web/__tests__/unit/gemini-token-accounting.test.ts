import { describe, expect, it } from "vitest";
import { billedInputTokens, billedOutputTokens } from "@/lib/gemini-usage";

/**
 * Gemini 3 thinks by default, and Google bills thinking tokens at the **output**
 * rate while reporting them in `thoughtsTokenCount`, separate from
 * `candidatesTokenCount`. Every call site (transcribe / summary / chat /
 * cost-guard) originally recorded only `candidatesTokenCount`, so the cost
 * tracker under-reported real spend — badly, because thinking routinely dwarfs
 * the answer: a real gemini-3-flash-preview reply spent 65 thinking tokens to
 * emit the single token "OK".
 */
describe("billedOutputTokens", () => {
	it("counts thinking tokens as output", () => {
		// The measured shape of a real gemini-3-flash-preview reply to "say OK".
		expect(
			billedOutputTokens({ candidatesTokenCount: 1, thoughtsTokenCount: 65 }),
		).toBe(66);
	});

	it("does not silently drop thinking — the original bug", () => {
		expect(
			billedOutputTokens({ candidatesTokenCount: 1, thoughtsTokenCount: 65 }),
		).not.toBe(1);
	});

	it("is unchanged for non-thinking replies", () => {
		expect(billedOutputTokens({ candidatesTokenCount: 500 })).toBe(500);
		expect(
			billedOutputTokens({ candidatesTokenCount: 500, thoughtsTokenCount: 0 }),
		).toBe(500);
	});

	it("treats absent usage as zero rather than NaN", () => {
		expect(billedOutputTokens({})).toBe(0);
		expect(billedOutputTokens(undefined)).toBe(0);
	});
});

describe("billedInputTokens", () => {
	it("reads the prompt token count", () => {
		expect(billedInputTokens({ promptTokenCount: 55_474 })).toBe(55_474);
	});

	it("treats absent usage as zero rather than NaN", () => {
		expect(billedInputTokens(undefined)).toBe(0);
	});
});
