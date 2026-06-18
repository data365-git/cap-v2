// Media server removed — all media-client functions are deprecated stubs.
// This file is kept as a placeholder so the test runner doesn't error on import.
import { describe, expect, it } from "vitest";
import { isMediaServerConfigured } from "@/lib/media-client";

describe("media-client (removed)", () => {
	it("isMediaServerConfigured always returns false", () => {
		expect(isMediaServerConfigured()).toBe(false);
	});
});
