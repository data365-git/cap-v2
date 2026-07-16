import {
	buildTranscriptionPrompt,
	GEMINI_PRIMARY_MODEL,
	TRANSCRIBE_MAX_OUTPUT_TOKENS,
	transcriptRawTextToCues,
	type VttCue,
} from "@/lib/gemini-transcribe";

// Durable Gemini Batch API submit/collect for the opt-in cheap transcription
// mode. The Batch tier is roughly half the price of synchronous generateContent
// but runs asynchronously (minutes → hours), which is exactly the cost/latency
// trade-off `aiSpeedMode: "cheap"` promises. The workflow SUBMITS one uncovered
// chunk and parks; the poll-batch-jobs cron COLLECTS later. Pure helpers live at
// the top (no network) so their branch logic is unit-testable in isolation.

// The Batch endpoint keys off the model in the URL; keep it aligned with the
// synchronous primary so cheap and fast transcribe with the same model.
const BATCH_TRANSCRIBE_MODEL = GEMINI_PRIMARY_MODEL;

const GL_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Terminal batch states. The live API returns BATCH_STATE_* (spike-verified);
// anything else (PENDING/RUNNING/unknown) is still-pending → keep polling.
export const TERMINAL_BATCH_STATES = [
	"BATCH_STATE_SUCCEEDED",
	"BATCH_STATE_FAILED",
	"BATCH_STATE_CANCELLED",
	"BATCH_STATE_EXPIRED",
] as const;

export type BatchStateClass = "succeeded" | "failed" | "pending";

/** Overall timeout budget for the pure `shouldFallbackToSync` decision. */
export const BATCH_TIMEOUT_MS = 30 * 60_000; // 30 min

// ─── Pure helpers (network-free — unit tested) ────────────────────────────────

/**
 * Classify a raw batch state string.
 *   SUCCEEDED                → "succeeded"
 *   FAILED/CANCELLED/EXPIRED → "failed" (terminal but no usable output)
 *   anything else            → "pending" (keep polling)
 * Case/format tolerant: matches on the trailing token so both
 * "BATCH_STATE_SUCCEEDED" and a bare "SUCCEEDED" resolve the same.
 */
export function mapBatchState(
	state: string | undefined | null,
): BatchStateClass {
	const s = (state ?? "").toUpperCase();
	if (s.includes("SUCCEEDED")) return "succeeded";
	if (
		s.includes("FAILED") ||
		s.includes("CANCELLED") ||
		s.includes("EXPIRED")
	) {
		return "failed";
	}
	return "pending";
}

export function isTerminalBatchState(
	state: string | undefined | null,
): boolean {
	return mapBatchState(state) !== "pending";
}

/**
 * Decide whether a not-yet-terminal batch has exceeded its timeout budget and
 * should be abandoned in favour of the synchronous path. Pure (takes elapsed +
 * state, no clock/network) so the fallback decision is unit-testable.
 */
export function shouldFallbackToSync({
	state,
	elapsedMs,
	timeoutMs = BATCH_TIMEOUT_MS,
}: {
	state: string | undefined | null;
	elapsedMs: number;
	timeoutMs?: number;
}): boolean {
	if (isTerminalBatchState(state)) return false;
	return elapsedMs >= timeoutMs;
}

type InlinedResponse = {
	response?: unknown;
	error?: { message?: string; code?: number | string } | null;
};

/**
 * Tolerantly pull the first inlined per-request result out of a completed batch
 * metadata blob. Google has shipped several nesting shapes
 * (`response.inlinedResponses[0]`, a doubled `inlinedResponses.inlinedResponses`,
 * or under `output`/`dest`); try every known shape and return the first entry
 * (which carries either `.response` with candidates or `.error`).
 */
export function extractInlinedResponse(
	batch: unknown,
): InlinedResponse | undefined {
	const readArray = (node: unknown): unknown[] | undefined => {
		if (Array.isArray(node)) return node;
		if (node && typeof node === "object") {
			const inner = (node as { inlinedResponses?: unknown }).inlinedResponses;
			if (Array.isArray(inner)) return inner;
		}
		return undefined;
	};

	const b = (batch ?? {}) as Record<string, unknown>;
	const containers: unknown[] = [
		(b.response as { inlinedResponses?: unknown })?.inlinedResponses,
		b.response,
		(b.output as { inlinedResponses?: unknown })?.inlinedResponses,
		b.output,
		(b.dest as { inlinedResponses?: unknown })?.inlinedResponses,
		b.inlinedResponses,
		b,
	];

	for (const c of containers) {
		const arr = readArray(c);
		if (arr && arr.length > 0) {
			return arr[0] as InlinedResponse;
		}
	}
	return undefined;
}

