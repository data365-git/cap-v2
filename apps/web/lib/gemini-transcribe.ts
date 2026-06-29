/**
 * Error thrown when Gemini API quota is exceeded. This short-circuits the
 * retry/fallback loop — no retries or fallback to Pro model.
 */
export class QuotaExceededError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "QuotaExceededError";
	}
}

/**
 * fetch with a hard timeout via AbortController. Without this, a Gemini API
 * call can hang indefinitely (observed: chunk 3 of a 5-chunk transcription
 * hung silently for hours, leaving the video stuck in PROCESSING). Any
 * non-response within the timeout throws, which lets the existing markError
 * path surface a real failure so the user can retry.
 */
async function fetchWithTimeout(
	url: string,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = 30_000, ...rest } = init;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, { ...rest, signal: ctrl.signal });
	} catch (err) {
		if ((err as { name?: string })?.name === "AbortError") {
			throw new Error(
				`Gemini request timed out after ${Math.round(timeoutMs / 1000)}s: ${url.split("?")[0]}`,
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

const GEMINI_PRIMARY_MODEL =
	process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const GEMINI_FALLBACK_MODEL =
	process.env.GEMINI_FALLBACK_MODEL ?? "gemini-2.5-pro";
const GEMINI_MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES ?? "4");
const BACKOFF_BASE_MS = [2000, 5000, 12000, 30000];

function isQuotaExceededError(status: number, msg: string): boolean {
	if (status === 429 && msg.toLowerCase().includes("quota")) return true;
	const lower = msg.toLowerCase();
	return (
		lower.includes("exceeded your current quota") ||
		lower.includes("resource_exhausted") ||
		lower.includes("generate_content_free_tier") ||
		lower.includes("limit: 0")
	);
}

function isTransientGeminiError(status: number, msg: string): boolean {
	if (status === 429 || status === 503) return true;
	const lower = msg.toLowerCase();
	return lower.includes("high demand") || lower.includes("overloaded");
}

function backoffWithJitter(attempt: number): number {
	const base =
		BACKOFF_BASE_MS[Math.min(attempt, BACKOFF_BASE_MS.length - 1)] ?? 30000;
	return Math.round(Math.random() * base);
}

interface GenResponseData {
	candidates?: Array<{
		content: { parts: Array<{ text?: string }> };
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
	};
	error?: { message: string };
}

async function fetchGeminiWithRetry(
	apiKey: string,
	endpoint: string,
	init: RequestInit & { timeoutMs?: number },
	onAttempt?: (attempt: number, total: number, reason: "initial" | "retry" | "fallback") => void,
): Promise<GenResponseData> {
	const models = [GEMINI_PRIMARY_MODEL, GEMINI_FALLBACK_MODEL];
	let lastError: Error | null = null;

	for (const model of models) {
		const maxAttempts =
			model === GEMINI_PRIMARY_MODEL ? GEMINI_MAX_RETRIES + 1 : 1;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0) {
				const delay = backoffWithJitter(attempt - 1);
				console.log(
					`[gemini-transcribe] Retry ${attempt}/${GEMINI_MAX_RETRIES} for ${model} after ${delay}ms`,
				);
				await new Promise<void>((r) => setTimeout(r, delay));
			}

			// Notify caller of this attempt.
			if (onAttempt) {
				const isFallback = model !== GEMINI_PRIMARY_MODEL;
				const reason = isFallback ? "fallback" : attempt === 0 ? "initial" : "retry";
				onAttempt(attempt + 1, maxAttempts, reason);
			}

			const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:${endpoint}?key=${apiKey}`;

			let res: Response;
			try {
				res = await fetchWithTimeout(url, init);
			} catch (err) {
				const msg = (err as Error).message ?? "";
				console.warn(
					`[gemini-transcribe] Fetch error from ${model} (attempt ${attempt + 1}/${maxAttempts}): ${msg}`,
				);
				lastError = err as Error;
				continue;
			}

			const data = (await res.json()) as GenResponseData;

			if (res.ok) {
				if (model !== GEMINI_PRIMARY_MODEL) {
					console.log(
						`[gemini-transcribe] Fallback to ${model} succeeded`,
					);
				}
				return data;
			}

			const errorMsg = data.error?.message ?? String(res.status);

			// Check for quota errors BEFORE transient retry logic — quota errors
			// short-circuit immediately without retry or fallback.
			if (isQuotaExceededError(res.status, errorMsg)) {
				console.error(
					`[gemini-transcribe] Quota exceeded from ${model}: ${errorMsg}`,
				);
				throw new QuotaExceededError(`Gemini quota exceeded: ${errorMsg}`);
			}

			if (res.status === 401 || res.status === 403) {
				throw new Error(`Gemini auth error: ${errorMsg}`);
			}

			if (isTransientGeminiError(res.status, errorMsg)) {
				console.warn(
					`[gemini-transcribe] Transient error from ${model} (attempt ${attempt + 1}/${maxAttempts}): ${errorMsg}`,
				);
				lastError = new Error(
					`Gemini generateContent failed: ${errorMsg}`,
				);
				continue;
			}

			throw new Error(`Gemini generateContent failed: ${errorMsg}`);
		}

		if (models.indexOf(model) < models.length - 1) {
			console.log(
				`[gemini-transcribe] ${model} exhausted ${GEMINI_MAX_RETRIES} retries, falling back to next model`,
			);
		}
	}

	throw (
		lastError ??
		new Error("Gemini generateContent failed after all retries")
	);
}

export interface VttCue {
	index: number;
	startSec: number;
	endSec: number;
	text: string;
}

export interface GeminiTranscribeResult {
	transcriptVtt: string;
	cues: VttCue[];
	inputTokens: number;
	outputTokens: number;
	finishReason: string;
	isComplete: boolean;
	words?: Array<{
		word: string;
		start: number;
		end: number;
		language?: string;
	}>;
}

interface GeminiFileResponse {
	file: {
		name: string;
		uri: string;
		state: string;
	};
}

function detectMimeType(audioUrl: string): string {
	const url = audioUrl.split("?")[0] ?? audioUrl;
	if (url.endsWith(".mp4") || url.endsWith(".m4a")) return "audio/mp4";
	if (url.endsWith(".wav")) return "audio/wav";
	if (url.endsWith(".ogg")) return "audio/ogg";
	if (url.endsWith(".webm")) return "audio/webm";
	return "audio/mpeg";
}

function formatVttTimestamp(seconds: number): string {
	const safe = Math.max(0, seconds);
	const h = Math.floor(safe / 3600);
	const m = Math.floor((safe % 3600) / 60);
	const s = Math.floor(safe % 60);
	const ms = Math.round((safe % 1) * 1000);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function parseVttTimestamp(ts: string): number | null {
	// Accept HH:MM:SS.mmm or MM:SS.mmm
	const m1 = ts.match(/^(\d+):(\d{2}):(\d{2})[.,](\d{1,3})$/);
	if (m1) {
		const [, h, m, s, ms] = m1;
		return (
			Number(h) * 3600 +
			Number(m) * 60 +
			Number(s) +
			Number((ms ?? "0").padEnd(3, "0")) / 1000
		);
	}
	const m2 = ts.match(/^(\d+):(\d{2})[.,](\d{1,3})$/);
	if (m2) {
		const [, m, s, ms] = m2;
		return Number(m) * 60 + Number(s) + Number((ms ?? "0").padEnd(3, "0")) / 1000;
	}
	return null;
}

export function parseVttCues(vtt: string): VttCue[] {
	const cues: VttCue[] = [];
	const lines = vtt.split(/\r?\n/);
	let i = 0;
	let cueIndex = 0;

	// skip WEBVTT header
	while (i < lines.length && !lines[i]?.includes("-->")) i++;

	while (i < lines.length) {
		const line = lines[i] ?? "";
		const arrowMatch = line.match(
			/^\s*([\d:.,]+)\s*-->\s*([\d:.,]+)/,
		);
		if (!arrowMatch) {
			i++;
			continue;
		}
		const startSec = parseVttTimestamp(arrowMatch[1] ?? "");
		const endSec = parseVttTimestamp(arrowMatch[2] ?? "");
		if (startSec == null || endSec == null) {
			i++;
			continue;
		}
		i++;
		const textLines: string[] = [];
		while (i < lines.length && lines[i]?.trim() !== "") {
			textLines.push(lines[i] ?? "");
			i++;
		}
		cueIndex++;
		cues.push({
			index: cueIndex,
			startSec,
			endSec,
			text: textLines.join("\n"),
		});
		// skip blank lines
		while (i < lines.length && lines[i]?.trim() === "") i++;
	}

	return cues;
}

export function cuesToVtt(cues: VttCue[]): string {
	let out = "WEBVTT\n\n";
	cues.forEach((cue, idx) => {
		out += `${idx + 1}\n${formatVttTimestamp(cue.startSec)} --> ${formatVttTimestamp(cue.endSec)}\n${cue.text}\n\n`;
	});
	return out;
}

export function shiftCues(cues: VttCue[], offsetSec: number): VttCue[] {
	if (offsetSec === 0) return cues;
	return cues.map((cue) => ({
		...cue,
		startSec: cue.startSec + offsetSec,
		endSec: cue.endSec + offsetSec,
	}));
}

export function mergeVtt(
	perChunkResults: Array<{ cues: VttCue[]; startOffsetSec: number }>,
): { vtt: string; cues: VttCue[] } {
	const all: VttCue[] = [];
	for (const r of perChunkResults) {
		all.push(...shiftCues(r.cues, r.startOffsetSec));
	}
	all.sort((a, b) => a.startSec - b.startSec);
	return { vtt: cuesToVtt(all), cues: all };
}

function plainTextToWebVTT(text: string, durationSec: number): string {
	const sentences = text
		.split(/(?<=[.?!])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);

	if (sentences.length === 0) return "WEBVTT\n\n";

	const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
	let vtt = "WEBVTT\n\n";
	let elapsed = 0;
	let index = 1;

	for (const sentence of sentences) {
		const fraction =
			totalChars > 0 ? sentence.length / totalChars : 1 / sentences.length;
		const cueDuration = durationSec * fraction;
		const start = formatVttTimestamp(elapsed);
		const end = formatVttTimestamp(elapsed + cueDuration);
		vtt += `${index}\n${start} --> ${end}\n${sentence}\n\n`;
		elapsed += cueDuration;
		index++;
	}

	return vtt;
}

async function pollUntilActive(
	fileName: string,
	apiKey: string,
): Promise<void> {
	const maxAttempts = 30;
	for (let i = 0; i < maxAttempts; i++) {
		const res = await fetchWithTimeout(
			`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
			{ timeoutMs: 15_000 },
		);
		if (!res.ok) {
			throw new Error(`Gemini file poll failed: ${res.status}`);
		}
		const data = (await res.json()) as { state: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") {
			throw new Error("Gemini file processing failed");
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 2000));
	}
	throw new Error("Gemini file never reached ACTIVE state");
}

