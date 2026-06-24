/**
 * Server-side video probing + ffmpeg orchestration for the process-video workflow.
 *
 * Reuses the existing ffmpeg path resolver from audio-extract.ts so we use the
 * same binary everywhere (ffmpeg-static bundled with the deploy, or a system
 * install during local dev).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getFfmpegPath } from "./audio-extract";

export interface VideoProbeResult {
	durationSec: number | null;
	width: number | null;
	height: number | null;
	fps: number | null;
	videoCodec: string | null;
	audioCodec: string | null;
	containerFormat: string | null;
	hasAudio: boolean;
}

/**
 * Probe a media URL with `ffmpeg -i` and parse the stderr metadata block.
 *
 * We intentionally use ffmpeg (not ffprobe) because ffmpeg-static ships only
 * the ffmpeg binary, and the stderr layout is stable enough to parse for the
 * handful of fields we need.
 */
export async function probeVideo(videoUrl: string): Promise<VideoProbeResult> {
	const ffmpeg = getFfmpegPath();
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ["-i", videoUrl, "-hide_banner"], {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", (err) =>
			reject(new Error(`probeVideo: ffmpeg spawn failed: ${err.message}`)),
		);
		proc.on("close", () => {
			// ffmpeg -i (no output) exits non-zero — that's fine, we only need stderr.
			const durMatch = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
			const durationSec = durMatch
				? Number(durMatch[1]) * 3600 +
					Number(durMatch[2]) * 60 +
					Number(durMatch[3]) +
					Number(durMatch[4]) / 100
				: null;

			const videoStream = stderr.match(
				/Stream #\d+:\d+[^\n]*Video:\s*([a-z0-9_]+)[^\n]*?(\d{2,5})x(\d{2,5})[^\n]*?(?:(\d+(?:\.\d+)?)\s*fps)?/i,
			);
			const videoCodec = videoStream?.[1] ?? null;
			const width = videoStream?.[2] ? Number(videoStream[2]) : null;
			const height = videoStream?.[3] ? Number(videoStream[3]) : null;
			const fps = videoStream?.[4] ? Math.round(Number(videoStream[4])) : null;

			const audioStream = stderr.match(
				/Stream #\d+:\d+[^\n]*Audio:\s*([a-z0-9_]+)/i,
			);
			const audioCodec = audioStream?.[1] ?? null;
			const hasAudio = Boolean(audioCodec);

			const containerMatch = stderr.match(/Input #0,\s*([^,]+),/);
			const containerFormat = containerMatch?.[1]?.trim() ?? null;

			resolve({
				durationSec,
				width,
				height,
				fps,
				videoCodec,
				audioCodec,
				containerFormat,
				hasAudio,
			});
		});
	});
}

const SAFARI_UNFRIENDLY_CONTAINERS = ["webm", "matroska", "mkv", "ogg"];
const SAFARI_UNFRIENDLY_VIDEO_CODECS = ["vp8", "vp9", "av1"];

/**
 * Return true if the source needs a full re-encode to play in Safari.
 * Falls back to the file extension when the probe couldn't read the container.
 */
export function needsMp4Transcode(
	probe: VideoProbeResult,
	sourceKey: string,
): boolean {
	const container = (probe.containerFormat ?? "").toLowerCase();
	if (
		SAFARI_UNFRIENDLY_CONTAINERS.some((bad) => container.includes(bad))
	) {
		return true;
	}
	const codec = (probe.videoCodec ?? "").toLowerCase();
	if (SAFARI_UNFRIENDLY_VIDEO_CODECS.some((bad) => codec.includes(bad))) {
		return true;
	}
	const lowerKey = sourceKey.toLowerCase();
	if (lowerKey.endsWith(".webm") || lowerKey.endsWith(".mkv") || lowerKey.endsWith(".ogg")) {
		return true;
	}
	return false;
}

/**
 * Re-encode an arbitrary source to a Safari-friendly MP4 (H.264 + AAC,
 * faststart so the moov atom sits at the front and playback starts before
 * the whole file is downloaded).
 *
 * Quality is fixed at -crf 23 / -preset veryfast per the workflow brief:
 * fast enough to stay within reasonable processing budgets, good enough that
 * scrub-quality is indistinguishable from the source for the recordings we
 * ingest.
 */
