import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { aiUsageEvents, organizations, videos } from "@cap/database/schema";
import type {
	AiSummary,
	PipelinePhase,
	PipelinePhaseKey,
	PipelineProgress,
	VideoMetadata,
} from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { priceForMicros } from "@cap/utils";
import { Storage } from "@cap/web-backend";
import {
	AI_GENERATION_LANGUAGE_AUTO,
	type AiGenerationLanguage,
	getAiGenerationLanguageName,
	type Organisation,
	parseAiGenerationLanguage,
	type User,
	type Video,
} from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { FatalError } from "workflow";
import { z } from "zod";
import {
	billedInputTokens,
	billedOutputTokens,
	type GeminiUsageMetadata,
} from "@/lib/gemini-usage";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

interface GenerateAiWorkflowPayload {
	videoId: string;
	userId: string;
	/** Regenerate even when AI metadata already exists (e.g. after a re-transcription). */
	force?: boolean;
}

interface VideoData {
	video: typeof videos.$inferSelect;
	metadata: VideoMetadata;
	aiGenerationLanguage: AiGenerationLanguage;
}

interface VttSegment {
	start: number;
	text: string;
}

interface TranscriptData {
	segments: VttSegment[];
	text: string;
}

interface AiResult {
	title?: string;
	summary?: string;
	chapters?: { title: string; start: number }[];
	aiSummary?: AiSummary | null;
	_usage?: { model: string; inputTokens: number; outputTokens: number };
}

const AiSummarySchema = z.object({
	overview: z.string().default(""),
	topics: z
		.array(z.object({ title: z.string(), body: z.string() }))
		.default([]),
	nextSteps: z.array(z.string()).default([]),
	tasks: z
		.array(
			z.object({
				title: z.string(),
				category: z.string().default(""),
				assignee: z.string().default(""),
				priority: z.enum(["high", "medium", "low"]).default("medium"),
				deadline: z.string().default(""),
				done: z.boolean().default(false),
			}),
		)
		.default([]),
	chapters: z
		.array(
			z.object({
				startSec: z.number(),
				title: z.string(),
				body: z.string(),
			}),
		)
		.default([]),
	refinedTranscript: z
		.object({
			intro: z
				.object({
					participants: z.array(z.string()).default([]),
					duration: z.string().default(""),
					purpose: z.string().default(""),
				})
				.optional(),
			chapters: z
				.array(
					z.object({
						startSec: z.number(),
						title: z.string(),
						paragraphs: z.array(z.string()),
					}),
				)
				.default([]),
		})
		.default({ chapters: [] }),
});

function parseAiSummary(raw: unknown): AiSummary | null {
	const result = AiSummarySchema.safeParse(raw);
	if (!result.success) return null;
	return result.data;
}

// The 1M-token context easily holds any meeting transcript (a 3-hour meeting is
// ~100k chars ≈ 25k tokens, ~2.5% of context), so input is never the reason to
// split. The real limit is the 65,536-token OUTPUT cap: the summary + whole
// refined transcript scale with length. At ~100k chars (~3 hours) the output
// still fits comfortably, so anything shorter is summarized in ONE pass —
// better quality (full cross-section context) and fewer/cheaper calls than the
// old 24k (~45 min) threshold. Beyond ~3 hours we fall back to the section-then-
// merge path to avoid truncating the output.
const MAX_CHARS_PER_CHUNK = 100000;
const GENERATED_TITLE_PATTERN =
	/^(Cap (Recording|Upload) - .+|Untitled|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}|.+ \((Display|Window|Area|Camera)\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} [AP]M)$/;

export function shouldReplaceVideoTitle({
	currentTitle,
	previousAiTitle,
	nextAiTitle,
	sourceName,
	titleManuallyEdited,
}: {
	currentTitle: string | null;
	previousAiTitle?: string | null;
	nextAiTitle?: string | null;
	sourceName?: string | null;
	titleManuallyEdited?: boolean | null;
}) {
	const nextTitle = nextAiTitle?.trim();
	if (!nextTitle) return false;
	if (titleManuallyEdited) return false;

	const title = currentTitle?.trim();
	if (!title) return true;
	if (previousAiTitle?.trim() && title === previousAiTitle.trim()) return true;
	if (sourceName?.trim() && title === sourceName.trim()) return true;
	return GENERATED_TITLE_PATTERN.test(title);
}

export async function generateAiWorkflow(payload: GenerateAiWorkflowPayload) {
	"use workflow";

	const { videoId, userId, force = false } = payload;

	const videoData = await validateAndSetProcessing(videoId, force);

	const transcript = await fetchTranscript(videoId, userId, videoData.video);

	if (!transcript) {
		await markSkipped(videoId, videoData.metadata);
		return {
			success: true,
			message: "Transcript empty or too short - skipped",
		};
	}

	// analyze phase — the single master AI call. Atomic: total:1, flips done
	// together once generateWithAi returns and the result is persisted. Shares
	// the same `phases` array seeded by the transcribe workflow (read-modify-write).
	const isAudioSource = videoData.video.source?.type === "webAudio";
	const analyzeStart = Date.now();
	await patchPipelinePhase(
		videoId,
		"analyze",
		{
			status: "active",
			done: 0,
			total: 1,
			startedAt: new Date().toISOString(),
		},
		isAudioSource,
	);

	const result = await generateWithAi(
		transcript,
		videoData.aiGenerationLanguage,
		videoData.video.duration ?? null,
		videoId,
		// The model has no clock. Without the meeting's own date it invented
		// deadlines (a 2026 meeting produced "2024-06-15"), which the UI then
		// presented to users as fact.
		(videoData.video.createdAt ?? new Date())
			.toISOString()
			.slice(0, 10),
	);

	if (result._usage) {
		await recordSummaryUsage(
			videoData.video.orgId,
			userId,
			videoId,
			result._usage,
		);
	}

	await saveResults(videoId, videoData, result);

	await patchPipelinePhase(
		videoId,
		"analyze",
		{
			status: "done",
			done: 1,
			total: 1,
			completedAt: new Date().toISOString(),
			unitTimesMs: [Date.now() - analyzeStart],
		},
		isAudioSource,
	);

	return { success: true, message: "AI generation completed successfully" };
}

