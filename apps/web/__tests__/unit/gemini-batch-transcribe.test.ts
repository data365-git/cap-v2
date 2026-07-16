import { describe, expect, it } from "vitest";
import {
	BATCH_TIMEOUT_MS,
	buildBatchRequestBody,
	extractInlinedResponse,
	isTerminalBatchState,
	mapBatchState,
	shouldFallbackToSync,
	unwrapBatchResponse,
} from "@/lib/gemini-batch-transcribe";
import {
	buildTranscriptionPrompt,
	TRANSCRIBE_MAX_OUTPUT_TOKENS,
} from "@/lib/gemini-transcribe";

describe("mapBatchState / isTerminalBatchState", () => {
	it("classifies terminal + pending states, tolerant of the bare token", () => {
		expect(mapBatchState("BATCH_STATE_SUCCEEDED")).toBe("succeeded");
		expect(mapBatchState("succeeded")).toBe("succeeded");
		expect(mapBatchState("BATCH_STATE_FAILED")).toBe("failed");
		expect(mapBatchState("BATCH_STATE_CANCELLED")).toBe("failed");
		expect(mapBatchState("BATCH_STATE_EXPIRED")).toBe("failed");
		expect(mapBatchState("BATCH_STATE_RUNNING")).toBe("pending");
		expect(mapBatchState("PENDING")).toBe("pending");
		expect(mapBatchState(undefined)).toBe("pending");
		expect(mapBatchState(null)).toBe("pending");
	});

	it("isTerminalBatchState is true only for succeeded/failed", () => {
		expect(isTerminalBatchState("BATCH_STATE_SUCCEEDED")).toBe(true);
		expect(isTerminalBatchState("BATCH_STATE_FAILED")).toBe(true);
		expect(isTerminalBatchState("RUNNING")).toBe(false);
	});
});

describe("shouldFallbackToSync", () => {
	it("never falls back for a terminal state, regardless of elapsed", () => {
		expect(
			shouldFallbackToSync({
				state: "BATCH_STATE_SUCCEEDED",
				elapsedMs: BATCH_TIMEOUT_MS * 10,
			}),
		).toBe(false);
	});

	it("falls back only once a pending batch passes the timeout", () => {
		expect(shouldFallbackToSync({ state: "RUNNING", elapsedMs: 1000 })).toBe(
			false,
		);
		expect(
			shouldFallbackToSync({ state: "RUNNING", elapsedMs: BATCH_TIMEOUT_MS }),
		).toBe(true);
	});
});

describe("extractInlinedResponse", () => {
	it("finds the first inlined entry across the known nesting shapes", () => {
		const single = {
			response: { inlinedResponses: [{ response: { ok: 1 } }] },
		};
		expect(extractInlinedResponse(single)).toEqual({ response: { ok: 1 } });
		const doubled = {
			response: {
				inlinedResponses: { inlinedResponses: [{ response: { ok: 2 } }] },
			},
		};
		expect(extractInlinedResponse(doubled)).toEqual({ response: { ok: 2 } });
		const underOutput = {
			output: { inlinedResponses: [{ error: { message: "x" } }] },
		};
		expect(extractInlinedResponse(underOutput)).toEqual({
			error: { message: "x" },
		});
	});

	it("returns undefined when there is no inlined result", () => {
		expect(extractInlinedResponse({})).toBeUndefined();
		expect(extractInlinedResponse(null)).toBeUndefined();
	});
});

describe("unwrapBatchResponse", () => {
	function batchWith(text: string, usage?: Record<string, unknown>) {
		return {
			response: {
				inlinedResponses: [
					{
						response: {
							candidates: [
								{ content: { parts: [{ text }] }, finishReason: "STOP" },
							],
							usageMetadata: usage,
						},
					},
				],
			},
		};
	}

	it("pulls text + tokens; treats all input as audio when the AUDIO detail is absent", () => {
		const out = unwrapBatchResponse(
			batchWith("WEBVTT\n\n00:00.000 --> 00:01.000\nhi", {
				promptTokenCount: 500,
				candidatesTokenCount: 40,
			}),
		);
		expect(out.rawText).toContain("WEBVTT");
		expect(out.inputTokens).toBe(500);
		expect(out.outputTokens).toBe(40);
		expect(out.audioInTokens).toBe(500);
	});

	it("uses the explicit AUDIO token detail when present", () => {
		const out = unwrapBatchResponse(
			batchWith("hi", {
				promptTokenCount: 500,
				candidatesTokenCount: 40,
				promptTokensDetails: [{ modality: "AUDIO", tokenCount: 450 }],
			}),
		);
		expect(out.audioInTokens).toBe(450);
	});

	it("throws on an inline error, empty text, or a missing inlined entry", () => {
		expect(() =>
			unwrapBatchResponse({
				response: { inlinedResponses: [{ error: { message: "quota" } }] },
			}),
		).toThrow(/quota/);
		expect(() => unwrapBatchResponse(batchWith("   "))).toThrow(
			/empty transcript/,
		);
		expect(() => unwrapBatchResponse({})).toThrow(/missing inlinedResponses/);
	});
});

describe("buildBatchRequestBody", () => {
	it("wraps the SAME prompt + token cap the sync path uses, in the batch envelope", () => {
		const body = buildBatchRequestBody({
			mimeType: "audio/mpeg",
			fileUri: "files/xyz",
			displayName: "cap-batch-v1",
		}) as {
			batch: {
				display_name: string;
				input_config: {
					requests: {
						requests: Array<{
							request: {
								contents: Array<{ parts: Array<Record<string, unknown>> }>;
								generationConfig: { maxOutputTokens: number };
							};
						}>;
					};
				};
			};
		};
		const req = body.batch.input_config.requests.requests[0]!.request;
		expect(body.batch.display_name).toBe("cap-batch-v1");
		expect(req.contents[0]!.parts[0]).toEqual({
			fileData: { mimeType: "audio/mpeg", fileUri: "files/xyz" },
		});
		expect(req.contents[0]!.parts[1]).toEqual({
			text: buildTranscriptionPrompt(),
		});
		expect(req.generationConfig.maxOutputTokens).toBe(
			TRANSCRIBE_MAX_OUTPUT_TOKENS,
		);
	});
});