type GenCandidateData = {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
	};
};

export interface UnwrappedBatchResult {
	rawText: string;
	inputTokens: number;
	outputTokens: number;
	audioInTokens: number;
	finishReason?: string;
}

/**
 * Turn a completed batch metadata blob into the same token/text fields the sync
 * path produces. Throws when the single inlined request carried an error or no
 * candidate text (routes into the SAME failure path as a sync failure).
 */
export function unwrapBatchResponse(batch: unknown): UnwrappedBatchResult {
	const inlined = extractInlinedResponse(batch);
	if (!inlined) {
		throw new Error("Batch response missing inlinedResponses");
	}
	if (inlined.error) {
		const msg =
			inlined.error.message ?? `code ${inlined.error.code ?? "unknown"}`;
		throw new Error(`Batch inline request error: ${msg}`);
	}

	const gen = (inlined.response ?? {}) as GenCandidateData;
	const rawText = gen.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	const inputTokens = gen.usageMetadata?.promptTokenCount ?? 0;
	const outputTokens = gen.usageMetadata?.candidatesTokenCount ?? 0;
	const rawAudioInTokens =
		gen.usageMetadata?.promptTokensDetails?.find((d) => d.modality === "AUDIO")
			?.tokenCount ?? 0;
	// Transcription input is essentially all audio. When the response omits the
	// AUDIO detail, bill the whole input at the (higher) audio rate rather than
	// silently under-reporting.
	const audioInTokens =
		rawAudioInTokens === 0 && inputTokens > 0 ? inputTokens : rawAudioInTokens;
	const finishReason = gen.candidates?.[0]?.finishReason;

	if (rawText.trim().length === 0) {
		throw new Error(
			`Batch response empty transcript (finishReason=${finishReason})`,
		);
	}

	return { rawText, inputTokens, outputTokens, audioInTokens, finishReason };
}

/**
 * Build the batch create body: the SAME transcription prompt + generationConfig
 * as the synchronous call, wrapped in the batch `input_config.requests.requests`
 * envelope. Pure so the request shape is asserted in tests.
 */
export function buildBatchRequestBody(params: {
	mimeType: string;
	fileUri: string;
	displayName: string;
}): Record<string, unknown> {
	const request = {
		contents: [
			{
				parts: [
					{ fileData: { mimeType: params.mimeType, fileUri: params.fileUri } },
					{ text: buildTranscriptionPrompt() },
				],
			},
		],
		generationConfig: {
			temperature: 0.1,
			maxOutputTokens: TRANSCRIBE_MAX_OUTPUT_TOKENS,
			thinkingConfig: { thinkingBudget: 0 },
		},
	};

	return {
		batch: {
			display_name: params.displayName,
			input_config: { requests: { requests: [{ request }] } },
		},
	};
}

// ─── Network ──────────────────────────────────────────────────────────────────

interface UploadedFile {
	fileName: string;
	fileUri: string;
	mimeType: string;
}

function detectMimeType(source: string): string {
	const url = source.split("?")[0] ?? source;
	if (url.endsWith(".mp4") || url.endsWith(".m4a")) return "audio/mp4";
	if (url.endsWith(".wav")) return "audio/wav";
	if (url.endsWith(".ogg")) return "audio/ogg";
	if (url.endsWith(".webm")) return "audio/webm";
	return "audio/mpeg";
}

async function readAudioBytes(source: {
	audioPath?: string;
	audioUrl?: string;
}): Promise<{ bytes: Uint8Array; mimeType: string }> {
	if (source.audioPath) {
		const { promises: fs } = await import("node:fs");
		const buf = await fs.readFile(source.audioPath);
		return {
			bytes: new Uint8Array(buf),
			mimeType: detectMimeType(source.audioPath),
		};
	}
	if (source.audioUrl) {
		const res = await fetch(source.audioUrl);
		if (!res.ok) {
			throw new Error(
				`Audio not accessible for batch: ${res.status} ${res.statusText}`,
			);
		}
		return {
			bytes: new Uint8Array(await res.arrayBuffer()),
			mimeType: detectMimeType(source.audioUrl),
		};
	}
	throw new Error("submitChunkBatch: neither audioPath nor audioUrl provided");
}