const PHASE_LABELS: Record<PipelinePhaseKey, string> = {
	audio: "Audio tayyorlash",
	transcribe: "Transkripsiya",
	analyze: "AI tahlil",
	index: "AI indekslash",
};

// Mirrors the transcribe workflow's real execution order so a fresh init (e.g.
// if AI is retried independently) produces the same unified 4-phase shape.
const PHASE_ORDER: PipelinePhaseKey[] = [
	"audio",
	"transcribe",
	"index",
	"analyze",
];

function initialPhases(isAudioSource = false): PipelinePhase[] {
	const keys = isAudioSource
		? (["transcribe", "index", "analyze"] as PipelinePhaseKey[])
		: PHASE_ORDER;
	return keys.map((key) => ({
		key,
		label: PHASE_LABELS[key],
		status: "queued" as const,
		done: 0,
		total: key === "analyze" ? 1 : 0,
	}));
}

/**
 * Read-modify-write a single phase entry inside metadata.pipelineProgress. The
 * analyze workflow advances only its own phase; the array is shared with the
 * transcribe workflow via the metadata JSON (no DB column, no migration).
 */
async function patchPipelinePhase(
	videoId: string,
	phaseKey: PipelinePhaseKey,
	patch: Partial<Omit<PipelinePhase, "key" | "label">>,
	isAudioSource = false,
): Promise<void> {
	const current = await getCurrentVideoMetadata(videoId, {});
	const now = new Date().toISOString();

	const existing = current.pipelineProgress;
	const base: PipelineProgress = existing ?? {
		currentPhase: phaseKey,
		phases: initialPhases(isAudioSource),
		startedAt: now,
		updatedAt: now,
	};

	const phases = base.phases.map((p) =>
		p.key === phaseKey ? { ...p, ...patch } : p,
	);

	const next: PipelineProgress = {
		...base,
		phases,
		currentPhase: phaseKey,
		updatedAt: now,
	};

	await db()
		.update(videos)
		.set({ metadata: { ...current, pipelineProgress: next } })
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function validateAndSetProcessing(
	videoId: string,
	force = false,
): Promise<VideoData> {
	"use step";

	if (!serverEnv().GEMINI_API_KEY) {
		throw new FatalError("Missing GEMINI_API_KEY");
	}

	const query = await db()
		.select({ video: videos, orgSettings: organizations.settings })
		.from(videos)
		.leftJoin(organizations, eq(videos.orgId, organizations.id))
		.where(eq(videos.id, videoId as Video.VideoId));

	if (query.length === 0 || !query[0]?.video) {
		throw new FatalError("Video does not exist");
	}

	const { video } = query[0];
	const metadata = (video.metadata as VideoMetadata) || {};

	if (video.transcriptionStatus !== "COMPLETE") {
		throw new FatalError("Transcription not complete");
	}

	// force bypasses this guard — a re-transcription intentionally regenerates the
	// summary/chapters. Without threading force here, a forced regen set QUEUED,
	// triggered this workflow, then died on this throw and stranded the job.
	if (!force && metadata.summary && metadata.chapters) {
		throw new FatalError("AI metadata already generated");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...metadata,
				aiGenerationStatus: "PROCESSING",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));

	return {
		video,
		metadata,
		aiGenerationLanguage: parseAiGenerationLanguage(
			query[0]?.orgSettings?.aiGenerationLanguage,
		),
	};
}

async function fetchTranscript(
	videoId: string,
	userId: string,
	video: typeof videos.$inferSelect,
): Promise<TranscriptData | null> {
	"use step";

	const vtt = await Effect.gen(function* () {
		const [bucket] = yield* Storage.getAccessForVideo(
			decodeStorageVideo(video),
		);
		return yield* bucket.getObject(`${userId}/${videoId}/transcription.vtt`);
	}).pipe(runPromise);

	if (Option.isNone(vtt)) {
		return null;
	}

	const segments = parseVttWithTimestamps(vtt.value);
	const text = segments
		.map((s) => s.text)
		.join(" ")
		.trim();

	if (text.length < 10) {
		return null;
	}

	return { segments, text };
}

async function markSkipped(
	videoId: string,
	metadata: VideoMetadata,
): Promise<void> {
	"use step";

	const currentMetadata = await getCurrentVideoMetadata(videoId, metadata);

	await db()
		.update(videos)
		.set({
			metadata: {
				...currentMetadata,
				aiGenerationStatus: "SKIPPED",
			},
		})
		.where(eq(videos.id, videoId as Video.VideoId));
}

async function generateWithAi(
	transcript: TranscriptData,
	language: AiGenerationLanguage,
	videoDurationSec: number | null,
	videoId: string,
	meetingDate: string,
): Promise<AiResult> {
	"use step";

	const chunks = chunkTranscriptWithTimestamps(transcript.segments);

	let videoDuration: number;
	if (
		videoDurationSec != null &&
		Number.isFinite(videoDurationSec) &&
		videoDurationSec > 0
	) {
		videoDuration = videoDurationSec;
	} else {
		const fallback = getVideoDuration(transcript.segments);
		console.warn(
			`[CAP-AI] video.duration missing for ${videoId}, falling back to transcript-derived duration=${fallback}s`,
		);
		videoDuration = fallback;
	}

	console.info(
		`[CAP-AI] starting AI gen for video=${videoId}, duration=${videoDuration} sec, transcriptCues=${transcript.segments.length}`,
	);
	console.info(
		`[CAP-AI] path=${chunks.length === 1 ? "short" : "long"}, chunks=${chunks.length}`,
	);

	const languageInstruction = getAiLanguageInstruction(language);

	let result: AiResult;
	if (chunks.length === 1) {
		result = await generateSingleChunk(
			transcript.segments,
			videoDuration,
			languageInstruction,
			meetingDate,
		);
	} else {
		result = await generateMultipleChunks(
			chunks,
			transcript.segments,
			videoDuration,
			languageInstruction,
			meetingDate,
		);
	}

	if (result.chapters) {
		result.chapters = clampChapters(result.chapters, videoDuration);
	}

	// Clamp aiSummary.chapters and refinedTranscript.chapters to real duration
	if (result.aiSummary) {
		const beforeChapters = result.aiSummary.chapters.length;
		result.aiSummary.chapters = result.aiSummary.chapters.filter(
			(ch) => ch.startSec >= 0 && ch.startSec <= videoDuration,
		);
		if (result.aiSummary.chapters.length !== beforeChapters) {
			console.warn(
				`[CAP-AI] clamped aiSummary.chapters: ${beforeChapters} -> ${result.aiSummary.chapters.length} (duration=${videoDuration}s)`,
			);
		}
		const refined = result.aiSummary.refinedTranscript;
		if (refined?.chapters) {
			const beforeRefined = refined.chapters.length;
			refined.chapters = refined.chapters.filter(
				(ch) => ch.startSec >= 0 && ch.startSec <= videoDuration,
			);
			if (refined.chapters.length !== beforeRefined) {
				console.warn(
					`[CAP-AI] clamped refinedTranscript.chapters: ${beforeRefined} -> ${refined.chapters.length} (duration=${videoDuration}s)`,
				);
			}
		}

		const introCount =
			result.aiSummary.refinedTranscript?.intro?.participants?.length ?? 0;
		if (!result.aiSummary.refinedTranscript?.intro) {
			console.warn(
				`[CAP-AI] missing refinedTranscript.intro for video=${videoId}`,
			);
		}
		console.info(
			`[CAP-AI] final AI output: tasks=${result.aiSummary.tasks.length}, topics=${result.aiSummary.topics.length}, refined.chapters=${result.aiSummary.refinedTranscript?.chapters.length ?? 0}, intro.participants=${introCount}`,
		);
	}

	if (!result.aiSummary) {
		throw new Error("[CAP-AI] AI generation produced no parseable summary");
	}

	return result;
}

