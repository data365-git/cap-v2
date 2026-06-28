import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";

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

function isAudioInput(
	ext: string | null,
	contentType: string | null,
): boolean {
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
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
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
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

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
				Math.min(100, Math.round((elapsedSec / (totalDuration as number)) * 100)),
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
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

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
				stdio: ["pipe", "pipe", "pipe"],
			});
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
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

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

export async function checkHasAudioTrack(videoUrl: string): Promise<VideoProbeResult> {
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
			stdio: ["pipe", "pipe", "pipe"],
		});

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
