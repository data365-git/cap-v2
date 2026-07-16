import { describe, expect, it } from "vitest";
import { shouldAllowReprocess } from "@/lib/reprocess-rate-limit";

const ONE_HOUR_MS = 60 * 60 * 1000;

describe("shouldAllowReprocess", () => {
	it("allows a reprocess when there are no prior attempts", () => {
		expect(shouldAllowReprocess([], 0)).toBe(true);
	});

	it("allows up to 3 reprocesses within the same rolling hour", () => {
		const now = 1_000_000;
		const timestamps = [now, now + 1, now + 2];

		expect(shouldAllowReprocess(timestamps.slice(0, 0), now)).toBe(true);
		expect(shouldAllowReprocess(timestamps.slice(0, 1), now)).toBe(true);
		expect(shouldAllowReprocess(timestamps.slice(0, 2), now)).toBe(true);
	});

	it("blocks the 4th reprocess within the same rolling hour", () => {
		const now = 1_000_000;
		const timestamps = [now, now + 1, now + 2];

		expect(shouldAllowReprocess(timestamps, now + 3)).toBe(false);
	});

	it("allows again once the window slides past the oldest attempts", () => {
		const now = 1_000_000;
		const timestamps = [now, now + 1, now + 2];

		// Still within the hour: blocked.
		expect(shouldAllowReprocess(timestamps, now + ONE_HOUR_MS - 1)).toBe(
			false,
		);

		// All 3 timestamps are now older than an hour: allowed again.
		expect(shouldAllowReprocess(timestamps, now + ONE_HOUR_MS + 1)).toBe(
			true,
		);
	});

	it("only counts timestamps still within the last hour", () => {
		const now = 1_000_000;
		// One old attempt (outside the window) plus two recent ones.
		const timestamps = [now - ONE_HOUR_MS - 1, now + 10, now + 20];

		expect(shouldAllowReprocess(timestamps, now + 30)).toBe(true);
	});
});
