import { describe, expect, it } from "vitest";
import {
	AiQuotaWaitError,
	isAiQuotaWaitError,
	isQuotaLikeAiError,
} from "@/lib/ai-quota-wait";
import { QuotaExceededError } from "@/lib/gemini-transcribe";

describe("AiQuotaWaitError / isAiQuotaWaitError", () => {
	it("recognizes its own instances and same-named errors across boundaries", () => {
		expect(isAiQuotaWaitError(new AiQuotaWaitError("wait"))).toBe(true);
		const lookalike = new Error("wait");
		lookalike.name = "AiQuotaWaitError";
		expect(isAiQuotaWaitError(lookalike)).toBe(true);
	});

	it("rejects unrelated errors", () => {
		expect(isAiQuotaWaitError(new Error("boom"))).toBe(false);
		expect(isAiQuotaWaitError("AiQuotaWaitError")).toBe(false);
		expect(isAiQuotaWaitError(undefined)).toBe(false);
	});
});

describe("isQuotaLikeAiError", () => {
	it("recognizes cap-v2's existing QuotaExceededError by name (extends, not duplicates)", () => {
		expect(
			isQuotaLikeAiError(new QuotaExceededError("Gemini quota exceeded")),
		).toBe(true);
		const named = new Error("anything");
		named.name = "QuotaExceededError";
		expect(isQuotaLikeAiError(named)).toBe(true);
	});

	it("matches the raw upstream quota/rate-limit messages", () => {
		expect(isQuotaLikeAiError(new Error("HTTP 429 Too Many Requests"))).toBe(
			true,
		);
		expect(isQuotaLikeAiError(new Error("RESOURCE_EXHAUSTED"))).toBe(true);
		expect(isQuotaLikeAiError(new Error("exceeded your current quota"))).toBe(
			true,
		);
		expect(isQuotaLikeAiError(new Error("rate-limited"))).toBe(true);
		expect(isQuotaLikeAiError("generate_content_free_tier")).toBe(true);
		expect(isQuotaLikeAiError(new Error("limit: 0"))).toBe(true);
	});

	it("does NOT flag ordinary/transient failures", () => {
		expect(isQuotaLikeAiError(new Error("500 internal error"))).toBe(false);
		expect(isQuotaLikeAiError(new Error("network timeout"))).toBe(false);
		expect(isQuotaLikeAiError(new Error("auth error"))).toBe(false);
	});
});
