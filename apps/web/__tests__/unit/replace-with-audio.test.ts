import { beforeEach, describe, expect, it, vi } from "vitest";

// "replace video with audio" — a DATA-LOSS server action. These tests pin the
// safety-first ordering: the newly-written audio object MUST read back
// correctly (verify) before anything is deleted (reclaim). Test 5 is
// mutation-critical: if the verify guard is ever removed/weakened, deleteObject
// gets called on a verify_failed path and this test goes red.

const H = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	video: null as {
		id: string;
		ownerId: string;
		metadata: Record<string, unknown>;
	} | null,
	// key -> byte size of the object currently "in storage"
	existingObjects: new Map<string, number>(),
	// when true, a putObject call acks success but does NOT update
	// existingObjects — simulating a write that didn't actually persist.
	putSkipsWrite: false,
	callOrder: [] as string[],
	putObjectCalls: [] as Array<{
		key: string;
		body: Buffer;
		fields: unknown;
	}>,
	deleteObjectCalls: [] as string[],
	extractAudioToBuffer: vi.fn(),
	patchVideoMetadata: vi.fn(
		async (
			_id: string,
			patch: (m: Record<string, unknown>) => Record<string, unknown>,
		) => patch({}),
	),
	revalidatePath: vi.fn(),
	getStorageAccessForVideo: vi.fn(),
}));

function makeBucket() {
	return {
		headObject: (key: string) => {
			H.callOrder.push(`head:${key}`);
			return {
				pipe: () => {
					const size = H.existingObjects.get(key);
					if (size === undefined) {
						return Promise.reject(new Error("NoSuchKey"));
					}
					return Promise.resolve({ ContentLength: size });
				},
			};
		},
		getInternalSignedObjectUrl: (key: string) => {
			H.callOrder.push(`signUrl:${key}`);
			return { pipe: () => Promise.resolve(`https://signed/${key}`) };
		},
		putObject: (
			key: string,
			body: Buffer,
			fields: { contentType?: string; contentLength?: number },
		) => {
			H.callOrder.push(`put:${key}`);
			H.putObjectCalls.push({ key, body, fields });
			return {
				pipe: () => {
					if (!H.putSkipsWrite) {
						H.existingObjects.set(key, body.length);
					}
					return Promise.resolve(undefined);
				},
			};
		},
		deleteObject: (key: string) => {
			H.callOrder.push(`delete:${key}`);
			H.deleteObjectCalls.push(key);
			return {
				pipe: () => {
					H.existingObjects.delete(key);
					return Promise.resolve(undefined);
				},
			};
		},
	};
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => (H.video ? [H.video] : []),
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => H.getCurrentUser(),
}));
vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		metadata: "videos.metadata",
	},
}));
vi.mock("drizzle-orm", () => ({
	eq: (f: unknown, v: unknown) => ({ f, v }),
}));
vi.mock("next/cache", () => ({
	revalidatePath: (path: string) => H.revalidatePath(path),
}));
vi.mock("@/lib/audio-extract", () => ({
	extractAudioToBuffer: (url: string) => H.extractAudioToBuffer(url),
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (
		id: string,
		patch: (m: Record<string, unknown>) => Record<string, unknown>,
	) => H.patchVideoMetadata(id, patch),
}));
vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: (video: unknown) =>
		H.getStorageAccessForVideo(video),
}));

const { replaceVideoWithAudio } = await import(
	"@/actions/video/replace-with-audio"
);

const OWNER_ID = "owner1";
const VIDEO_ID = "v1";
const AUDIO_KEY = `${OWNER_ID}/${VIDEO_ID}/audio-only.mp3`;
const TRANSCODED_KEY = `${OWNER_ID}/${VIDEO_ID}/transcoded.mp4`;
const RAW_MP4_KEY = `${OWNER_ID}/${VIDEO_ID}/raw-upload.mp4`;

beforeEach(() => {
	H.getCurrentUser.mockReset();
	H.video = { id: VIDEO_ID, ownerId: OWNER_ID, metadata: {} };
	H.existingObjects = new Map();
	H.putSkipsWrite = false;
	H.callOrder = [];
	H.putObjectCalls = [];
	H.deleteObjectCalls = [];
	H.extractAudioToBuffer.mockReset();
	H.patchVideoMetadata
		.mockReset()
		.mockImplementation(
			async (
				_id: string,
				patch: (m: Record<string, unknown>) => Record<string, unknown>,
			) => patch({}),
		);
	H.revalidatePath.mockReset();
	H.getStorageAccessForVideo.mockReset().mockImplementation(() => ({
		pipe: () => Promise.resolve([makeBucket()]),
	}));
});

