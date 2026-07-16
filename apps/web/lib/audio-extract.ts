import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";
import {
	planVadChunks,
	type SilenceInterval,
	type VadPlanOptions,
} from "@/lib/transcription-chunking";

/**
 * Hard wall-clock cap on any single ffmpeg invocation. Without this a stalled
 * ffmpeg never settles its promise, so the (fire-and-forget) transcription
 * workflow hangs forever and the video is stranded in PROCESSING with no error
 * — observed on a 36-min video that froze at 84% of audio extraction. Killing
 * it surfaces a real failure the user can retry.
 */
const FFMPEG_TIMEOUT_MS = Number(
	process.env.FFMPEG_TIMEOUT_MS ?? 15 * 60 * 1000,
);

function armFfmpegTimeout(
	proc: ChildProcess,
	label: string,
	reject: (err: Error) => void,
): void {
	const timer = setTimeout(() => {
		proc.kill("SIGKILL");
		reject(
			new Error(
				`ffmpeg ${label} timed out after ${Math.round(FFMPEG_TIMEOUT_MS / 1000)}s`,
			),
		);
	}, FFMPEG_TIMEOUT_MS);
	const clear = () => clearTimeout(timer);
	proc.on("close", clear);
	proc.on("error", clear);
}

let cachedFfmpegPath: string | null = null;

function getPathCandidates(): string[] {
	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.map((segment) => join(segment, "ffmpeg"));
}

export function getFfmpegPath(): string {
	if (cachedFfmpegPath) {
		return cachedFfmpegPath;
	}

	const candidatePaths = [
		ffmpegStaticPath,
		resolve(process.cwd(), "node_modules/ffmpeg-static/ffmpeg"),
		resolve(
			process.cwd(),
			"node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg",
		),
		"/var/task/node_modules/ffmpeg-static/ffmpeg",
		"/var/task/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg",
		process.env.FFMPEG_PATH,
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		"/usr/bin/ffmpeg",
		...getPathCandidates(),
	].filter(Boolean) as string[];

	for (const path of candidatePaths) {
		if (existsSync(path)) {
			cachedFfmpegPath = path;
			return path;
		}
	}

	throw new Error(
		`FFmpeg binary not found. Tried paths: ${candidatePaths.join(", ")}`,
	);
}

export interface AudioExtractionResult {
	filePath: string;
	mimeType: string;
	cleanup: () => Promise<void>;
}

export interface ExtractAudioOptions {
	/**
	 * Total source duration in seconds — required to compute a real conversion %.
	 * When omitted (or non-finite), no percentage is reported (onProgress is never
	 * called) so the caller can render a spinner instead of a fake bar.
	 */
	totalDurationSec?: number | null;
	/**
	 * Called with an integer 0..100 as ffmpeg makes progress. Throttled to ~once
	 * per second. Only invoked when totalDurationSec is a finite positive number.
	 */
	onProgress?: (pct: number) => void;
}

/**
 * Parse ffmpeg's `time=HH:MM:SS.ss` progress markers (printed to stderr) into
 * elapsed seconds. ffmpeg emits these repeatedly as it encodes.
 */
function parseFfmpegTimeSeconds(text: string): number | null {
	// Use the LAST occurrence — stderr accumulates and we want the newest.
	const matches = text.match(/time=(\d+):(\d+):(\d+)\.(\d+)/g);
	if (!matches || matches.length === 0) return null;
	const last = matches[matches.length - 1];
	const m = last?.match(/time=(\d+):(\d+):(\d+)\.(\d+)/);
	if (!m) return null;
	const [, h, min, s, cs] = m;
	return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(cs) / 100;
}

/**
 * Inspect the upstream URL with a cheap HEAD request, then fall back to the
 * file extension parsed from the URL path. Returns the lowercased extension
 * (without the leading dot) and the content-type, if available.
 *
 * Both signals matter: signed S3/R2 URLs usually carry the right Content-Type
 * but the query string carries the extension; if the storage backend lies
 * about the type (or returns octet-stream), the extension is our backup.
 */
async function detectAudioInput(
	url: string,
): Promise<{ ext: string | null; contentType: string | null }> {
	let contentType: string | null = null;
	try {
		const head = await fetch(url, { method: "HEAD" });
		if (head.ok) {
			contentType = head.headers.get("content-type")?.toLowerCase() ?? null;
		}
	} catch {
		// Network/HEAD failures are non-fatal — we fall back to the extension.
	}

	let ext: string | null = null;
	try {
		const pathname = new URL(url).pathname;
		const m = pathname.match(/\.([a-zA-Z0-9]+)$/);
		if (m?.[1]) ext = m[1].toLowerCase();
	} catch {
		// Non-URL inputs (e.g. local paths) — try a plain regex.
		const m = url.match(/\.([a-zA-Z0-9]+)(?:\?|$)/);
		if (m?.[1]) ext = m[1].toLowerCase();
	}

	return { ext, contentType };
}