export interface TranscribeOptions {
	apiKey: string;
	audioDurationSec?: number;
	/** Local file path. If provided, audioInput is ignored. */
	audioPath?: string;
	/** Pre-loaded audio bytes (with explicit mimeType). */
	audioBytes?: Uint8Array;
	audioMimeType?: string;
	/**
	 * Seconds to add to every cue timestamp before returning. Used when this
	 * call is transcribing a slice of a longer recording.
	 */
	startOffsetSec?: number;
	/**
	 * Optional callback fired at the start of each Gemini attempt.
	 * `attempt` is 1-based; `total` is the max attempts for this model tier.
	 * `reason` is "initial" for the first try, "retry" for subsequent tries on
	 * the primary model, and "fallback" when switching to the fallback model.
	 */
	onAttempt?: (attempt: number, total: number, reason: "initial" | "retry" | "fallback") => void;
}

async function readAudio(
	audioInput: string,
	options: TranscribeOptions,
): Promise<{ bytes: Uint8Array; mimeType: string }> {
	if (options.audioBytes && options.audioMimeType) {
		return { bytes: options.audioBytes, mimeType: options.audioMimeType };
	}
	if (options.audioPath) {
		const { promises: fs } = await import("node:fs");
		const buf = await fs.readFile(options.audioPath);
		return {
			bytes: new Uint8Array(buf),
			mimeType: detectMimeType(options.audioPath),
		};
	}
	const audioResponse = await fetch(audioInput);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}
	const audioBuffer = await audioResponse.arrayBuffer();
	return {
		bytes: new Uint8Array(audioBuffer),
		mimeType: detectMimeType(audioInput),
	};
}

