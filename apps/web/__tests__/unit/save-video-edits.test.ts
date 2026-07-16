import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUserMock = vi.fn();

// Rows returned by each successive `db().select()...where()` (or `.limit()`)
// call, in order. This lets a single test drive the videos lookup followed by
// the videoUploads lookup.
let selectResultQueue: unknown[][] = [];
const whereMock = vi.fn(() => {
	const rows = selectResultQueue.shift() ?? [];
	// The videos query is awaited directly; the videoUploads query appends
	// `.limit(1)`. Return a thenable that also answers `.limit`, so both shapes
	// resolve to the queued rows.
	const result = Promise.resolve(rows) as Promise<unknown[]> & {
		limit: () => Promise<unknown[]>;
	};
	result.limit = () => Promise.resolve(rows);
	return result;
});
const selectMock = vi.fn(() => ({
	from: vi.fn(() => ({
		where: whereMock,
	})),
}));
const insertMock = vi.fn();

vi.mock("@cap/database", () => ({
	db: () => ({
		select: selectMock,
		insert: insertMock,
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: getCurrentUserMock,
}));

vi.mock("@cap/utils", () => ({
	userIsPro: (user?: { isPro?: boolean } | null) => Boolean(user?.isPro),
}));

vi.mock("@cap/web-backend", () => ({
	Storage: {
		getAccessForVideo: vi.fn(),
	},
}));

vi.mock("workflow/api", () => ({
	start: vi.fn(),
}));

vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
}));

vi.mock("@/lib/video-storage", () => ({
	decodeStorageVideo: vi.fn(),
}));

vi.mock("server-only", () => ({}));

describe("saveVideoEdits", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		selectResultQueue = [];
	});

	it("returns a signed-out result without touching the database", async () => {
		getCurrentUserMock.mockResolvedValueOnce(null);
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");

		const result = await saveVideoEdits("video-1" as never, {
			version: 1,
			sourceDuration: 10,
			keepRanges: [{ start: 0, end: 10 }],
		});

		expect(result).toEqual({
			ok: false,
			error: "You're signed out. Please log in again.",
		});
		expect(selectMock).not.toHaveBeenCalled();
	});

	it("requires Cap Pro before saving edits", async () => {
		getCurrentUserMock.mockResolvedValueOnce({ id: "user-1", isPro: false });
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");

		const result = await saveVideoEdits("video-1" as never, {
			version: 1,
			sourceDuration: 10,
			keepRanges: [{ start: 0, end: 10 }],
		});

		expect(result).toEqual({
			ok: false,
			error: "Cap Pro is required to edit videos.",
		});
		expect(selectMock).not.toHaveBeenCalled();
	});

	it("rejects when another edit is still processing the video", async () => {
		getCurrentUserMock.mockResolvedValueOnce({ id: "user-1", isPro: true });
		selectResultQueue = [
			// videos lookup
			[
				{
					id: "video-1",
					ownerId: "user-1",
					duration: 10,
					source: { type: "webMP4" },
					isScreenshot: false,
					metadata: null,
				},
			],
			// active videoUploads lookup
			[{ phase: "processing", startedAt: new Date() }],
		];
		const { saveVideoEdits } = await import("@/actions/videos/save-edits");

		const result = await saveVideoEdits("video-1" as never, {
			version: 1,
			sourceDuration: 10,
			keepRanges: [{ start: 0, end: 10 }],
		});

		expect(result).toEqual({
			ok: false,
			error:
				"Another edit is still processing this video. Please wait a moment and try again.",
		});
		expect(insertMock).not.toHaveBeenCalled();
	});
});
