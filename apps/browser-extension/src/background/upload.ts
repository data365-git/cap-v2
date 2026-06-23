import { createCapApi } from "./api";
import type { CompletedPart, ExtensionSettings } from "./state";
import { getSettings, getState, setState } from "./state";

const MIN_PART_SIZE = 5 * 1024 * 1024;
const RETRY_QUEUE_KEY = "capExtRetryQueue";
const DEAD_LETTER_KEY = "capExtDeadLetterQueue";
const MAX_ATTEMPTS = 6;

const BACKOFF_SECONDS = [1, 4, 16, 64, 256];

interface RetryItem {
	kind: "part" | "complete" | "recording-complete";
	payload: Record<string, unknown>;
	attempts: number;
	nextRetryAt: number;
}

let inMemoryBuffer: Uint8Array = new Uint8Array(0);

function appendToBuffer(chunk: Uint8Array): void {
	const merged = new Uint8Array(inMemoryBuffer.length + chunk.length);
	merged.set(inMemoryBuffer, 0);
	merged.set(chunk, inMemoryBuffer.length);
	inMemoryBuffer = merged;
}

export function discardUpload(): void {
	inMemoryBuffer = new Uint8Array(0);
}

function drainBuffer(): Uint8Array {
	const drained = inMemoryBuffer;
	inMemoryBuffer = new Uint8Array(0);
	return drained;
}

async function getRetryQueue(): Promise<RetryItem[]> {
	const result = await chrome.storage.local.get(RETRY_QUEUE_KEY);
	return (result[RETRY_QUEUE_KEY] as RetryItem[] | undefined) ?? [];
}

async function setRetryQueue(queue: RetryItem[]): Promise<void> {
	await chrome.storage.local.set({ [RETRY_QUEUE_KEY]: queue });
}

async function addToRetryQueue(
	item: Omit<RetryItem, "attempts" | "nextRetryAt">,
): Promise<void> {
	const queue = await getRetryQueue();
	queue.push({ ...item, attempts: 0, nextRetryAt: Date.now() + 1000 });
	await setRetryQueue(queue);
}

async function moveToDeadLetter(item: RetryItem): Promise<void> {
	const result = await chrome.storage.local.get(DEAD_LETTER_KEY);
	const dead = (result[DEAD_LETTER_KEY] as RetryItem[] | undefined) ?? [];
	dead.push(item);
	await chrome.storage.local.set({ [DEAD_LETTER_KEY]: dead });

	chrome.notifications.create({
		type: "basic",
		iconUrl: "/icons/icon-48.png",
		title: "Cap upload failed",
		message: "Upload failed — recording saved locally as fallback",
	});
}

async function requireSettings(): Promise<ExtensionSettings> {
	const settings = await getSettings();
	if (!settings.apiKey) {
		throw new Error("[upload] apiKey is not configured in extension settings");
	}
	return settings;
}

async function uploadPart(
	partData: Uint8Array,
	partNumber: number,
	videoId: string,
	uploadId: string,
	settings: ExtensionSettings,
): Promise<CompletedPart> {
	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);

	const { presignedUrl } = await api.presignPart({
		uploadId,
		partNumber,
		videoId,
		subpath: "result.mp4",
	});

	const putRes = await fetch(presignedUrl, {
		method: "PUT",
		headers: { "Content-Type": "application/octet-stream" },
		body: partData,
	});

	if (!putRes.ok) {
		const text = await putRes.text().catch(() => "");
		throw new Error(
			`[upload] PUT part ${partNumber} failed ${putRes.status}: ${text}`,
		);
	}

	const etag = putRes.headers.get("ETag");

	return {
		ETag: etag ? etag.replace(/"/g, "") : "RESOLVE_SERVER_SIDE",
		PartNumber: partNumber,
	};
}

export async function initializeUpload(
	mode: "instruction" | "meeting",
	meetingId?: string,
): Promise<{ videoId: string; uploadId: string }> {
	const settings = await requireSettings();
	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);

	const now = new Date();
	const dateStr = now.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const name =
		mode === "meeting" && meetingId
			? `Cap Meeting — ${meetingId}`
			: `Cap Recording — ${dateStr}`;

	const { id: videoId } = await api.createVideo({
		recordingMode: "extensionWeb",
		name,
		extensionContext: mode,
		meetingId,
	});

	const { uploadId } = await api.initiateMultipart({
		contentType: "video/webm",
		videoId,
		subpath: "result.mp4",
	});

	inMemoryBuffer = new Uint8Array(0);

	return { videoId, uploadId };
}

export async function handleChunk(
	chunk: ArrayBuffer,
	_index: number,
	_mime: string,
): Promise<void> {
	const state = await getState();
	if (state.kind !== "recording") return;

	const data = new Uint8Array(chunk);
	appendToBuffer(data);

	const newTotalBytes = state.totalBytes + data.length;

	if (inMemoryBuffer.length >= MIN_PART_SIZE) {
		const partData = drainBuffer();
		const settings = await requireSettings();

		try {
			const completedPart = await uploadPart(
				partData,
				state.nextPartNumber,
				state.videoId,
				state.uploadId,
				settings,
			);

			const freshState = await getState();
			if (freshState.kind !== "recording") return;

			await setState({
				...freshState,
				parts: [...freshState.parts, completedPart],
				nextPartNumber: freshState.nextPartNumber + 1,
				totalBytes: newTotalBytes,
				uploadedBytes: freshState.uploadedBytes + partData.length,
			});
		} catch (err) {
			console.error("[upload] Part upload failed:", err);
			await addToRetryQueue({
				kind: "part",
				payload: {
					partNumber: state.nextPartNumber,
					videoId: state.videoId,
					uploadId: state.uploadId,
				},
			});

			const freshState = await getState();
			if (freshState.kind === "recording") {
				await setState({ ...freshState, totalBytes: newTotalBytes });
			}
		}
	} else {
		await setState({ ...state, totalBytes: newTotalBytes });
	}
}

