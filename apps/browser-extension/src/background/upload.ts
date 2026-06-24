import { createCapApi } from "./api";
import type { ExtensionSettings } from "./state";
import { getSettings, getState, setState } from "./state";

const RETRY_QUEUE_KEY = "capExtRetryQueue";
const DEAD_LETTER_KEY = "capExtDeadLetterQueue";
const MAX_ATTEMPTS = 6;

const BACKOFF_SECONDS = [1, 4, 16, 64, 256];

interface RetryItem {
	kind: "part" | "complete" | "recording-complete" | "signed-put";
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

// Store under a key reflecting the REAL container so the stored object, the
// presigned PUT's signed Content-Type, and the playlist lookup all agree.
function resultSubpath(mime: string): string {
	const base = (mime || "").split(";")[0].trim().toLowerCase();
	return base.includes("webm") ? "result.webm" : "result.mp4";
}

// Must match the Content-Type the server signs the presigned PUT with, which it
// derives from the key extension (signed.ts): .webm → video/webm, else video/mp4.
// Sending a different Content-Type than was signed → R2 SignatureDoesNotMatch (403).
function contentTypeForSubpath(subpath: string): string {
	return subpath.endsWith(".webm") ? "video/webm" : "video/mp4";
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

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

export async function initializeUpload(
	mode: "instruction" | "meeting",
	meetingId?: string,
	_contentType = "video/webm",
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

	// Single-PUT upload: we do NOT create a multipart upload at recording start.
	// MV3 service workers can be killed between start and stop, which invalidated
	// the multipart upload (NoSuchUpload on the part PUT → ~half of uploads lost
	// zero bytes). Instead we buffer the whole recording and do one presigned PUT
	// at stop (see finalizeUpload). uploadId is unused; kept for state shape.
	inMemoryBuffer = new Uint8Array(0);

	return { videoId, uploadId: "" };
}

export async function handleChunk(
	chunk: ArrayBuffer,
	_index: number,
	_mime: string,
): Promise<void> {
	const state = await getState();
	if (state.kind !== "recording") return;

	// Single-PUT model: accumulate the whole recording in memory; the full object
	// is uploaded once at stop. (No per-chunk part uploads.)
	const data = new Uint8Array(chunk);
	appendToBuffer(data);
	await setState({ ...state, totalBytes: state.totalBytes + data.length });
}

// Upload the whole recording with one presigned PUT to ${ownerId}/${videoId}/
// <subpath> (the exact key the playlist route reads). Retries transiently while
// the bytes are still in memory. Returns { ok, detail } so the caller can surface
// the exact failure (status + body) instead of failing silently.
async function putRecording(
	api: ReturnType<typeof createCapApi>,
	videoId: string,
	bytes: Uint8Array,
	durationInSecs: number | undefined,
	subpath: string,
): Promise<{ ok: boolean; detail?: string }> {
	// Match the Content-Type the server signed the PUT with (derived from the key
	// extension). Sending anything else → SignatureDoesNotMatch (403).
	const contentType = contentTypeForSubpath(subpath);
	let detail = "";
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			const { url, headers } = await api.signedPut({
				videoId,
				subpath,
				durationInSecs,
			});
			const res = await fetch(url, {
				method: "PUT",
				body: bytes,
				// Default to the derived Content-Type; let any server-provided header
				// (the value it actually signed) win to stay byte-identical.
				headers: { "Content-Type": contentType, ...headers },
			});
			console.log(
				`[upload] signed PUT ${subpath} → ${res.status} (${bytes.length} bytes, ${contentType})`,
			);
			if (res.ok) return { ok: true };
			const text = await res.text().catch(() => "");
			detail = `PUT ${res.status}: ${text.slice(0, 300)}`;
			console.error(`[upload] signed PUT failed — ${detail}`);
		} catch (err) {
			detail = err instanceof Error ? err.message : String(err);
			console.error("[upload] signed PUT attempt error:", detail);
		}
		if (attempt < 2) await sleep((BACKOFF_SECONDS[attempt] ?? 4) * 1000);
	}
	return { ok: false, detail };
}

export async function finalizeUpload(durationMs = 0): Promise<void> {
	const state = await getState();
	if (state.kind !== "recording" && state.kind !== "uploading") return;

	const settings = await requireSettings();
	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);

	const totalBytes = state.totalBytes;
	const uploadedBytes =
		"uploadedBytes" in state ? (state.uploadedBytes as number) : 0;
	const { videoId } = state;

	// Pick the key/format from the real recorder MIME so the stored key, the
	// signed Content-Type, and the playlist lookup all agree.
	const mime = state.kind === "recording" ? state.mime : "video/mp4";
	const subpath = resultSubpath(mime);

	// Real measured recording length → stored server-side as videos.duration so the
	// player shows the true duration even if the container header is unreliable.
	const durationInSecs = durationMs > 0 ? durationMs / 1000 : undefined;

	if (state.kind === "recording") {
		await setState({
			kind: "uploading",
			videoId,
			uploadId: "",
			parts: [],
			totalBytes,
			uploadedBytes,
		});
	}

	// Single presigned PUT of the whole recording (multipart was dropped — see
	// initializeUpload). patchDuration repairs the in-memory duration header first.
	const remaining = drainBuffer();
	if (durationMs > 0 && remaining.length >= 8) patchDuration(remaining, durationMs);

	if (remaining.length === 0) {
		console.error(`[upload] No recording data captured. totalBytes=${totalBytes}`);
		await setState({
			kind: "error",
			reason:
				"No recording data was captured. Check screen-capture permissions and try again.",
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	const uploaded = await putRecording(
		api,
		videoId,
		remaining,
		durationInSecs,
		subpath,
	);
	if (!uploaded.ok) {
		// Bytes only live in memory, so a queued retry can't re-upload them — record
		// it for visibility and surface the EXACT failure so it's never silent.
		await addToRetryQueue({ kind: "signed-put", payload: { videoId } });
		await setState({
			kind: "error",
			reason: `Upload failed (${remaining.length} bytes captured): ${uploaded.detail ?? "the PUT did not complete"}. Check network and try again.`,
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	await setState({ kind: "finishing", videoId });

	try {
		await api.recordingComplete({ videoId });
	} catch (err) {
		console.error("[upload] recordingComplete failed:", err);
		await addToRetryQueue({ kind: "recording-complete", payload: { videoId } });
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
			if (item.kind === "recording-complete") {
				const { videoId } = item.payload as { videoId: string };
				await api.recordingComplete({ videoId });
			} else {
				// "signed-put" (and legacy "part"/"complete"): the recording bytes are
				// no longer in memory, so the object upload can't be retried here.
				// Surface it as a failed upload rather than silently looping.
				await moveToDeadLetter(item);
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