const PASSTHROUGH_AUDIO_EXTS = new Set(["mp3", "m4a", "aac"]);
const REENCODE_AUDIO_EXTS = new Set(["wav", "ogg", "opus", "flac"]);

function isAudioInput(ext: string | null, contentType: string | null): boolean {
	if (contentType?.startsWith("audio/")) return true;
	if (!ext) return false;
	return PASSTHROUGH_AUDIO_EXTS.has(ext) || REENCODE_AUDIO_EXTS.has(ext);
}

async function downloadToTempFile(url: string, ext: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(
			`Audio download failed: ${response.status} ${response.statusText}`,
		);
	}
	const buf = Buffer.from(await response.arrayBuffer());
	const outputPath = join(tmpdir(), `audio-${randomUUID()}.${ext}`);
	await fs.writeFile(outputPath, buf);
	return outputPath;
}

async function reencodeAudioToMp3(
	inputUrl: string,
	options: ExtractAudioOptions,
): Promise<string> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `audio-${randomUUID()}.mp3`);

	// Mono 16kHz @ 64k mp3 — Gemini-friendly and keeps token cost minimal for
	// lossless/non-mp3 sources. `-vn` is harmless for audio-only inputs.
	const ffmpegArgs = [
		"-i",
		inputUrl,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"16000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"64k",
		"-f",
		"mp3",
		"-y",
		outputPath,
	];

	const totalDuration = options.totalDurationSec;
	const canReportPct =
		typeof totalDuration === "number" &&
		Number.isFinite(totalDuration) &&
		totalDuration > 0 &&
		typeof options.onProgress === "function";

	await new Promise<void>((resolveRun, rejectRun) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			// stdout is NOT drained here (output goes to a file). Piping it lets
			// ffmpeg block forever once the 64KB pipe buffer fills. Ignore it.
			stdio: ["ignore", "ignore", "pipe"],
		});
		armFfmpegTimeout(proc, "reencode", rejectRun);
		let stderr = "";
		let lastEmit = 0;
		let lastPct = -1;
		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
			if (!canReportPct) return;
			const now = Date.now();
			if (now - lastEmit < 1000) return;
			const elapsedSec = parseFfmpegTimeSeconds(stderr);
			if (elapsedSec == null) return;
			const pct = Math.max(
				0,
				Math.min(
					100,
					Math.round((elapsedSec / (totalDuration as number)) * 100),
				),
			);
			if (pct <= lastPct) return;
			lastPct = pct;
			lastEmit = now;
			options.onProgress?.(pct);
		});
		proc.on("error", (err: Error) => {
			fs.unlink(outputPath).catch(() => {});
			rejectRun(new Error(`Audio re-encode failed: ${err.message}`));
		});
		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolveRun();
			} else {
				fs.unlink(outputPath).catch(() => {});
				rejectRun(
					new Error(`Audio re-encode failed with code ${code}: ${stderr}`),
				);
			}
		});
	});

	return outputPath;
}