export function getAiLanguageInstruction(
	language: AiGenerationLanguage,
): string {
	if (language === AI_GENERATION_LANGUAGE_AUTO) {
		return "Write the title, summary, chapter titles, section summaries, and key points in the same language as the transcript.";
	}

	return `Write the title, summary, chapter titles, section summaries, and key points in ${getAiGenerationLanguageName(language)}.`;
}

function getVideoDuration(segments: VttSegment[]): number {
	if (segments.length === 0) return 0;
	const lastSegment = segments[segments.length - 1];
	return lastSegment ? lastSegment.start + 3 : 0;
}

function clampChapters(
	chapters: { title: string; start: number }[],
	videoDuration: number,
): { title: string; start: number }[] {
	const filtered = chapters.filter((ch) => ch.start < videoDuration);

	if (filtered.length === 0 && chapters.length > 0) {
		const first = chapters[0];
		return first ? [{ title: first.title, start: 0 }] : [];
	}

	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	const deduped: { title: string; start: number }[] = [];
	for (const chapter of filtered) {
		const last = deduped[deduped.length - 1];
		if (!last || Math.abs(chapter.start - last.start) >= minGap) {
			deduped.push(chapter);
		}
	}

	return deduped;
}

async function saveResults(
	videoId: string,
	videoData: VideoData,
	result: AiResult,
): Promise<void> {
	"use step";

	const { video, metadata } = videoData;
	const generatedTitle = result.title?.trim();
	const currentVideo = await getCurrentVideo(videoId);
	const currentMetadata = currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: metadata;
	const currentTitle = currentVideo?.name ?? video.name;

	const updatedMetadata: VideoMetadata = {
		...currentMetadata,
		aiTitle: generatedTitle || currentMetadata.aiTitle,
		summary: result.summary || currentMetadata.summary,
		chapters: result.chapters || currentMetadata.chapters,
		aiSummary: result.aiSummary ?? currentMetadata.aiSummary,
		aiGenerationStatus: "COMPLETE",
	};

	await db()
		.update(videos)
		.set({ metadata: updatedMetadata })
		.where(eq(videos.id, videoId as Video.VideoId));

	if (
		generatedTitle &&
		shouldReplaceVideoTitle({
			currentTitle,
			previousAiTitle: currentMetadata.aiTitle,
			nextAiTitle: generatedTitle,
			sourceName: currentMetadata.sourceName,
			titleManuallyEdited: currentMetadata.titleManuallyEdited,
		})
	) {
		await db()
			.update(videos)
			.set({ name: generatedTitle })
			.where(
				and(
					eq(videos.id, videoId as Video.VideoId),
					eq(videos.name, currentTitle),
				),
			);
	}
}

async function getCurrentVideo(
	videoId: string,
): Promise<typeof videos.$inferSelect | null> {
	const [currentVideo] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId as Video.VideoId));

	return currentVideo ?? null;
}

async function getCurrentVideoMetadata(
	videoId: string,
	fallback: VideoMetadata,
): Promise<VideoMetadata> {
	const currentVideo = await getCurrentVideo(videoId);
	return currentVideo
		? (currentVideo.metadata as VideoMetadata) || {}
		: fallback;
}

function parseVttWithTimestamps(vttContent: string): VttSegment[] {
	const lines = vttContent.split("\n");
	const segments: VttSegment[] = [];
	let currentStart = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]?.trim() ?? "";
		if (line.includes("-->")) {
			const timeMatch = line.match(/(\d{2}):(\d{2}):(\d{2})[.,](\d{3})/);
			if (timeMatch) {
				currentStart =
					parseInt(timeMatch[1] ?? "0", 10) * 3600 +
					parseInt(timeMatch[2] ?? "0", 10) * 60 +
					parseInt(timeMatch[3] ?? "0", 10);
			}
		} else if (
			line &&
			line !== "WEBVTT" &&
			!/^\d+$/.test(line) &&
			!line.includes("-->")
		) {
			segments.push({ start: currentStart, text: line });
		}
	}

	return segments;
}

function chunkTranscriptWithTimestamps(
	segments: VttSegment[],
): { text: string; startTime: number; endTime: number }[] {
	const chunks: { text: string; startTime: number; endTime: number }[] = [];
	let currentChunk: VttSegment[] = [];
	let currentLength = 0;

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			currentChunk.length > 0
		) {
			chunks.push({
				text: currentChunk.map((s) => s.text).join(" "),
				startTime: currentChunk[0]?.start ?? 0,
				endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
			});
			currentChunk = [];
			currentLength = 0;
		}
		currentChunk.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (currentChunk.length > 0) {
		chunks.push({
			text: currentChunk.map((s) => s.text).join(" "),
			startTime: currentChunk[0]?.start ?? 0,
			endTime: currentChunk[currentChunk.length - 1]?.start ?? 0,
		});
	}

	return chunks;
}