export async function finalizeUpload(): Promise<void> {
	const state = await getState();
	if (state.kind !== "recording" && state.kind !== "uploading") return;

	const settings = await requireSettings();
	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);

	let parts = [...state.parts];
	let nextPartNumber =
		state.kind === "recording" ? state.nextPartNumber : state.parts.length + 1;
	const totalBytes = state.totalBytes;
	const uploadedBytes =
		"uploadedBytes" in state ? (state.uploadedBytes as number) : 0;
	const { videoId, uploadId } = state;

	if (state.kind === "recording") {
		await setState({
			kind: "uploading",
			videoId,
			uploadId,
			parts,
			totalBytes,
			uploadedBytes,
		});
	}

	const remaining = drainBuffer();
	if (remaining.length > 0) {
		try {
			const completedPart = await uploadPart(
				remaining,
				nextPartNumber,
				videoId,
				uploadId,
				settings,
			);
			parts = [...parts, completedPart];
			nextPartNumber += 1;
		} catch (err) {
			console.error("[upload] Final part upload failed:", err);
			await addToRetryQueue({
				kind: "part",
				payload: {
					partNumber: nextPartNumber,
					videoId,
					uploadId,
				},
			});
		}
	}

	if (parts.length === 0) {
		const bufferLen = remaining.length;
		console.error(
			`[upload] No parts uploaded — cannot complete multipart. totalBytes=${totalBytes}, remainingBuffer=${bufferLen}`,
		);
		await setState({
			kind: "error",
			reason:
				totalBytes === 0
					? "No recording data was captured. Check screen-capture permissions and try again."
					: `Upload failed — ${totalBytes} bytes captured but no parts uploaded. Check network or try again.`,
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	await setState({ kind: "finishing", videoId });

	try {
		const apiParts = parts.map((p) => ({
			partNumber: p.PartNumber,
			etag: p.ETag,
			size: 0,
		}));
		await api.completeMultipart({
			uploadId,
			parts: apiParts,
			videoId,
			subpath: "result.mp4",
		});
	} catch (err) {
		console.error("[upload] completeMultipart failed:", err);
		await addToRetryQueue({
			kind: "complete",
			payload: {
				uploadId,
				videoId,
				parts: parts.map((p) => ({
					partNumber: p.PartNumber,
					etag: p.ETag,
					size: 0,
				})),
			},
		});
		await setState({
			kind: "error",
			reason: `Upload finalization failed: ${err instanceof Error ? err.message : String(err)}`,
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	try {
		await api.recordingComplete({ videoId });
	} catch (err) {
		console.error("[upload] recordingComplete failed:", err);
		await addToRetryQueue({
			kind: "recording-complete",
			payload: { videoId },
		});
	}

	const shareUrl = `${settings.apiBaseUrl}/s/${videoId}`;
	await setState({ kind: "complete", videoId, shareUrl });
}

export async function retryPendingUploads(): Promise<void> {
	const queue = await getRetryQueue();
	if (queue.length === 0) return;

	const settings = await getSettings();
	if (!settings.apiKey) return;

	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);
	const now = Date.now();

	const remaining: RetryItem[] = [];

	for (const item of queue) {
		if (item.nextRetryAt > now) {
			remaining.push(item);
			continue;
		}

		try {
			if (item.kind === "part") {
				await moveToDeadLetter(item);
			} else if (item.kind === "complete") {
				const { uploadId, videoId, parts } = item.payload as {
					uploadId: string;
					videoId: string;
					parts: Array<{ partNumber: number; etag: string; size: number }>;
				};
				await api.completeMultipart({
					uploadId,
					parts,
					videoId,
					subpath: "result.mp4",
				});
			} else if (item.kind === "recording-complete") {
				const { videoId } = item.payload as { videoId: string };
				await api.recordingComplete({ videoId });
			}
		} catch (err) {
			console.error(`[upload] Retry failed for ${item.kind}:`, err);
			const nextAttempts = item.attempts + 1;
			if (nextAttempts >= MAX_ATTEMPTS) {
				await moveToDeadLetter({ ...item, attempts: nextAttempts });
			} else {
				const delaySec = BACKOFF_SECONDS[nextAttempts - 1] ?? 256;
				remaining.push({
					...item,
					attempts: nextAttempts,
					nextRetryAt: now + delaySec * 1000,
				});
			}
		}
	}

	await setRetryQueue(remaining);
}

export async function checkApiHealth(): Promise<boolean> {
	try {
		const settings = await getSettings();
		const res = await fetch(`${settings.apiBaseUrl}/api/status`, {
			headers: { Authorization: `Bearer ${settings.apiKey}` },
		});
		return res.ok;
	} catch {
		return false;
	}
}