/**
 * Upload audio from a URL to Gemini's Files API without buffering the entire
 * file in memory. Returns { fileUri, fileName } on success, or null if the
 * Content-Length header is missing (caller falls back to buffer upload).
 *
 * Strategy: HEAD the URL to get Content-Length, then open a streaming GET and
 * pipe the response body directly into the resumable upload PUT. Node.js fetch
 * accepts a ReadableStream as the request body, so we never hold the full file
 * in memory.
 */
async function uploadAudioUrlStreaming(
	audioUrl: string,
	apiKey: string,
): Promise<{ fileUri: string; fileName: string; state: string } | null> {
	// HEAD request to get content length without downloading the body.
	const headRes = await fetch(audioUrl, { method: "HEAD" });
	const contentLength = headRes.headers.get("content-length");
	if (!contentLength || Number(contentLength) <= 0) {
		// No content-length — can't do resumable upload without knowing the size.
		return null;
	}
	const byteLength = Number(contentLength);
	const mimeType = detectMimeType(audioUrl);
	const displayName = `cap-audio-${Date.now()}`;

	// Start the resumable upload session.
	const initRes = await fetchWithTimeout(
		`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
		{
			method: "POST",
			headers: {
				"X-Goog-Upload-Protocol": "resumable",
				"X-Goog-Upload-Command": "start",
				"X-Goog-Upload-Header-Content-Length": String(byteLength),
				"X-Goog-Upload-Header-Content-Type": mimeType,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ file: { display_name: displayName } }),
			timeoutMs: 30_000,
		},
	);

	if (!initRes.ok) {
		throw new Error(`Gemini upload init failed: ${initRes.status}`);
	}

	const uploadUrl = initRes.headers.get("x-goog-upload-url");
	if (!uploadUrl) {
		throw new Error("No upload URL from Gemini Files API");
	}

	// Stream the audio directly from the source URL into the upload PUT.
	const audioRes = await fetch(audioUrl);
	if (!audioRes.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioRes.status} ${audioRes.statusText}`,
		);
	}
	if (!audioRes.body) {
		// Fallback: let caller handle buffered upload.
		return null;
	}

	const uploadRes = await fetchWithTimeout(uploadUrl, {
		method: "PUT",
		headers: {
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
			"Content-Length": String(byteLength),
			"Content-Type": mimeType,
		},
		// Pass the ReadableStream directly — no full-file buffer in Node.js.
		body: audioRes.body,
		// Large file at typical upload speeds; 10 min ceiling.
		timeoutMs: 10 * 60_000,
	} as RequestInit & { timeoutMs?: number });

	if (!uploadRes.ok) {
		throw new Error(`Gemini audio upload failed: ${uploadRes.status}`);
	}

	const fileData = (await uploadRes.json()) as GeminiFileResponse;
	const { name: fileName, uri: fileUri, state } = fileData.file;
	if (!fileUri || !fileName) {
		throw new Error(
			`Gemini upload response missing file info: ${JSON.stringify(fileData)}`,
		);
	}
	return { fileUri, fileName, state };
}