const GEMINI_SUMMARY_MODEL =
	process.env.GEMINI_SUMMARY_MODEL ?? "gemini-3-flash-preview";
// Preview models (e.g. gemini-3-flash-preview) intermittently return HTTP 503
// "high demand" — observed failing 5/5 times during an outage while the stable
// model answered first try. Fall back to a stable model so summary generation
// keeps working when the preview is overloaded. Set empty to disable.
const GEMINI_SUMMARY_FALLBACK_MODEL =
	process.env.GEMINI_SUMMARY_FALLBACK_MODEL ?? "gemini-2.5-flash";
const GEMINI_SUMMARY_MAX_RETRIES = Number(
	process.env.GEMINI_SUMMARY_MAX_RETRIES ?? "2",
);
const SUMMARY_BACKOFF_MS = [2000, 5000, 12000];

function isTransientAiError(status: number, msg: string): boolean {
	if (status === 429 || status === 503) return true;
	const lower = msg.toLowerCase();
	return (
		lower.includes("high demand") ||
		lower.includes("overloaded") ||
		lower.includes("unavailable")
	);
}

interface AiApiResult {
	content: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
}

/**
 * fetch with a hard timeout via AbortController. Without this, a Gemini API
 * call can hang indefinitely (mirrors the transcription-side fix in
 * gemini-transcribe.ts). Any non-response within the timeout throws, which
 * lets the existing markAiError path surface a real failure.
 */
async function aiFetchWithTimeout(
	url: string,
	init: RequestInit & { timeoutMs?: number } = {},
): Promise<Response> {
	const { timeoutMs = 5 * 60_000, ...rest } = init;
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		return await fetch(url, { ...rest, signal: ctrl.signal });
	} catch (err) {
		if ((err as { name?: string })?.name === "AbortError") {
			throw new Error(
				`Gemini AI request timed out after ${Math.round(timeoutMs / 1000)}s`,
			);
		}
		throw err;
	} finally {
		clearTimeout(timer);
	}
}