export async function extractAudioFromUrl(
	videoUrl: string,
	options: ExtractAudioOptions = {},
): Promise<AudioExtractionResult> {
	// ── Fast-path: source is already audio. Skip the video-decode pipeline.
	const detected = await detectAudioInput(videoUrl);
	if (isAudioInput(detected.ext, detected.contentType)) {
		const ext = detected.ext ?? "mp3";
		const isPassthrough = PASSTHROUGH_AUDIO_EXTS.has(ext);
		if (isPassthrough) {
			// Already mp3/m4a/aac at upload-time bitrate — copy bytes verbatim,
			// no ffmpeg involved. Gemini accepts these formats directly.
			const filePath = await downloadToTempFile(videoUrl, ext);
			console.log(
				`[CAP-AUDIO] short-circuit=copy ext=${ext} contentType=${detected.contentType ?? "unknown"} bytes=${(await fs.stat(filePath)).size}`,
			);
			// Report 100% so the progress phase doesn't sit at 0.
			if (typeof options.onProgress === "function") options.onProgress(100);
			return {
				filePath,
				mimeType: detected.contentType ?? "audio/mpeg",
				cleanup: async () => {
					try {
						await fs.unlink(filePath);
					} catch {}
				},
			};
		}

		// wav/flac/ogg/opus — re-encode to mp3 mono 16k for Gemini.
		const outputPath = await reencodeAudioToMp3(videoUrl, options);
		console.log(
			`[CAP-AUDIO] short-circuit=reencode ext=${ext} contentType=${detected.contentType ?? "unknown"} -> audio/mpeg mono16k`,
		);
		return {
			filePath: outputPath,
			mimeType: "audio/mpeg",
			cleanup: async () => {
				try {
					await fs.unlink(outputPath);
				} catch {}
			},
		};
	}

	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `audio-${randomUUID()}.mp3`);

	// -copyts / -avoid_negative_ts make_zero: preserve input timestamps so
	// that transcription cues align with the original video timeline.
	const ffmpegArgs = [
		"-copyts",
		"-i",
		videoUrl,
		"-avoid_negative_ts",
		"make_zero",
		"-vn",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"128k",
		"-f",
		"mp3",
		"-y",
		outputPath,
	];

	const totalDuration = options.totalDurationSec;
	const canReportPct =
		typeof totalDuration === "number" &&
		Number.isFinite(totalDuration) &&
		totalDuration > 0 &&
		typeof options.onProgress === "function";

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			// stdout is NOT drained here (output goes to a file). Piping it lets
			// ffmpeg block forever once the 64KB pipe buffer fills. Ignore it.
			stdio: ["ignore", "ignore", "pipe"],
		});
		armFfmpegTimeout(proc, "extract", reject);

		let stderr = "";
		let lastEmit = 0; // throttle: wall-clock ms of last onProgress call
		let lastPct = -1; // monotonic: never report a lower %

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();

			if (!canReportPct) return;
			const now = Date.now();
			if (now - lastEmit < 1000) return; // throttle to ~once/second

			const elapsedSec = parseFfmpegTimeSeconds(stderr);
			if (elapsedSec == null) return;
			const pct = Math.max(
				0,
				Math.min(
					100,
					Math.round((elapsedSec / (totalDuration as number)) * 100),
				),
			);
			if (pct <= lastPct) return; // keep monotonic
			lastPct = pct;
			lastEmit = now;
			options.onProgress?.(pct);
		});

		proc.on("error", (err: Error) => {
			fs.unlink(outputPath).catch(() => {});
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve({
					filePath: outputPath,
					mimeType: "audio/mpeg",
					cleanup: async () => {
						try {
							await fs.unlink(outputPath);
						} catch {}
					},
				});
			} else {
				fs.unlink(outputPath).catch(() => {});
				reject(
					new Error(`Audio extraction failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}

export async function extractAudioToBuffer(videoUrl: string): Promise<Buffer> {
	const ffmpeg = getFfmpegPath();
	const ffmpegArgs = [
		"-i",
		videoUrl,
		"-vn",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"128k",
		"-f",
		"mp3",
		"-pipe:1",
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			// stdout IS drained below (the encoded output is piped through it).
			stdio: ["pipe", "pipe", "pipe"],
		});
		armFfmpegTimeout(proc, "transcode", reject);

		const chunks: Buffer[] = [];
		let stderr = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(
					new Error(`Audio extraction failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}

export interface AudioSlice {
	path: string;
	startOffsetSec: number;
	durationSec: number;
	cleanup: () => Promise<void>;
}

/**
 * Slice an existing audio file on disk into time-windowed chunks. Uses ffmpeg
 * stream copy (no re-encode) when possible. Each chunk overlaps the next by
 * `overlapSec` seconds to avoid mid-word cuts at boundaries.
 */
export async function chunkAudio(
	inputPath: string,
	totalDurationSec: number,
	windowSec = 600,
	overlapSec = 5,
): Promise<AudioSlice[]> {
	const ffmpeg = getFfmpegPath();
	const slices: AudioSlice[] = [];
	const stride = Math.max(1, windowSec - overlapSec);

	let offset = 0;
	let index = 0;
	while (offset < totalDurationSec) {
		const remaining = totalDurationSec - offset;
		const sliceDuration = Math.min(windowSec, remaining);
		const outputPath = join(
			tmpdir(),
			`audio-chunk-${randomUUID()}-${index}.mp3`,
		);

		const ffmpegArgs = [
			"-ss",
			String(offset),
			"-i",
			inputPath,
			"-t",
			String(sliceDuration),
			"-vn",
			"-acodec",
			"libmp3lame",
			"-b:a",
			"128k",
			"-f",
			"mp3",
			"-y",
			outputPath,
		];

		await new Promise<void>((resolveSlice, rejectSlice) => {
			const proc = spawn(ffmpeg, ffmpegArgs, {
				// stdout is not drained here; piping it can block ffmpeg forever.
				stdio: ["ignore", "ignore", "pipe"],
			});
			armFfmpegTimeout(proc, "chunk", rejectSlice);
			let stderr = "";
			proc.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});
			proc.on("error", (err: Error) => {
				fs.unlink(outputPath).catch(() => {});
				rejectSlice(new Error(`Audio chunking failed: ${err.message}`));
			});
			proc.on("close", (code: number | null) => {
				if (code === 0) {
					resolveSlice();
				} else {
					fs.unlink(outputPath).catch(() => {});
					rejectSlice(
						new Error(`Audio chunking failed with code ${code}: ${stderr}`),
					);
				}
			});
		});

		slices.push({
			path: outputPath,
			startOffsetSec: offset,
			durationSec: sliceDuration,
			cleanup: async () => {
				try {
					await fs.unlink(outputPath);
				} catch {}
			},
		});

		index++;
		// last slice — break out (next iteration would go past end)
		if (remaining <= windowSec) break;
		offset += stride;
	}

	return slices;
}

/**
 * Detect silence intervals via ffmpeg's silencedetect filter in a single pass.
 * The equivalent of pydub's split_on_silence used in the ds_er dataset pipeline
 * (noise floor + minimum silence duration), but detection-only so timestamps are
 * never shifted. silencedetect prints to stderr.
 */
export async function detectSilenceIntervals(
	inputPath: string,
	// -30 dB matches the ds_er dataset pipeline's proven value: conservative
	// enough not to classify quiet speech as silence (which would drop real
	// words), while still catching genuine dead air.
	noiseDb = -30,
	minSilenceSec = 0.6,
): Promise<SilenceInterval[]> {
	const ffmpeg = getFfmpegPath();
	const args = [
		"-i",
		inputPath,
		"-af",
		`silencedetect=noise=${noiseDb}dB:d=${minSilenceSec}`,
		"-f",
		"null",
		"-",
	];

	const stderr = await new Promise<string>((resolveErr, rejectErr) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
		armFfmpegTimeout(proc, "silencedetect", rejectErr);
		let out = "";
		proc.stderr?.on("data", (d: Buffer) => {
			out += d.toString();
		});
		proc.on("error", (err: Error) =>
			rejectErr(new Error(`silencedetect failed: ${err.message}`)),
		);
		proc.on("close", (code: number | null) =>
			code === 0
				? resolveErr(out)
				: rejectErr(new Error(`silencedetect exited ${code}`)),
		);
	});

	const intervals: SilenceInterval[] = [];
	let start: number | null = null;
	for (const line of stderr.split("\n")) {
		const s = line.match(/silence_start:\s*(-?[\d.]+)/);
		if (s?.[1] != null) {
			start = Number.parseFloat(s[1]);
			continue;
		}
		const e = line.match(/silence_end:\s*(-?[\d.]+)/);
		if (e?.[1] != null && start != null) {
			intervals.push({ startSec: start, endSec: Number.parseFloat(e[1]) });
			start = null;
		}
	}
	return intervals;
}

