import { beforeEach, describe, expect, it, vi } from "vitest";

let currentUser: { id: string } | null;
let videoRow:
	| {
			id: string;
			ownerId: string;
			transcriptionStatus: string | null;
			metadata: Record<string, unknown> | null;
	  }
	| undefined;
let lastUpdateSet: Record<string, unknown> | null = null;

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => Promise.resolve(currentUser),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "id", ownerId: "o" } }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(videoRow ? [videoRow] : []),
				}),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => {
				lastUpdateSet = values;
				return { where: () => Promise.resolve() };
			},
		}),
	}),
}));

import { POST } from "@/app/api/videos/[videoId]/cancel-processing/route";

const call = () =>
	POST(new Request("http://x/api/videos/v1/cancel-processing", { method: "POST" }), {
		params: Promise.resolve({ videoId: "v1" }),
	});

/**
 * Cancelling an in-flight transcription must (a) never clobber a video that has
 * already finished, and (b) write the durable cancelRequested marker the
 * workflow checks to actually stop making Gemini calls.
 */
describe("POST cancel-processing", () => {
	beforeEach(() => {
		currentUser = { id: "user_1" };
		lastUpdateSet = null;
		videoRow = {
			id: "v1",
			ownerId: "user_1",
			transcriptionStatus: "PROCESSING",
			metadata: { existing: true },
		};
	});

	it("rejects an unauthenticated caller", async () => {
		currentUser = null;
		expect((await call()).status).toBe(401);
	});

	it("rejects a non-owner", async () => {
		videoRow = { ...videoRow!, ownerId: "someone_else" };
		expect((await call()).status).toBe(403);
	});

	it("404s for a missing video", async () => {
		videoRow = undefined;
		expect((await call()).status).toBe(404);
	});

	it("sets CANCELLED and the durable cancel marker while processing", async () => {
		const res = await call();
		expect(res.status).toBe(200);
		expect(lastUpdateSet?.transcriptionStatus).toBe("CANCELLED");
		expect(
			(lastUpdateSet?.metadata as { cancelRequested?: boolean })
				.cancelRequested,
		).toBe(true);
		// existing metadata is preserved, not overwritten
		expect(
			(lastUpdateSet?.metadata as { existing?: boolean }).existing,
		).toBe(true);
	});

	it.each(["COMPLETE", "SKIPPED", "NO_AUDIO"])(
		"409s and does NOT write when already %s",
		async (status) => {
			videoRow = { ...videoRow!, transcriptionStatus: status };
			const res = await call();
			expect(res.status).toBe(409);
			expect(lastUpdateSet).toBeNull();
		},
	);
});