async function callAiApi(prompt: string): Promise<AiApiResult> {
	const apiKey = serverEnv().GEMINI_API_KEY;
	if (!apiKey) {
		console.warn("[generate-ai] GEMINI_API_KEY not set, skipping AI call");
		return { content: "{}", model: "unknown", inputTokens: 0, outputTokens: 0 };
	}

	const models =
		GEMINI_SUMMARY_FALLBACK_MODEL &&
		GEMINI_SUMMARY_FALLBACK_MODEL !== GEMINI_SUMMARY_MODEL
			? [GEMINI_SUMMARY_MODEL, GEMINI_SUMMARY_FALLBACK_MODEL]
			: [GEMINI_SUMMARY_MODEL];

	let lastError = "";

	for (const model of models) {
		const maxAttempts =
			model === GEMINI_SUMMARY_MODEL ? GEMINI_SUMMARY_MAX_RETRIES + 1 : 1;

		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			if (attempt > 0) {
				await new Promise<void>((r) =>
					setTimeout(
						r,
						SUMMARY_BACKOFF_MS[
							Math.min(attempt - 1, SUMMARY_BACKOFF_MS.length - 1)
						] ?? 12_000,
					),
				);
			}

			let res: Response;
			try {
				res = await aiFetchWithTimeout(
					`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
					{
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							contents: [{ parts: [{ text: prompt }] }],
							generationConfig: {
								temperature: 0.2,
								// The summary JSON bundles overview + topics + tasks + chapters
								// + the whole refined transcript; 8192 truncated on real
								// meetings (invalid JSON → "no parseable summary"). Give it room.
								maxOutputTokens: 65536,
							},
						}),
						timeoutMs: 5 * 60_000,
					},
				);
			} catch (err) {
				lastError = (err as Error).message ?? "fetch error";
				console.warn(`[generate-ai] ${model} fetch error: ${lastError}`);
				continue;
			}

			const data = (await res.json()) as {
				candidates?: Array<{
					content: { parts: Array<{ text?: string }> };
					finishReason?: string;
				}>;
				usageMetadata?: GeminiUsageMetadata;
				error?: { message: string };
			};

			if (res.ok) {
				if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
					console.warn(
						"[generate-ai] Gemini response hit MAX_TOKENS — JSON may be truncated.",
					);
				}
				if (model !== GEMINI_SUMMARY_MODEL) {
					console.log(`[generate-ai] fell back to ${model} for summary`);
				}
				return {
					content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}",
					model,
					inputTokens: billedInputTokens(data.usageMetadata),
					// Thinking stays enabled here — summarising, grouping tasks and
					// distilling the transcript are genuine reasoning — but it is billed
					// at the output rate, so it must be counted as output.
					outputTokens: billedOutputTokens(data.usageMetadata),
				};
			}

			lastError = data.error?.message ?? String(res.status);

			if (res.status === 401 || res.status === 403) {
				throw new Error(`Gemini auth error: ${lastError}`);
			}
			if (isTransientAiError(res.status, lastError)) {
				console.warn(
					`[generate-ai] transient error from ${model} (attempt ${attempt + 1}/${maxAttempts}): ${lastError}`,
				);
				continue;
			}
			// Non-transient error: stop retrying this model, try the fallback.
			break;
		}
	}

	throw new Error(
		`Gemini generateContent failed after retries/fallback: ${lastError}`,
	);
}

function cleanJsonResponse(content: string): string {
	if (content.includes("```json")) {
		return content.replace(/```json\s*/g, "").replace(/```\s*/g, "");
	}
	if (content.includes("```")) {
		return content.replace(/```\s*/g, "");
	}
	return content;
}

export const MASTER_SCHEMA_EXAMPLE = `{
  "title": "Weekly Team Sync",
  "summary": "The team discussed Q3 roadmap priorities and resolved the deployment blocker.",
  "chapters": [{"title": "Intro", "start": 0}],
  "aiSummary": {
    "overview": "**The team locked Q3 priorities and cleared the deployment blocker.**\\n\\n### Asosiy qarorlar\\n- **Ship the billing rewrite** before the **CRM** migration\\n- Freeze new features for two weeks to pay down bugs\\n\\n### Muhim nuqtalar\\n- Signups up **18%** month-over-month\\n- Deployment blocker was a stale cache config\\n\\n### Ochiq masalalar\\n- Who owns the data migration is still undecided",
    "topics": [{"title": "Q3 Roadmap", "body": "Aligned on **three priorities**; billing rewrite goes first."}],
    "nextSteps": ["Share updated roadmap doc by Friday"],
    "tasks": [{"title": "Update the roadmap doc", "category": "Roadmap", "assignee": "Alice", "priority": "high", "deadline": "", "done": false}, {"title": "Find an owner for the data migration", "category": "Migration", "assignee": "Unassigned", "priority": "medium", "deadline": "", "done": false}],
    "chapters": [{"startSec": 0, "title": "Intro", "body": "Brief intro and agenda."}, {"startSec": 45, "title": "Q3 Roadmap", "body": "Discussion of top priorities."}],
    "refinedTranscript": {
      "intro": {
        "participants": ["Alice", "Bob"],
        "duration": "21 daqiqa 30 soniya",
        "purpose": "Discuss Q3 roadmap and unblock deployment."
      },
      "chapters": [{"startSec": 0, "title": "Roadmap", "paragraphs": ["Alice opened by confirming the **billing rewrite** ships before the **CRM** migration. Bob flagged that the data migration still has no owner."]}]
    }
  }
}`;

function formatTimestampsForPrompt(segments: VttSegment[]): string {
	return segments
		.map(
			(s) =>
				`[${Math.floor(s.start / 60)}:${String(Math.floor(s.start % 60)).padStart(2, "0")}] ${s.text}`,
		)
		.join("\n");
}

export function buildMasterPrompt(
	videoDuration: number,
	transcriptWithTimestamps: string,
	languageInstruction: string,
	meetingDate: string,
): string {
	return `You are an expert meeting analyst. From the timestamped transcript below,
produce ONE JSON object with this exact structure (keep property names exactly):
${MASTER_SCHEMA_EXAMPLE}

This meeting took place on ${meetingDate}. Any relative date spoken in the audio
("next Friday", "end of the month", "in two weeks") must be resolved against THAT
date. You have no other knowledge of the current date — never assume one, and never
emit a deadline whose year you did not derive from ${meetingDate} or hear spoken.

${languageInstruction}

LANGUAGE & FORMATTING RULES (apply to every text field you output):
- Write Uzbek words only in Uzbek Latin — never Cyrillic.
- Russian words stay in Cyrillic and bold: **сразу**, **дефицит**.
- English words stay in Latin and bold: **deadline**, **CRM**, **dashboard**.
- Do not translate or transliterate foreign words. Bold every foreign word/phrase.
- If a word was unclear in the source, keep [noaniq]. Never invent facts, names, numbers, or dates.
- Respond in the same language as the transcript.

Several fields accept Markdown and are rendered richly (like a Notion doc): use
**bold** for key terms/decisions/names/numbers, *italic* for emphasis, "- " bullet
lists, nested bullets (indent 2 spaces), and "### " subheadings where noted. Keep
Markdown out of the fields marked PLAIN.

A) overview — the SUMMARY, written as a rich Markdown document. Make it genuinely
   useful to someone who missed the meeting. Structure it EXACTLY like this:
   - First line: a one-sentence **bold TL;DR** of the meeting's outcome.
   - Then "### Asosiy qarorlar" (Key decisions) — a bullet list of decisions actually
     made, each with the concrete detail (**bold** the decision, include numbers/dates).
   - Then "### Muhim nuqtalar" (Highlights) — a bullet list of the most important
     points, findings, or numbers discussed.
   - Then "### Ochiq masalalar" (Open questions / risks) — a bullet list of unresolved
     issues, blockers, or risks raised. Omit this section if there are none.
   Use only what was actually said. If a section has no real content, omit it entirely.

B) topics[] — each major theme as {title, body}. PLAIN title. body = 1-2 tight
   sentences (bold/italic allowed, no lists) capturing the concrete substance —
   decisions, numbers, names. 3-8 topics, in the order they arose.

C) nextSteps[] — PLAIN one-line follow-ups that are agreed but not owned by a specific
   person ("Share roadmap by Friday"). Bold/italic allowed, no lists. Keep each to one line.

D) tasks[] — concrete, OWNED action items. Extract only real commitments; never fabricate.

   BE EXHAUSTIVE. Sweep the WHOLE transcript end to end and capture EVERY commitment,
   not just the memorable ones. A commitment is anything someone said they would do,
   send, check, prepare, decide, or follow up on — including ones stated in passing, and
   including obligations that fall on the other party. A substantive meeting normally
   yields 5-15 tasks; if you have found only two or three, you have missed some — go back
   through the transcript and look again. (Do NOT pad with invented work to hit a number:
   if a commitment was genuinely never made, it does not exist.)

   Group them by CONTEXT: pick the ONE grouping axis that makes the tasks most useful —
   by workstream/category ("Audit", "Sales", "Backend"), by stage/phase ("This week",
   "Before launch"), or by person. Use that SAME axis for every task via "category".

   The category must be a GROUPING, not a restatement of another field. If your category
   is just the assignee's name repeated, you have chosen the wrong axis — a grouping that
   duplicates "assignee" adds nothing. Prefer workstream or stage unless the meeting is
   genuinely organised around who does what.

   For each task:
       title    = PLAIN imperative action ("Update the CRM pipeline"). Bold/italic allowed, one line.
       category = the group label on your chosen axis. NOT a copy of assignee.
       assignee = the person responsible as named in the audio; if nobody is named, "Unassigned".
       priority = high | medium | low, judged from urgency/impact cues.
       deadline = ISO date (YYYY-MM-DD) ONLY if a concrete date was spoken, or is
                  unambiguously derivable from the meeting date given above. Otherwise "".
                  NEVER guess a date, and never invent a year. An empty deadline is
                  always correct; a fabricated one is a lie the user will act on.
       done     = false (unless the transcript says it was already completed).

E) refinedTranscript — the meeting distilled to only what matters. This is gold-panning:
   swirl away the water, keep the gold.
   - refinedTranscript.intro: {
       participants: string[],   // names spoken in the audio; if none, []
       duration: string,         // a human phrase like "21 daqiqa 30 soniya"
       purpose: string           // 1-2 sentence statement of the meeting's purpose
     }
   - refinedTranscript.chapters: array of {startSec, title, paragraphs[]} in chronological order.
     * startSec: a number from the transcript's timestamps.
     * title: short descriptive section title.
     * paragraphs: clean Markdown prose covering that section. AGGRESSIVELY remove greetings,
       small talk, filler ("umm", "yani", "aa"), stutters, false starts, repetitions, thinking-
       out-loud, and off-topic tangents. Keep ONLY sentences that carry real meaning about the
       topic: decisions, facts, numbers, arguments, questions, and commitments. Rewrite into
       polished, readable minutes — flowing prose, not raw cue lines. **Bold** the key points.
       Attribute speakers inline only when it changes the meaning ("Aziz:" style). Cover the
       ENTIRE meeting, but a 30-minute meeting should distil to a few tight paragraphs, not a
       wall of text. If a whole stretch was only small talk, collapse it to one short sentence.

