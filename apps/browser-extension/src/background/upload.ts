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

// ── Duration patching ─────────────────────────────────────────────────────
// MediaRecorder produces WebM with Duration=0 and fragmented MP4 with
// mvhd.duration=0, making the file non-seekable in most players.
// These patchers find the duration field in the already-in-memory buffer
// and overwrite it with the actual recording duration BEFORE upload.

function readU32BE(b: Uint8Array, o: number): number {
	return (((b[o] << 24) | (b[o+1] << 16) | (b[o+2] << 8) | b[o+3]) >>> 0);
}
function writeU32BE(b: Uint8Array, o: number, v: number): void {
	b[o] = (v >>> 24) & 0xff; b[o+1] = (v >>> 16) & 0xff;
	b[o+2] = (v >>> 8) & 0xff; b[o+3] = v & 0xff;
}

function findBox(b: Uint8Array, name: string, start: number, end?: number): number {
	const [n0,n1,n2,n3] = [name.charCodeAt(0),name.charCodeAt(1),name.charCodeAt(2),name.charCodeAt(3)];
	const lim = (end !== undefined ? Math.min(end, b.length) : b.length) - 8;
	let i = start;
	while (i <= lim) {
		const sz = readU32BE(b, i);
		if (sz < 8 || sz > b.length) break;
		if (b[i+4]===n0 && b[i+5]===n1 && b[i+6]===n2 && b[i+7]===n3) return i;
		i += sz;
	}
	return -1;
}

function patchMP4Duration(buf: Uint8Array, durationMs: number): void {
	const moovOff = findBox(buf, "moov", 0);
	if (moovOff < 0) return;
	const moovSz = readU32BE(buf, moovOff);
	const moovEnd = moovOff + moovSz;

	function patchDurBox(boxOff: number): void {
		if (boxOff < 0) return;
		const ver = buf[boxOff + 8];
		// version 0: timescale at +12, duration at +16 (both u32)
		// version 1: timescale at +20, duration at +24 (u32 ts, u64 dur)
		const tsOff = ver === 1 ? boxOff + 20 : boxOff + 12;
		const durOff = ver === 1 ? boxOff + 24 : boxOff + 16;
		const ts = readU32BE(buf, tsOff);
		const dur = Math.round(durationMs * ts / 1000);
		if (ver === 1) { writeU32BE(buf, durOff, 0); writeU32BE(buf, durOff+4, dur); }
		else { writeU32BE(buf, durOff, dur); }
	}

	patchDurBox(findBox(buf, "mvhd", moovOff+8, moovEnd));

	let trakOff = findBox(buf, "trak", moovOff+8, moovEnd);
	while (trakOff >= 0 && trakOff < moovEnd) {
		const trakSz = readU32BE(buf, trakOff);
		const trakEnd = trakOff + trakSz;
		// tkhd uses movie timescale (read from mvhd)
		const tkhdOff = findBox(buf, "tkhd", trakOff+8, trakEnd);
		if (tkhdOff >= 0) {
			const mvhdOff = findBox(buf, "mvhd", moovOff+8, moovEnd);
			const mvTs = mvhdOff >= 0 ? readU32BE(buf, buf[mvhdOff+8]===1 ? mvhdOff+20 : mvhdOff+12) : 1000;
			const ver = buf[tkhdOff+8];
			const dur = Math.round(durationMs * mvTs / 1000);
			if (ver === 1) { writeU32BE(buf, tkhdOff+24, 0); writeU32BE(buf, tkhdOff+28, dur); }
			else { writeU32BE(buf, tkhdOff+20, dur); }
		}
		// mdhd has its own timescale
		const mdiaOff = findBox(buf, "mdia", trakOff+8, trakEnd);
		if (mdiaOff >= 0) {
			patchDurBox(findBox(buf, "mdhd", mdiaOff+8, mdiaOff + readU32BE(buf, mdiaOff)));
		}
		trakOff = findBox(buf, "trak", trakEnd, moovEnd);
	}
}

function readVint(b: Uint8Array, off: number): { width: number; value: number } {
	const byte0 = b[off] ?? 0;
	let mask = 0x80, width = 1;
	while ((byte0 & mask) === 0 && width < 8) { mask >>= 1; width++; }
	let value = byte0 & (mask - 1);
	for (let i = 1; i < width; i++) value = (value << 8) | (b[off+i] ?? 0);
	return { width, value };
}

function patchWebMDuration(buf: Uint8Array, durationMs: number): void {
	// Scan for Segment Info element (0x1549A966) in first 8KB
	const limit = Math.min(buf.length, 8192);
	for (let i = 0; i < limit - 12; i++) {
		if (buf[i]===0x15 && buf[i+1]===0x49 && buf[i+2]===0xA9 && buf[i+3]===0x66) {
			const { width, value: infoSize } = readVint(buf, i+4);
			const body = i + 4 + width;
			const infoEnd = Math.min(body + infoSize, buf.length);
			// Scan Info body for Duration element (0x4489)
			for (let j = body; j < infoEnd - 4; j++) {
				if (buf[j] === 0x44 && buf[j+1] === 0x89) {
					const { width: sw, value: elemSz } = readVint(buf, j+2);
					const dataOff = j + 2 + sw;
					const dv = new DataView(buf.buffer, buf.byteOffset + dataOff, elemSz);
					if (elemSz >= 8) dv.setFloat64(0, durationMs, false);
					else if (elemSz >= 4) dv.setFloat32(0, durationMs, false);
					return;
				}
			}
			break;
		}
	}
}

function patchDuration(buf: Uint8Array, durationMs: number): void {
	if (durationMs <= 0 || buf.length < 8) return;
	// MP4 magic: bytes 4-7 = 'ftyp'
	if (buf[4]===0x66 && buf[5]===0x74 && buf[6]===0x79 && buf[7]===0x70) {
		patchMP4Duration(buf, durationMs);
	// WebM/MKV magic: 0x1A45DFA3
	} else if (buf[0]===0x1A && buf[1]===0x45 && buf[2]===0xDF && buf[3]===0xA3) {
		patchWebMDuration(buf, durationMs);
	}
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
	contentType = "video/webm",
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

	// Use the actual recorder MIME so S3/R2 serves the correct Content-Type.
	// Strip codec params (e.g. "video/mp4;codecs=h264" → "video/mp4") since
	// S3 Content-Type must not contain codec parameters.
	const baseContentType = contentType.split(";")[0].trim() || "video/webm";
	const { uploadId } = await api.initiateMultipart({
		contentType: baseContentType,
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

export async function finalizeUpload(durationMs = 0): Promise<void> {
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
	if (durationMs > 0 && remaining.length >= 8) patchDuration(remaining, durationMs);
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
