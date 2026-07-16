import { promises as fs } from "node:fs";
import path from "node:path";
import { serverEnv } from "@cap/env";

export interface ScribeAudioChunk {
	filePath?: string;
	buffer?: Buffer | Uint8Array | ArrayBuffer;
	url?: string;
	startSec: number;
}

export interface ScribeWord {
	word: string;
	start: number;
	end: number;
}

interface ElevenScribeWord {
	text?: string;
	word?: string;
	start?: number;
	end?: number;
	type?: string | null;
}

interface ElevenScribeResponse {
	words?: ElevenScribeWord[];
}

const SCRIBE_ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
const MAX_SCRIBE_RETRIES = 3;

/**
 * Send audio chunks to ElevenLabs Scribe and return a flat, absolute-time list
 * of word timings. Every call is gated on ELEVENLABS_API_KEY — the feature is
 * dormant (throws "Missing ELEVENLABS_API_KEY", handled by callers) until a key
 * is configured, so nothing changes for existing deployments.
 */
export async function fetchScribeWordTimes(
	chunks: readonly ScribeAudioChunk[],
): Promise<ScribeWord[]> {
	const apiKey = serverEnv().ELEVENLABS_API_KEY;
	if (!apiKey) throw new Error("Missing ELEVENLABS_API_KEY");

	const allWords: ScribeWord[] = [];

	for (const chunk of chunks) {
		const json = await transcribeChunk(chunk, apiKey);
		const words = (json.words ?? []).filter(
			(word) => word.type === "word" || word.type == null,
		);

		for (const word of words) {
			const text = word.text ?? word.word;
			if (!text || typeof word.start !== "number") continue;

			const start = chunk.startSec + word.start;
			const end =
				chunk.startSec + (typeof word.end === "number" ? word.end : word.start);
			allWords.push({
				word: text,
				start: Number(start.toFixed(3)),
				end: Number(end.toFixed(3)),
			});
		}
	}

	return allWords;
}

async function transcribeChunk(
	chunk: ScribeAudioChunk,
	apiKey: string,
	attempt = 0,
): Promise<ElevenScribeResponse> {
	const bytes = await readChunkBytes(chunk);
	const fd = new FormData();
	fd.append(
		"file",
		new Blob([toArrayBuffer(bytes)], { type: "audio/mpeg" }),
		chunkFilename(chunk),
	);
	fd.append("model_id", "scribe_v2");
	fd.append("language_code", "uzb");
	fd.append("timestamps_granularity", "word");
	fd.append("diarize", "false");

	const response = await fetch(SCRIBE_ENDPOINT, {
		method: "POST",
		headers: { "xi-api-key": apiKey },
		body: fd,
	});

	if (!response.ok) {
		const body = await response.text();
		if (isRetryable(response.status) && attempt < MAX_SCRIBE_RETRIES) {
			await sleep(backoffMs(attempt));
			return transcribeChunk(chunk, apiKey, attempt + 1);
		}
		throw new Error(
			`ElevenLabs Scribe ${response.status}: ${body.slice(0, 400)}`,
		);
	}

	return response.json() as Promise<ElevenScribeResponse>;
}

async function readChunkBytes(chunk: ScribeAudioChunk): Promise<Uint8Array> {
	if (chunk.buffer instanceof ArrayBuffer) {
		return new Uint8Array(chunk.buffer);
	}
	if (chunk.buffer) {
		return new Uint8Array(chunk.buffer);
	}
	if (chunk.filePath) {
		return fs.readFile(chunk.filePath);
	}
	if (chunk.url) {
		const response = await fetch(chunk.url);
		if (!response.ok) {
			throw new Error(
				`Failed to fetch audio chunk for Scribe: ${response.status}`,
			);
		}
		return new Uint8Array(await response.arrayBuffer());
	}
	throw new Error("Scribe audio chunk must include filePath, buffer, or url");
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy.buffer;
}

function chunkFilename(chunk: ScribeAudioChunk): string {
	if (chunk.filePath) return path.basename(chunk.filePath);
	return `audio-${Math.round(chunk.startSec * 1000)}.mp3`;
}

function isRetryable(status: number): boolean {
	return status === 429 || status >= 500;
}

function backoffMs(attempt: number): number {
	return 2_000 * 2 ** attempt;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
