import { beforeEach, describe, expect, it, vi } from "vitest";

// The transcribe workflow keeps a PRIVATE `patchVideoMetadata(videoId, partial)`
// helper (shallow-merge form) used ~14×. It must delegate to the shared atomic
// row-locked helper so concurrent writers cannot clobber each other — AND it
// must preserve the partial-merge semantics exactly (spread the partial over the
// freshly-locked current, keeping every sibling field).

const H = vi.hoisted(() => ({
	elevenKey: undefined as string | undefined,
	video: { id: "v1", ownerId: "u1" } as Record<string, unknown> | undefined,
	patchCalls: [] as Array<{
		videoId: string;
		updater: (m: Record<string, unknown>) => Record<string, unknown>;
	}>,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(H.video ? [H.video] : []),
			}),
		}),
	}),
}));
vi.mock("@cap/database/crypto", () => ({ decrypt: vi.fn() }));
vi.mock("@cap/database/helpers", () => ({ nanoId: () => "id" }));
vi.mock("@cap/database/schema", () => ({
	organizations: {},
	transcriptChunks: {},
	users: {},
	videos: { id: "videos.id", metadata: "videos.metadata" },
	videoUploads: {},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ ELEVENLABS_API_KEY: H.elevenKey }),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://localhost:3001" },
}));
vi.mock("@cap/utils", () => ({ userIsPro: () => false }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("drizzle-orm", () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
vi.mock("workflow", () => ({ FatalError: class extends Error {} }));
vi.mock("server-only", () => ({}));
// Break the effect-Layer import chain (S3Buckets/Storage/Videos) so importing
// the real workflow module stays light.
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ decodeStorageVideo: vi.fn() }));

// The one collaborator under test: capture what the private helper delegates.
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (
		videoId: string,
		updater: (m: Record<string, unknown>) => Record<string, unknown>,
	) => {
		H.patchCalls.push({ videoId, updater });
		return Promise.resolve({});
	},
}));

const { refineVideoTimestampsWorkflow } = await import(
	"@/workflows/transcribe"
);

beforeEach(() => {
	H.elevenKey = undefined;
	H.video = { id: "v1", ownerId: "u1" };
	H.patchCalls = [];
});

describe("transcribe private patchVideoMetadata delegation", () => {
	it("routes the partial write through the atomic helper, preserving siblings", async () => {
		// missing_key early-exit path calls the private helper with a partial patch.
		const out = await refineVideoTimestampsWorkflow({
			videoId: "v1",
			userId: "u1",
		});
		expect(out).toEqual({ success: false, reason: "missing_key" });

		// It delegated to the shared atomic (row-locked) helper for video v1.
		expect(H.patchCalls).toHaveLength(1);
		const call = H.patchCalls[0];
		expect(call?.videoId).toBe("v1");

		// The delegated updater is a shallow partial-merge: it stamps the two
		// timestamp-refine fields while preserving EVERY unrelated sibling field
		// on the freshly-locked metadata (this is the anti-lost-update property).
		const merged = call?.updater({
			aiSummary: { keep: true },
			completedChunks: { "0": "WEBVTT" },
			timestampRefineStatus: "COMPLETE",
		});
		expect(merged).toEqual({
			aiSummary: { keep: true },
			completedChunks: { "0": "WEBVTT" },
			timestampRefineStatus: "ERROR",
			timestampRefineError: "missing_key",
		});
	});
});