async function extractSlice(
	ffmpeg: string,
	inputPath: string,
	startSec: number,
	durationSec: number,
	outputPath: string,
): Promise<void> {
	const args = [
		"-ss",
		String(startSec),
		"-i",
		inputPath,
		"-t",
		String(durationSec),
		"-vn",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"128k",
		"-f",
		"mp3",
		"-y",
		outputPath,
	];
	await new Promise<void>((res, rej) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
		armFfmpegTimeout(proc, "vad-slice", rej);
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", (err: Error) => {
			fs.unlink(outputPath).catch(() => {});
			rej(new Error(`vad slice failed: ${err.message}`));
		});
		proc.on("close", (code: number | null) =>
			code === 0
				? res()
				: (fs.unlink(outputPath).catch(() => {}),
					rej(new Error(`vad slice exited ${code}: ${stderr}`))),
		);
	});
}

/**
 * VAD-based chunking: split on detected silence rather than blind fixed windows.
 * Boundaries land in silence (no mid-word cuts, no overlap needed), long silences
 * are skipped entirely (they trigger the model's repetition loops and cost tokens
 * for nothing), and each chunk keeps its real start offset. Falls back to fixed
 * windows if no usable silence is found (e.g. wall-to-wall speech or a probe
 * failure), so it is always safe to call.
 */