F) chapters[] — VIDEO TIMELINE markers {startSec, title, body}. PLAIN.
   - One per topic shift, startSec between 0 and ${videoDuration} (the REAL video duration).
   - These drive the segmented progress bar; align them with the refinedTranscript chapters.

Rules:
- All startSec/start values between 0 and ${videoDuration}, derived from the timestamps — never invented.
- Return ONLY the JSON object, no code fences, no commentary. Markdown is allowed INSIDE
  string values as described, but the top-level output must be valid JSON.

Transcript:
${transcriptWithTimestamps}`;
}

async function generateSingleChunk(
	segments: VttSegment[],
	videoDuration: number,
	languageInstruction: string,
	meetingDate: string,
): Promise<AiResult> {
	const transcriptWithTimestamps = formatTimestampsForPrompt(segments);
	const prompt = buildMasterPrompt(
		videoDuration,
		transcriptWithTimestamps,
		languageInstruction,
		meetingDate,
	);

	const apiResult = await callAiApi(prompt);
	const parsed = parseAiResponse(apiResult.content);
	return {
		...parsed,
		_usage: {
			model: apiResult.model,
			inputTokens: apiResult.inputTokens,
			outputTokens: apiResult.outputTokens,
		},
	};
}

interface ChunkSegments {
	segments: VttSegment[];
	startTime: number;
	endTime: number;
}

function chunkSegmentsForRefine(segments: VttSegment[]): ChunkSegments[] {
	const result: ChunkSegments[] = [];
	let current: VttSegment[] = [];
	let currentLength = 0;

	for (const segment of segments) {
		if (
			currentLength + segment.text.length > MAX_CHARS_PER_CHUNK &&
			current.length > 0
		) {
			result.push({
				segments: current,
				startTime: current[0]?.start ?? 0,
				endTime: current[current.length - 1]?.start ?? 0,
			});
			current = [];
			currentLength = 0;
		}
		current.push(segment);
		currentLength += segment.text.length + 1;
	}

	if (current.length > 0) {
		result.push({
			segments: current,
			startTime: current[0]?.start ?? 0,
			endTime: current[current.length - 1]?.start ?? 0,
		});
	}

	return result;
}

async function refineChunkToChapters(
	chunk: ChunkSegments,
	chunkIndex: number,
	totalChunks: number,
	videoDuration: number,
	languageInstruction: string,
): Promise<{
	chapters: { startSec: number; title: string; paragraphs: string[] }[];
	inputTokens: number;
	outputTokens: number;
	model: string;
}> {
	const transcriptWithTimestamps = formatTimestampsForPrompt(chunk.segments);

	const prompt = `You are a professional Uzbek meeting analyst refining a section of a long meeting transcript.
This is section ${chunkIndex + 1} of ${totalChunks}, covering seconds ${chunk.startTime}–${chunk.endTime}
of a video that is ${videoDuration} seconds long.

Produce ONE JSON object with this exact shape:
{
  "chapters": [
    { "startSec": <number between ${chunk.startTime} and ${chunk.endTime}>,
      "title": "<short descriptive section title>",
      "paragraphs": ["<clean prose paragraph>", "<another>"] }
  ]
}

${languageInstruction}

LANGUAGE & FORMATTING RULES (apply to every text field):
- Write Uzbek words only in Uzbek Latin — never Cyrillic.
- Russian words stay in Cyrillic and bold: **сразу**, **дефицит**.
- English words stay in Latin and bold: **deadline**, **CRM**, **dashboard**.
- Do not translate or transliterate foreign words. Bold every foreign word/phrase.
- If a word was unclear in the source, keep [noaniq]. Never invent facts, names, numbers, or dates.
- Respond in the same language as the transcript.

Rules for chapters (this is gold-panning — swirl away the water, keep the gold):
- Break this section into 1-4 topical chapters in chronological order.
- paragraphs are Markdown prose. AGGRESSIVELY remove greetings, small talk, filler
  ("umm", "yani", "aa"), stutters, false starts, repetitions, thinking-out-loud, and
  off-topic tangents. Keep ONLY sentences that carry real meaning about the topic:
  decisions, facts, numbers, arguments, questions, commitments. **Bold** the key points.
- Rewrite into polished, readable minutes — flowing prose, not raw cue lines. A long
  stretch of small talk should collapse to one short sentence (or be dropped).
- Attribute speakers inline only when it changes the meaning ("Aziz:" style).
- startSec must come from the actual timestamps and stay within [${chunk.startTime}, ${chunk.endTime}].
- Return ONLY the JSON object, no code fences. Markdown is allowed inside string values.