async function pollFileUntilActive(
	fileName: string,
	apiKey: string,
): Promise<void> {
	for (let i = 0; i < 30; i++) {
		const res = await fetch(`${GL_BASE}/${fileName}?key=${apiKey}`);
		if (!res.ok) throw new Error(`Gemini file poll failed: ${res.status}`);
		const data = (await res.json()) as { state?: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED")
			throw new Error("Gemini file processing failed");
		await new Promise<void>((r) => setTimeout(r, 2000));
	}
	throw new Error("Gemini file never reached ACTIVE state");
}

async function uploadAudioForBatch(
	source: { audioPath?: string; audioUrl?: string },
	apiKey: string,
): Promise<UploadedFile> {
	const { bytes, mimeType } = await readAudioBytes(source);
	const displayName = `cap-batch-audio-${Date.now()}`;

	const initRes = await fetch(
		`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
		{
			method: "POST",
			headers: {
				"X-Goog-Upload-Protocol": "resumable",
				"X-Goog-Upload-Command": "start",
				"X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
				"X-Goog-Upload-Header-Content-Type": mimeType,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ file: { display_name: displayName } }),
		},
	);
	if (!initRes.ok) {
		throw new Error(`Gemini upload init failed (HTTP ${initRes.status})`);
	}
	const uploadUrl = initRes.headers.get("x-goog-upload-url");
	if (!uploadUrl) throw new Error("No upload URL from Gemini Files API");

	const uploadRes = await fetch(uploadUrl, {
		method: "PUT",
		headers: {
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
			"Content-Length": String(bytes.byteLength),
		},
		body: bytes,
	});
	if (!uploadRes.ok) {
		throw new Error(`Gemini audio upload failed (HTTP ${uploadRes.status})`);
	}
	const fileData = (await uploadRes.json()) as {
		file: { name: string; uri: string; state: string };
	};
	const { name: fileName, uri: fileUri, state } = fileData.file;
	if (!fileUri || !fileName) {
		throw new Error(
			`Gemini upload response missing file info: ${JSON.stringify(fileData)}`,
		);
	}
	if (state !== "ACTIVE") {
		await pollFileUntilActive(fileName, apiKey);
	}
	return { fileName, fileUri, mimeType };
}

function extractBatchName(created: unknown): string | undefined {
	const c = (created ?? {}) as Record<string, unknown>;
	if (typeof c.name === "string" && c.name) return c.name;
	const meta = c.metadata as { name?: unknown } | undefined;
	if (meta && typeof meta.name === "string" && meta.name) return meta.name;
	return undefined;
}

function extractBatchState(polled: unknown): string | undefined {
	const p = (polled ?? {}) as Record<string, unknown>;
	if (typeof p.state === "string") return p.state;
	const meta = p.metadata as { state?: unknown } | undefined;
	if (meta && typeof meta.state === "string") return meta.state;
	return undefined;
}

async function submitBatch(
	body: Record<string, unknown>,
	apiKey: string,
): Promise<string> {
	const res = await fetch(
		`${GL_BASE}/models/${BATCH_TRANSCRIBE_MODEL}:batchGenerateContent?key=${apiKey}`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
	);
	const data = (await res.json()) as unknown;
	if (!res.ok) {
		const msg =
			(data as { error?: { message?: string } })?.error?.message ??
			String(res.status);
		throw new Error(`Batch submit failed (HTTP ${res.status}): ${msg}`);
	}
	const name = extractBatchName(data);
	if (!name) {
		throw new Error(
			`Batch create response missing name: ${JSON.stringify(data).slice(0, 300)}`,
		);
	}
	return name;
}

async function getBatch(batchName: string, apiKey: string): Promise<unknown> {
	const res = await fetch(`${GL_BASE}/${batchName}?key=${apiKey}`);
	const data = (await res.json()) as unknown;
	if (!res.ok) {
		const msg =
			(data as { error?: { message?: string } })?.error?.message ??
			String(res.status);
		throw new Error(`Batch poll failed (HTTP ${res.status}): ${msg}`);
	}
	return data;
}

/** Best-effort cancel — never throws. Used by the paid takeover and the
 * "no longer cheap" cron branch to stop a still-running Batch we will abandon. */
export async function cancelBatch(
	batchName: string,
	apiKey: string,
): Promise<void> {
	await fetch(`${GL_BASE}/${batchName}:cancel?key=${apiKey}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	}).catch(() => {});
}