/** Upload a pre-loaded audio buffer to Gemini's Files API using resumable upload. */
async function uploadAudioBuffer(
	audioBytes: Uint8Array,
	mimeType: string,
	apiKey: string,
): Promise<{ fileUri: string; fileName: string; state: string }> {
	const displayName = `cap-audio-${Date.now()}`;

	const initRes = await fetchWithTimeout(
		`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
		{
			method: "POST",
			headers: {
				"X-Goog-Upload-Protocol": "resumable",
				"X-Goog-Upload-Command": "start",
				"X-Goog-Upload-Header-Content-Length": String(audioBytes.byteLength),
				"X-Goog-Upload-Header-Content-Type": mimeType,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ file: { display_name: displayName } }),
			timeoutMs: 30_000,
		},
	);

	if (!initRes.ok) {
		throw new Error(`Gemini upload init failed: ${initRes.status}`);
	}

	const uploadUrl = initRes.headers.get("x-goog-upload-url");
	if (!uploadUrl) {
		throw new Error("No upload URL from Gemini Files API");
	}

	const uploadRes = await fetchWithTimeout(uploadUrl, {
		method: "PUT",
		headers: {
			"X-Goog-Upload-Offset": "0",
			"X-Goog-Upload-Command": "upload, finalize",
			"Content-Length": String(audioBytes.byteLength),
		},
		body: audioBytes,
		timeoutMs: 120_000,
	});

	if (!uploadRes.ok) {
		throw new Error(`Gemini audio upload failed: ${uploadRes.status}`);
	}

	const fileData = (await uploadRes.json()) as GeminiFileResponse;
	const { name: fileName, uri: fileUri, state } = fileData.file;
	if (!fileUri || !fileName) {
		throw new Error(
			`Gemini upload response missing file info: ${JSON.stringify(fileData)}`,
		);
	}
	return { fileUri, fileName, state };
}

export async function transcribeWithGemini(
	audioUrl: string,
	options: TranscribeOptions,
): Promise<GeminiTranscribeResult> {
	const { apiKey, audioDurationSec = 300, startOffsetSec = 0 } = options;

	// When the caller provides a URL (no audioPath, no audioBytes), attempt a
	// streaming upload so we never hold the full file in Node.js memory.
	const isUrlOnlyPath = !options.audioPath && !options.audioBytes;
	let fileUri: string;
	let fileName: string;
	let mimeType: string;
	let uploadedState: string;

	if (isUrlOnlyPath) {
		mimeType = detectMimeType(audioUrl);
		const streamed = await uploadAudioUrlStreaming(audioUrl, apiKey);
		if (streamed) {
			fileUri = streamed.fileUri;
			fileName = streamed.fileName;
			uploadedState = streamed.state;
			console.info(
				`[gemini-transcribe] Streaming upload complete: ${fileName}`,
			);
		} else {
			// Fallback: HEAD had no Content-Length — buffer the file (small files,
			// unusual servers). Log a warning so it's visible.
			console.warn(
				"[gemini-transcribe] No Content-Length from audio URL — falling back to buffered upload",
			);
			const { bytes: audioBytes } = await readAudio(audioUrl, options);
			const uploadResult = await uploadAudioBuffer(audioBytes, mimeType, apiKey);
			fileUri = uploadResult.fileUri;
			fileName = uploadResult.fileName;
			uploadedState = uploadResult.state;
		}
	} else {
		const audio = await readAudio(audioUrl, options);
		mimeType = audio.mimeType;
		const uploadResult = await uploadAudioBuffer(audio.bytes, mimeType, apiKey);
		fileUri = uploadResult.fileUri;
		fileName = uploadResult.fileName;
		uploadedState = uploadResult.state;
	}

	if (uploadedState !== "ACTIVE") {
		await pollUntilActive(fileName, apiKey);
	}

	const genData = await fetchGeminiWithRetry(
		apiKey,
		"generateContent",
		{
			timeoutMs: 8 * 60_000,
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{
								fileData: {
									mimeType,
									fileUri,
								},
							},
							{
								text: `You are a professional Uzbek meeting transcription editor.

Transcribe the attached online/offline meeting fully and accurately in Uzbek Latin.

Rules:

1. Transcribe the entire meeting from beginning to end. Do not summarize, skip, shorten, or stop halfway.

2. Uzbek words must be written only in Uzbek Latin. Do not write Uzbek words in Cyrillic.

3. This meeting has multiple speakers. Identify speakers by voice, context, and conversation flow.

If speaker names are known from the audio, use their names.

If names are not clear, use:
Speaker 1
Speaker 2
Speaker 3

Keep speaker labels consistent across the whole transcript.

Each WEBVTT cue must contain EXACTLY ONE speaker. Begin each cue's text with a WebVTT voice tag: <v Speaker Name> followed by that speaker's words. NEVER merge two speakers into a single cue. Example of correct format:

00:00:12.500 --> 00:00:15.200
<v Bunyodbek>Salom, qanday yangiliklar bor?

00:00:15.500 --> 00:00:18.100
<v Jahongir>Yangi mijoz keldi, **deadline** ertaga.

If two people talk over each other and both cannot be clearly separated, split into two adjacent cues with the same or overlapping timestamps and add the [ustma-ust gaplashildi] tag on the second cue.

4. Add real, accurate timestamps from the audio. Do not use sample, fake, guessed, or template timestamps.

Put timestamps only where they exactly match the audio:
- at the beginning,
- when the speaker changes,
- when a new discussion topic starts,
- when decisions, tasks, objections, or important points appear,
- when there is a meaningful pause or transition.

Timestamp format:
**[HH:MM:SS]**

5. Clean the transcript professionally:
- remove filler sounds like "umm", "aa", "eee", "э"
- remove repeated stutters
- remove meaningless false starts
- keep the original meaning and speaking style

6. If an Uzbek word is unclear, correct it based on surrounding context. If it is impossible to identify, write [noaniq].

7. Keep foreign words exactly as spoken:
- Russian words must stay in Cyrillic and be bold: **сразу**, **любой**, **дефицит**
- English words must stay in English/Latin and be bold: **deadline**, **CRM**, **dashboard**
- Do not translate foreign words.
- Do not transliterate Russian words into Latin.
- Bold every foreign word or phrase.

8. Output only the transcript. No intro, no explanation, no table, no numbering.

IMPORTANT: Start your response with "WEBVTT" header and format each line as WebVTT cues with timestamps in HH:MM:SS.mmm --> HH:MM:SS.mmm format. The speaker labels, bold formatting, and content rules above still apply within each cue text.`,
							},
						],
					},
				],
				generationConfig: {
					temperature: 0.1,
					maxOutputTokens: 65536,
				},
			}),
		},
		options.onAttempt,
	);

	const rawText = genData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	const finishReason = genData.candidates?.[0]?.finishReason ?? "UNKNOWN";
	const isComplete = finishReason !== "MAX_TOKENS";
	const inputTokens = genData.usageMetadata?.promptTokenCount ?? 0;
	const outputTokens = genData.usageMetadata?.candidatesTokenCount ?? 0;

	fetch(
		`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
		{ method: "DELETE" },
	).catch(() => {});

	const baseVtt = rawText.trimStart().startsWith("WEBVTT")
		? rawText.trimStart()
		: plainTextToWebVTT(rawText, audioDurationSec);

	const parsedCues = parseVttCues(baseVtt);
	const shifted = shiftCues(parsedCues, startOffsetSec);
	const transcriptVtt =
		startOffsetSec === 0 ? baseVtt : cuesToVtt(shifted);

	return {
		transcriptVtt,
		cues: shifted,
		inputTokens,
		outputTokens,
		finishReason,
		isComplete,
	};
}