Transcript section:
${transcriptWithTimestamps}`;

	const apiResult = await callAiApi(prompt);
	try {
		const parsed = JSON.parse(cleanJsonResponse(apiResult.content).trim());
		const chapters = Array.isArray(parsed.chapters)
			? parsed.chapters
					.filter(
						(ch: { startSec?: number; title?: string; paragraphs?: unknown }) =>
							typeof ch.startSec === "number" &&
							typeof ch.title === "string" &&
							Array.isArray(ch.paragraphs),
					)
					.map(
						(ch: {
							startSec: number;
							title: string;
							paragraphs: string[];
						}) => ({
							startSec: ch.startSec,
							title: ch.title,
							paragraphs: ch.paragraphs.filter(
								(p: unknown): p is string => typeof p === "string",
							),
						}),
					)
			: [];

		const paragraphCount = chapters.reduce(
			(n: number, c: { paragraphs: string[] }) => n + c.paragraphs.length,
			0,
		);
		console.info(
			`[CAP-AI] per-chunk refine: chunk ${chunkIndex + 1}/${totalChunks} cues=${chunk.segments.length} → paragraphs=${paragraphCount}`,
		);

		return {
			chapters,
			inputTokens: apiResult.inputTokens,
			outputTokens: apiResult.outputTokens,
			model: apiResult.model,
		};
	} catch {
		console.warn(
			`[CAP-AI] per-chunk refine: chunk ${chunkIndex + 1}/${totalChunks} parse failed`,
		);
		return {
			chapters: [],
			inputTokens: apiResult.inputTokens,
			outputTokens: apiResult.outputTokens,
			model: apiResult.model,
		};
	}
}

async function generateMultipleChunks(
	chunks: { text: string; startTime: number; endTime: number }[],
	allSegments: VttSegment[],
	videoDuration: number,
	languageInstruction: string,
	meetingDate: string,
): Promise<AiResult> {
	const chunkSummaries: {
		summary: string;
		keyPoints: string[];
		chapters: { title: string; start: number }[];
		startTime: number;
		endTime: number;
	}[] = [];

	let totalInputTokens = 0;
	let totalOutputTokens = 0;
	let usedModel = "unknown";

	// ---------- PIPELINE A: per-chunk section summaries ----------
	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		if (!chunk) continue;

		const chunkPrompt = `You are Cap AI, an expert at analyzing video content. This is section ${i + 1} of ${chunks.length} from a video that is ${videoDuration} seconds long (${Math.floor(videoDuration / 60)}:${String(Math.floor(videoDuration % 60)).padStart(2, "0")} total). This section covers timestamp ${Math.floor(chunk.startTime / 60)}:${String(Math.floor(chunk.startTime % 60)).padStart(2, "0")} to ${Math.floor(chunk.endTime / 60)}:${String(Math.floor(chunk.endTime % 60)).padStart(2, "0")}.

Analyze this section thoroughly and provide JSON:
{
  "summary": "string (detailed summary of this section - capture ALL key points, topics discussed, decisions made, or concepts explained. Include specific details like names, numbers, action items, and conclusions. 3-6 sentences minimum.)",
  "keyPoints": ["string (specific key point or takeaway)", ...],
  "chapters": [{"title": "string (descriptive title for this topic/section)", "start": number (seconds from video start)}]
}

${languageInstruction}
Keep JSON property names exactly as shown.
IMPORTANT: All chapter "start" values MUST be between ${chunk.startTime} and ${chunk.endTime} seconds. The total video is only ${videoDuration} seconds long.
Return ONLY valid JSON without any markdown formatting or code blocks.
Transcript section:
${chunk.text}`;

		const chunkResult = await callAiApi(chunkPrompt);
		totalInputTokens += chunkResult.inputTokens;
		totalOutputTokens += chunkResult.outputTokens;
		usedModel = chunkResult.model;
		try {
			const parsed = JSON.parse(cleanJsonResponse(chunkResult.content).trim());
			chunkSummaries.push({
				summary: parsed.summary || "",
				keyPoints: parsed.keyPoints || [],
				chapters: parsed.chapters || [],
				startTime: chunk.startTime,
				endTime: chunk.endTime,
			});
		} catch {}
	}

	const allChapters: { title: string; start: number }[] = [];
	const sortedChapters = chunkSummaries
		.flatMap((c) => c.chapters)
		.sort((a, b) => a.start - b.start);
	const minGap = Math.max(5, Math.floor(videoDuration / 10));
	for (const chapter of sortedChapters) {
		const lastChapter = allChapters[allChapters.length - 1];
		if (!lastChapter || Math.abs(chapter.start - lastChapter.start) >= minGap) {
			allChapters.push(chapter);
		}
	}

	const allKeyPoints = chunkSummaries.flatMap((c) => c.keyPoints);

	const sectionDetails = chunkSummaries
		.map((c, i) => {
			const timeRange = `${Math.floor(c.startTime / 60)}:${String(Math.floor(c.startTime % 60)).padStart(2, "0")} - ${Math.floor(c.endTime / 60)}:${String(Math.floor(c.endTime % 60)).padStart(2, "0")}`;
			const keyPointsList =
				c.keyPoints.length > 0 ? `\nKey points: ${c.keyPoints.join("; ")}` : "";
			return `Section ${i + 1} (${timeRange}):\n${c.summary}${keyPointsList}`;
		})
		.join("\n\n");

	// Final master pass — overview/topics/nextSteps/tasks/chapters/refined.intro
	const finalPrompt = `You are a professional Uzbek meeting analyst. From these section analyses of a longer meeting (total duration ${videoDuration} seconds), produce ONE JSON object with this exact structure (keep property names exactly):
${MASTER_SCHEMA_EXAMPLE}

This meeting took place on ${meetingDate}. Resolve any relative date ("next Friday",
"end of the month") against THAT date. You have no other knowledge of the current
date — never assume one, and never emit a deadline whose year you did not derive
from ${meetingDate} or hear spoken.

${languageInstruction}

LANGUAGE & FORMATTING RULES (apply to every text field you output):
- Write Uzbek words only in Uzbek Latin — never Cyrillic.
- Russian words stay in Cyrillic and bold: **сразу**, **дефицит**.
- English words stay in Latin and bold: **deadline**, **CRM**, **dashboard**.
- Do not translate or transliterate foreign words. Bold every foreign word/phrase.
- If a word was unclear in the source, keep [noaniq]. Never invent facts, names, numbers, or dates.
- Respond in the same language as the section analyses.

Some fields accept Markdown and are rendered richly (like a Notion doc): use **bold**
for key terms/decisions/names/numbers, *italic* for emphasis, "- " bullet lists, nested
bullets, and "### " subheadings where noted. Keep Markdown out of fields marked PLAIN.