/** Best-effort delete of an uploaded Files API input object — never throws. */
export async function deleteBatchFile(
	fileName: string,
	apiKey: string,
): Promise<void> {
	await fetch(`${GL_BASE}/${fileName}?key=${apiKey}`, {
		method: "DELETE",
	}).catch(() => {});
}

// ─── Durable submit / collect (cron-driven; NO in-process poll) ─────────────────

export interface SubmittedBatchChunk {
	batchName: string;
	/** Files API object name — kept alive until collect; the caller stores it so
	 * the collector can delete it after the result is retrieved. */
	fileName: string;
}

/**
 * Upload one chunk (local slice file or remote URL) + submit it to the Batch API
 * and return immediately. Does NOT poll and does NOT delete the uploaded file
 * (the collector deletes it). On a submit failure after a successful upload, the
 * orphaned Files API object is best-effort deleted before rethrowing.
 */
export async function submitChunkBatch(
	source: { audioPath?: string; audioUrl?: string },
	options: { apiKey: string; videoId?: string },
): Promise<SubmittedBatchChunk> {
	const { apiKey, videoId } = options;
	const uploaded = await uploadAudioForBatch(source, apiKey);
	const body = buildBatchRequestBody({
		mimeType: uploaded.mimeType,
		fileUri: uploaded.fileUri,
		displayName: `cap-batch-${videoId ?? "chunk"}-${Date.now()}`,
	});
	let batchName: string;
	try {
		batchName = await submitBatch(body, apiKey);
	} catch (error) {
		await deleteBatchFile(uploaded.fileName, apiKey);
		throw error;
	}
	console.log(
		`[gemini-batch] durable submit ${batchName} for video=${videoId ?? "?"}`,
	);
	return { batchName, fileName: uploaded.fileName };
}

export type CollectBatchResult =
	| {
			status: "succeeded";
			/** Cleaned, clamped, script-restored cues shifted to ABSOLUTE time. */
			cues: VttCue[];
			/** VTT of the above cues — stored directly into completedChunks[chunkIndex]. */
			chunkVtt: string;
			inputTokens: number;
			outputTokens: number;
			audioInTokens: number;
	  }
	| { status: "pending" }
	| { status: "failed"; reason: string };

/**
 * Poll a submitted batch ONCE. On success: unwrap → run the SAME raw-text→cues
 * conversion the sync path uses (shifted to absolute time via startOffsetSec) →
 * delete the uploaded file. On terminal failure / inline error / empty output:
 * delete the file and report "failed" (the chunk is re-done on the next kick).
 * Still running → "pending". Poll network errors throw so the cron logs + retries.
 */
export async function collectBatchResult(
	batchName: string,
	options: {
		apiKey: string;
		fileName?: string;
		audioDurationSec?: number;
		startOffsetSec?: number;
	},
): Promise<CollectBatchResult> {
	const {
		apiKey,
		fileName,
		audioDurationSec = 300,
		startOffsetSec = 0,
	} = options;
	const polled = await getBatch(batchName, apiKey);
	const cls = mapBatchState(extractBatchState(polled));

	if (cls === "pending") return { status: "pending" };

	if (cls === "failed") {
		if (fileName) await deleteBatchFile(fileName, apiKey);
		return { status: "failed", reason: `terminal state for ${batchName}` };
	}

	try {
		const unwrapped = unwrapBatchResponse(polled);
		const { cues, transcriptVtt } = transcriptRawTextToCues(
			unwrapped.rawText,
			audioDurationSec,
			startOffsetSec,
		);
		if (fileName) await deleteBatchFile(fileName, apiKey);
		return {
			status: "succeeded",
			cues,
			chunkVtt: transcriptVtt,
			inputTokens: unwrapped.inputTokens,
			outputTokens: unwrapped.outputTokens,
			audioInTokens: unwrapped.audioInTokens,
		};
	} catch (error) {
		if (fileName) await deleteBatchFile(fileName, apiKey);
		return {
			status: "failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
