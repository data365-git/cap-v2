import { describe, expect, it } from "vitest";
import {
	DEFAULT_AI_SPEED_MODE,
	isAiSpeedMode,
	resolveAiSpeedMode,
} from "@/lib/ai-speed-mode";

describe("resolveAiSpeedMode", () => {
	it("defaults to fast for undefined/null/unknown (the regression guard)", () => {
		expect(DEFAULT_AI_SPEED_MODE).toBe("fast");
		expect(resolveAiSpeedMode(undefined)).toBe("fast");
		expect(resolveAiSpeedMode(null)).toBe("fast");
		expect(resolveAiSpeedMode("")).toBe("fast");
		expect(resolveAiSpeedMode("turbo")).toBe("fast");
		expect(resolveAiSpeedMode(123)).toBe("fast");
	});

	it("passes through valid modes unchanged", () => {
		expect(resolveAiSpeedMode("fast")).toBe("fast");
		expect(resolveAiSpeedMode("cheap")).toBe("cheap");
	});
});

describe("isAiSpeedMode", () => {
	it("accepts only the two literal modes", () => {
		expect(isAiSpeedMode("fast")).toBe(true);
		expect(isAiSpeedMode("cheap")).toBe(true);
		expect(isAiSpeedMode("FAST")).toBe(false);
		expect(isAiSpeedMode(undefined)).toBe(false);
		expect(isAiSpeedMode({})).toBe(false);
	});
});