describe("replaceVideoWithAudio", () => {
	it("1. non-owner is rejected before any storage call", async () => {
		H.getCurrentUser.mockResolvedValue({ id: "intruder" });

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "unauthorized" });
		expect(H.getStorageAccessForVideo).not.toHaveBeenCalled();
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});

	it("2. already isAudio short-circuits with no storage calls", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		H.video = { id: VIDEO_ID, ownerId: OWNER_ID, metadata: { isAudio: true } };

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "already_audio" });
		expect(H.getStorageAccessForVideo).not.toHaveBeenCalled();
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});

	it("3. no supported source key exists -> unsupported_source, no delete", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		// existingObjects stays empty — none of the source candidates exist

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "unsupported_source" });
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});

	it("4. happy path: extract -> put -> verify -> patch metadata -> reclaim, crash-safe order", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		H.existingObjects.set(TRANSCODED_KEY, 1_000_000); // heavy source + reclaimable
		H.existingObjects.set(RAW_MP4_KEY, 900_000); // reclaimable
		const audioBuf = Buffer.alloc(500, 1);
		H.extractAudioToBuffer.mockResolvedValue(audioBuf);
		H.patchVideoMetadata.mockImplementation(
			async (
				_id: string,
				patch: (m: Record<string, unknown>) => Record<string, unknown>,
			) => {
				H.callOrder.push("patch:isAudio");
				return patch({ aiSummary: { overview: "kept" } });
			},
		);

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({
			ok: true,
			reclaimedFrom: [TRANSCODED_KEY, RAW_MP4_KEY],
		});

		// put wrote the audio bytes to audio-only.mp3 as audio/mpeg
		expect(H.putObjectCalls).toEqual([
			{
				key: AUDIO_KEY,
				body: audioBuf,
				fields: { contentType: "audio/mpeg", contentLength: audioBuf.length },
			},
		]);

		// SAFETY ordering: put, then flip isAudio, then reclaim-delete — strictly.
		// isAudio must flip BEFORE the heavy objects are deleted so a crash between
		// them leaves working playback (audio-only.mp3, already written) plus
		// reclaimable orphans, never a video whose files are gone but isAudio=false.
		const putIndex = H.callOrder.indexOf(`put:${AUDIO_KEY}`);
		const patchIndex = H.callOrder.indexOf("patch:isAudio");
		const deleteIndex = H.callOrder.indexOf(`delete:${RAW_MP4_KEY}`);
		expect(putIndex).toBeGreaterThanOrEqual(0);
		expect(patchIndex).toBeGreaterThan(putIndex);
		expect(deleteIndex).toBeGreaterThan(patchIndex);

		expect(H.deleteObjectCalls).toEqual([TRANSCODED_KEY, RAW_MP4_KEY]);
		// the newly-written audio object is NEVER deleted
		expect(H.deleteObjectCalls).not.toContain(AUDIO_KEY);

		// metadata patch flips isAudio while keeping existing fields (AI analysis).
		expect(H.patchVideoMetadata).toHaveBeenCalledTimes(1);
		const [, patchFn] = H.patchVideoMetadata.mock.calls[0] as [
			string,
			(m: Record<string, unknown>) => Record<string, unknown>,
		];
		expect(patchFn({ aiSummary: { overview: "kept" } })).toEqual({
			aiSummary: { overview: "kept" },
			isAudio: true,
		});

		expect(H.revalidatePath).toHaveBeenCalledWith(`/s/${VIDEO_ID}`);
	});

	it("5. SAFETY: verify failure after put means deleteObject is NEVER called", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		// Only the raw upload exists so extraction proceeds, but the write to
		// audio-only.mp3 never actually lands (putSkipsWrite).
		H.existingObjects.set(RAW_MP4_KEY, 900_000);
		H.putSkipsWrite = true;
		H.extractAudioToBuffer.mockResolvedValue(Buffer.alloc(500, 1));

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "verify_failed" });
		// The put was attempted...
		expect(H.putObjectCalls).toHaveLength(1);
		// ...but because verify never saw the object, nothing was ever deleted —
		// the raw upload (still the only real copy) survives.
		expect(H.deleteObjectCalls).toHaveLength(0);
		expect(H.patchVideoMetadata).not.toHaveBeenCalled();
	});

	it("6. extraction failure -> extract_failed, no put, no delete", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		H.existingObjects.set(TRANSCODED_KEY, 1_000_000);
		H.extractAudioToBuffer.mockRejectedValue(new Error("ffmpeg exploded"));

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "extract_failed" });
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});
});