For this pass produce these fields:
- title: PLAIN short meeting title.
- summary: PLAIN 2-4 sentence executive summary.
- chapters: top-level timeline markers (legacy field — array of {title, start}) covering the whole video.
- aiSummary.overview: a rich Markdown document. First line = one-sentence **bold TL;DR**.
  Then "### Asosiy qarorlar" (Key decisions) as a bullet list; "### Muhim nuqtalar"
  (Highlights) as a bullet list; "### Ochiq masalalar" (Open questions/risks) as a bullet
  list. Bold the decisions/numbers. Omit any section that has no real content.
- aiSummary.topics[]: each major theme as {title, body}. PLAIN title. body = 1-2 tight
  sentences (bold/italic allowed, no lists) with concrete points, decisions, numbers, names.
  3-8 topics typical.
- aiSummary.nextSteps[]: PLAIN one-line follow-ups ("Share roadmap by Friday").
- aiSummary.tasks[]: concrete, owned action items. BE EXHAUSTIVE — sweep every section
  analysis and capture EVERY commitment anyone made, including ones stated in passing and
  obligations falling on the other party. A substantive meeting normally yields 5-15 tasks;
  if you have only two or three, you have missed some. Never pad with invented work.
  Group them by CONTEXT — pick the ONE axis (by workstream/category, by stage, or by person)
  that makes them most useful and use it for every task's "category". The category must be a
  GROUPING, not a restatement of "assignee": if your category is just the assignee's name
  repeated, you picked the wrong axis. For each:
    title    = PLAIN imperative action.
    category = the group label on your chosen axis. NOT a copy of assignee.
    assignee = the person responsible if named; otherwise "Unassigned".
    priority = high | medium | low.
    deadline = YYYY-MM-DD only if a date was spoken or is unambiguously derivable from the
               meeting date above; otherwise "". NEVER guess a date or invent a year. An
               empty deadline is always correct; a fabricated one is a lie the user acts on.
    done     = false (unless transcript says completed).
- aiSummary.chapters[]: {startSec, title, body} timeline markers, startSec in [0, ${videoDuration}].
- aiSummary.refinedTranscript.intro: {participants[], duration (human phrase), purpose (1-2 sentences)}.
- aiSummary.refinedTranscript.chapters: leave as [] in THIS pass — a separate pass produces them.

Return ONLY the JSON object, no code fences, no commentary. Markdown is allowed INSIDE
string values as described; the top-level output must be valid JSON.

Section analyses:
${sectionDetails}

${allKeyPoints.length > 0 ? `All key points identified:\n${allKeyPoints.map((p, i) => `${i + 1}. ${p}`).join("\n")}\n` : ""}`;

	const finalResult = await callAiApi(finalPrompt);
	totalInputTokens += finalResult.inputTokens;
	totalOutputTokens += finalResult.outputTokens;
	usedModel = finalResult.model;

	const parsedFinal = (() => {
		try {
			return JSON.parse(cleanJsonResponse(finalResult.content).trim()) as {
				title?: string;
				summary?: string;
				chapters?: { title: string; start: number }[];
				aiSummary?: unknown;
			};
		} catch {
			return null;
		}
	})();

	if (!parsedFinal) {
		throw new Error(
			"[CAP-AI] long-path final summary pass failed to parse JSON",
		);
	}

	// ---------- PIPELINE B: per-chunk refined transcript chapters ----------
	const refineChunks = chunkSegmentsForRefine(allSegments);
	const refinedChapters: {
		startSec: number;
		title: string;
		paragraphs: string[];
	}[] = [];

	for (let i = 0; i < refineChunks.length; i++) {
		const refineChunk = refineChunks[i];
		if (!refineChunk) continue;
		const res = await refineChunkToChapters(
			refineChunk,
			i,
			refineChunks.length,
			videoDuration,
			languageInstruction,
		);
		totalInputTokens += res.inputTokens;
		totalOutputTokens += res.outputTokens;
		usedModel = res.model;
		refinedChapters.push(...res.chapters);
	}

	// Sort chronologically and dedupe at min-gap
	refinedChapters.sort((a, b) => a.startSec - b.startSec);

	// Merge: take parsedFinal.aiSummary and overlay refinedTranscript.chapters
	const aiSummaryObj = (parsedFinal.aiSummary ?? {}) as {
		refinedTranscript?: {
			intro?: { participants: string[]; duration: string; purpose: string };
			chapters?: unknown[];
		};
	};

	const mergedAiSummary = {
		...(aiSummaryObj as Record<string, unknown>),
		refinedTranscript: {
			intro: aiSummaryObj.refinedTranscript?.intro,
			chapters: refinedChapters,
		},
	};

	return {
		title: parsedFinal.title,
		summary: parsedFinal.summary,
		chapters: allChapters,
		aiSummary: parseAiSummary(mergedAiSummary),
		_usage: {
			model: usedModel,
			inputTokens: totalInputTokens,
			outputTokens: totalOutputTokens,
		},
	};
}

async function recordSummaryUsage(
	orgId: string,
	userId: string,
	videoId: string,
	usage: { model: string; inputTokens: number; outputTokens: number },
): Promise<void> {
	"use step";

	const billingMonth = (() => {
		const now = new Date();
		return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
	})();
	const costUsdMicros = priceForMicros(
		usage.model,
		usage.inputTokens,
		usage.outputTokens,
	);
	await db()
		.insert(aiUsageEvents)
		.values({
			id: nanoId(),
			orgId: orgId as Organisation.OrganisationId,
			userId: userId as User.UserId,
			videoId: videoId as Video.VideoId,
			operation: "summary",
			model: usage.model,
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			costUsdMicros,
			billingMonth,
		});
}

function parseAiResponse(content: string): AiResult {
	try {
		const data = JSON.parse(cleanJsonResponse(content).trim());

		const chapters = Array.isArray(data.chapters)
			? data.chapters
					.filter(
						(ch: { start?: number }) =>
							typeof ch.start === "number" && ch.start >= 0,
					)
					.sort(
						(a: { start: number }, b: { start: number }) => a.start - b.start,
					)
			: [];

		return {
			title: data.title,
			summary: data.summary,
			chapters,
			aiSummary: parseAiSummary(data.aiSummary ?? null),
		};
	} catch {
		return {
			title: "Generated Title",
			summary:
				"The AI was unable to generate a proper summary for this content.",
			chapters: [],
			aiSummary: null,
		};
	}
}