export async function chunkAudioVad(
	inputPath: string,
	totalDurationSec: number,
	opts: VadPlanOptions & { noiseDb?: number; minSilenceSec?: number } = {},
): Promise<AudioSlice[]> {
	const ffmpeg = getFfmpegPath();
	let plan: ReturnType<typeof planVadChunks> = [];
	try {
		const silences = await detectSilenceIntervals(
			inputPath,
			opts.noiseDb,
			opts.minSilenceSec,
		);
		plan = planVadChunks(silences, totalDurationSec, opts);
	} catch (err) {
		console.warn(
			`[CAP-TRANSCRIBE] silencedetect failed, falling back to fixed windows:`,
			err,
		);
	}

	// No usable plan (no silence, or all one block that equals fixed windows) →
	// use the original fixed-window chunker.
	if (plan.length === 0) {
		return chunkAudio(inputPath, totalDurationSec, opts.maxSec ?? 300, 5);
	}

	const slices: AudioSlice[] = [];
	let index = 0;
	for (const chunk of plan) {
		const outputPath = join(tmpdir(), `audio-vad-${randomUUID()}-${index}.mp3`);
		await extractSlice(
			ffmpeg,
			inputPath,
			chunk.startSec,
			chunk.endSec - chunk.startSec,
			outputPath,
		);
		slices.push({
			path: outputPath,
			startOffsetSec: chunk.startSec,
			durationSec: chunk.endSec - chunk.startSec,
			cleanup: async () => {
				try {
					await fs.unlink(outputPath);
				} catch {}
			},
		});
		index++;
	}
	return slices;
}

export async function convertWavToMp3(wavBuffer: Buffer): Promise<Buffer> {
	const ffmpeg = getFfmpegPath();
	const ffmpegArgs = [
		"-i",
		"pipe:0",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"128k",
		"-f",
		"mp3",
		"-pipe:1",
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			// stdout IS drained below (the encoded output is piped through it).
			stdio: ["pipe", "pipe", "pipe"],
		});
		armFfmpegTimeout(proc, "probe-duration", reject);

		const chunks: Buffer[] = [];
		let stderr = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`WAV to MP3 conversion failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(
					new Error(
						`WAV to MP3 conversion failed with code ${code}: ${stderr}`,
					),
				);
			}
		});

		proc.stdin?.write(wavBuffer);
		proc.stdin?.end();
	});
}

export interface VideoProbeResult {
	hasAudio: boolean;
	durationSec: number | null;
}

function parseDurationFromStderr(stderr: string): number | null {
	const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
	if (!match) return null;
	const [, h, m, s, cs] = match;
	return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(cs) / 100;
}

export async function checkHasAudioTrack(
	videoUrl: string,
): Promise<VideoProbeResult> {
	let ffmpeg: string;
	try {
		ffmpeg = getFfmpegPath();
	} catch (err) {
		console.error(
			`[checkHasAudioTrack] ffmpeg binary not found, cannot check audio track:`,
			err,
		);
		throw new Error("ffmpeg binary not available — cannot check audio track");
	}
	const ffmpegArgs = ["-i", videoUrl, "-hide_banner"];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			// stdout is not drained here; piping it can block ffmpeg forever.
			stdio: ["ignore", "ignore", "pipe"],
		});
		armFfmpegTimeout(proc, "probe-audio", reject);

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err) => {
			console.error(`[checkHasAudioTrack] ffmpeg process error:`, err);
			reject(new Error(`ffmpeg process error: ${err.message}`));
		});

		proc.on("close", () => {
			const hasVideo = /Stream #\d+:\d+.*Video:/.test(stderr);
			const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr);

			// Audio-only files (webAudio uploads) have no video stream — treat that
			// as a valid probe result rather than an error, as long as ffmpeg
			// detected at least one audio stream.
			if (!hasVideo && !hasAudio) {
				console.error(
					`[checkHasAudioTrack] No streams found — ffmpeg may not be able to read the file. stderr: ${stderr.substring(0, 500)}`,
				);
				reject(
					new Error(`ffmpeg could not read media file: no streams detected`),
				);
				return;
			}

			const durationSec = parseDurationFromStderr(stderr);

			console.log(
				`[checkHasAudioTrack] Result: hasVideo=${hasVideo}, hasAudio=${hasAudio}, durationSec=${durationSec}`,
			);
			resolve({ hasAudio, durationSec });
		});
	});
}
