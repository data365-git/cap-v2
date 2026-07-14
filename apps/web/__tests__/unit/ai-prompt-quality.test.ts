import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/database/helpers", () => ({ nanoId: vi.fn() }));
vi.mock("@cap/database/schema", () => ({
	aiUsageEvents: {},
	organizations: {},
	videos: {},
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/utils", () => ({ priceForMicros: vi.fn() }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));
vi.mock("workflow", () => ({ FatalError: class extends Error {} }));
vi.mock("server-only", () => ({}));

import {
	buildMasterPrompt,
	MASTER_SCHEMA_EXAMPLE,
} from "@/workflows/generate-ai";

/**
 * The model follows the EXAMPLE over the instructions. Two real defects came
 * straight from MASTER_SCHEMA_EXAMPLE teaching the wrong thing:
 *
 *  - `"category": "Alice", "assignee": "Alice"` — so every real task came back
 *    with category === assignee, which makes the "group tasks by context" feature
 *    useless: the grouping axis just restates who owns it.
 *
 *  - `"deadline": "2024-07-05"` — a hardcoded past-year date. The model has no
 *    clock, so it copied the shape and invented deadlines: a 2026 meeting
 *    produced "2024-06-15", shown to the user as fact.
 */
describe("MASTER_SCHEMA_EXAMPLE", () => {
	const tasks = JSON.parse(MASTER_SCHEMA_EXAMPLE).aiSummary.tasks as Array<{
		category: string;
		assignee: string;
		deadline: string;
	}>;

	it("is valid JSON (the model is told to copy this structure exactly)", () => {
		expect(Array.isArray(tasks)).toBe(true);
		expect(tasks.length).toBeGreaterThan(0);
	});

	it("never shows category as a copy of assignee", () => {
		for (const t of tasks) {
			expect(t.category).not.toBe(t.assignee);
		}
	});

	it("never demonstrates a hardcoded deadline — that is what taught it to invent dates", () => {
		for (const t of tasks) {
			expect(t.deadline).toBe("");
		}
	});
});

describe("buildMasterPrompt", () => {
	const prompt = () =>
		buildMasterPrompt(2192, "[0:00] salom", "Respond in Uzbek.", "2026-07-13");

	it("tells the model the meeting date, so relative dates resolve instead of being guessed", () => {
		expect(prompt()).toContain("2026-07-13");
	});

	it("forbids inventing a year", () => {
		expect(prompt()).toMatch(/never (assume|emit|guess)/i);
	});

	it("demands exhaustive task extraction — 2 tasks from a 36-min meeting was the bug", () => {
		expect(prompt()).toMatch(/EXHAUSTIVE/);
		expect(prompt()).toMatch(/5-15 tasks/);
	});

	it("forbids category from restating assignee", () => {
		expect(prompt()).toMatch(/NOT a copy of assignee/);
	});

	it("still passes the real video duration through for timestamp bounds", () => {
		expect(prompt()).toContain("2192");
	});
});