export async function transcodeToMp4(sourceUrl: string): Promise<{
	outputPath: string;
	sizeBytes: number;
	elapsedMs: number;
	cleanup: () => Promise<void>;
}> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `transcode-${randomUUID()}.mp4`);
	const args = [
		"-y",
		"-i",
		sourceUrl,
		"-c:v",
		"libx264",
		"-preset",
		"veryfast",
		"-crf",
		"23",
		"-pix_fmt",
		"yuv420p",
		"-c:a",
		"aac",
		"-b:a",
		"128k",
		"-movflags",
		"+faststart",
		outputPath,
	];
	const start = Date.now();
	await runFfmpeg(ffmpeg, args, "transcodeToMp4", outputPath);
	const stat = await fs.stat(outputPath);
	return {
		outputPath,
		sizeBytes: stat.size,
		elapsedMs: Date.now() - start,
		cleanup: async () => {
			await fs.unlink(outputPath).catch(() => {});
		},
	};
}

/**
 * Remux an MP4 to the same MP4 container with `+faststart`. Cheap — no
 * re-encode — but guarantees the moov atom is at the front of the file so
 * Safari can begin playback before downloading the whole asset.
 */
export async function remuxMp4Faststart(sourceUrl: string): Promise<{
	outputPath: string;
	sizeBytes: number;
	elapsedMs: number;
	cleanup: () => Promise<void>;
}> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `remux-${randomUUID()}.mp4`);
	const args = [
		"-y",
		"-i",
		sourceUrl,
		"-c",
		"copy",
		"-movflags",
		"+faststart",
		outputPath,
	];
	const start = Date.now();
	await runFfmpeg(ffmpeg, args, "remuxMp4Faststart", outputPath);
	const stat = await fs.stat(outputPath);
	return {
		outputPath,
		sizeBytes: stat.size,
		elapsedMs: Date.now() - start,
		cleanup: async () => {
			await fs.unlink(outputPath).catch(() => {});
		},
	};
}

/**
 * Extract a single still frame at roughly 10% of the way through the video,
 * encoded as a high-quality JPEG. Returns the file path on disk.
 */
export async function extractThumbnail(
	sourceUrl: string,
	durationSec: number,
): Promise<{ outputPath: string; cleanup: () => Promise<void> }> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `thumb-${randomUUID()}.jpg`);
	const seekSec = Math.max(0, Math.min(durationSec * 0.1, durationSec - 0.1));
	const args = [
		"-y",
		"-ss",
		seekSec.toFixed(2),
		"-i",
		sourceUrl,
		"-frames:v",
		"1",
		"-q:v",
		"2",
		outputPath,
	];
	await runFfmpeg(ffmpeg, args, "extractThumbnail", outputPath);
	return {
		outputPath,
		cleanup: async () => {
			await fs.unlink(outputPath).catch(() => {});
		},
	};
}

/**
 * Build a short looping animated GIF (~4 seconds) starting at the 10% mark.
 * 480px wide, 10fps — small enough to send as a library hover preview.
 */
export async function extractGifPreview(
	sourceUrl: string,
	durationSec: number,
): Promise<{ outputPath: string; cleanup: () => Promise<void> }> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `gif-${randomUUID()}.gif`);
	const seekSec = Math.max(0, Math.min(durationSec * 0.1, durationSec - 0.1));
	const clipSec = Math.min(4, Math.max(1, durationSec - seekSec));
	const args = [
		"-y",
		"-ss",
		seekSec.toFixed(2),
		"-t",
		clipSec.toFixed(2),
		"-i",
		sourceUrl,
		"-vf",
		"fps=10,scale=480:-1:flags=lanczos",
		"-loop",
		"0",
		outputPath,
	];
	await runFfmpeg(ffmpeg, args, "extractGifPreview", outputPath);
	return {
		outputPath,
		cleanup: async () => {
			await fs.unlink(outputPath).catch(() => {});
		},
	};
}

function runFfmpeg(
	ffmpegPath: string,
	args: string[],
	label: string,
	outputPath: string,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpegPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stderr = "";
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});
		proc.on("error", (err) => {
			fs.unlink(outputPath).catch(() => {});
			reject(new Error(`${label} spawn failed: ${err.message}`));
		});
		proc.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				fs.unlink(outputPath).catch(() => {});
				reject(
					new Error(
						`${label} exited ${code}: ${stderr.slice(-500)}`,
					),
				);
			}
		});
	});
}

/**
 * Run `fn` up to `attempts` times with exponential backoff. Used to wrap
 * thumbnail / GIF generation so a single transient ffmpeg or S3 failure
 * doesn't permanently leave a video without a preview.
 */
export async function withRetry<T>(
	label: string,
	attempts: number,
	fn: () => Promise<T>,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			console.warn(
				`[CAP-PROCESS] ${label} attempt ${attempt}/${attempts} failed: ${
					err instanceof Error ? err.message : String(err)
				}`,
			);
			if (attempt < attempts) {
				const delayMs = 2000 * 2 ** (attempt - 1);
				await new Promise((r) => setTimeout(r, delayMs));
			}
		}
	}
	throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
