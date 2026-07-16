import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { AiSummary, VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import { Storage } from "@cap/web-backend";
import {
	type LanguageCode,
	SUPPORTED_LANGUAGES,
	type Video,
} from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Option } from "effect";
import { z } from "zod";
import { withCostGuard } from "@/lib/ai-cost-guard";
import { billedInputTokens, billedOutputTokens } from "@/lib/gemini-usage";
import {
	restoreRussianScript,
	restoreRussianScriptDeep,
} from "@/lib/restore-russian-script";
import { runPromise } from "@/lib/server";
import { decodeStorageVideo } from "@/lib/video-storage";

interface TranslateAiContentPayload {
	videoId: Video.VideoId;
	userId: string;
	language: LanguageCode;
}

/**
 * Shared instruction fragment: translate every text field faithfully without
 * summarising, and keep foreign/technical words + markdown bold markers intact
 * so a mixed-language meeting stays consistent after translation.
 */
function getTranslationLanguageInstruction(language: LanguageCode): string {
	return [
		`Translate ALL text fields into ${SUPPORTED_LANGUAGES[language]}.`,
		"Preserve the original meaning exactly — do not summarize, shorten, or add content.",
		"Keep proper nouns, product names, brand names, code identifiers, URLs and",
		"already-foreign technical terms exactly as written; translate only the",
		"ordinary surrounding prose.",
		"Preserve any existing markdown **bold** markers exactly, around the same words.",
	].join(" ");
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

const GEMINI_TRANSLATE_MODEL =
	process.env.GEMINI_TRANSLATE_MODEL ?? "gemini-2.5-flash";

interface AiCallContext {
	orgId: string;
	userId: string;
	videoId: string;
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

/**
 * Single Gemini JSON call, budget-guarded and usage-recorded via withCostGuard
 * (operation "translate"). Mirrors the request shape used by
 * workflows/generate-ai.ts `callAiApi`, but forces a JSON response and disables
 * thinking (translation is not a reasoning task).
 */
async function callGeminiJson(
	prompt: string,
	context: AiCallContext,
): Promise<string> {
	const apiKey = serverEnv().GEMINI_API_KEY;
	if (!apiKey) {
		throw new Error("Missing GEMINI_API_KEY");
	}

	const result = await withCostGuard({
		orgId: context.orgId,
		userId: context.userId,
		videoId: context.videoId,
		operation: "translate",
		model: GEMINI_TRANSLATE_MODEL,
		fn: async () => {
			const res = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TRANSLATE_MODEL}:generateContent?key=${apiKey}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						contents: [{ parts: [{ text: prompt }] }],
						generationConfig: {
							temperature: 0.2,
							maxOutputTokens: 65536,
							responseMimeType: "application/json",
							thinkingConfig: { thinkingBudget: 0 },
						},
					}),
				},
			);

			const data = (await res.json()) as {
				candidates?: Array<{
					content: { parts: Array<{ text?: string }> };
					finishReason?: string;
				}>;
				usageMetadata?: Parameters<typeof billedInputTokens>[0];
				error?: { message: string };
			};

			if (!res.ok) {
				throw new Error(
					`Gemini generateContent failed (HTTP ${res.status}): ${data.error?.message ?? "unknown"}`,
				);
			}

			if (data.candidates?.[0]?.finishReason === "MAX_TOKENS") {
				console.error(
					"[translate-ai] response TRUNCATED (MAX_TOKENS) - raise maxOutputTokens",
				);
			}

			return {
				content: data.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}",
				inputTokens: billedInputTokens(data.usageMetadata),
				outputTokens: billedOutputTokens(data.usageMetadata),
			};
		},
	});

	return result.content;
}

/**
 * Compact AiSummary shape used for the "everything except the heavy
 * refinedTranscript paragraphs" translation call. Chapter titles are included
 * here (cheap); paragraphs are translated separately in batches.
 */
const CompactAiSummarySchema = z.object({
	overview: z.string().default(""),
	topics: z
		.array(z.object({ title: z.string(), body: z.string() }))
		.default([]),
	nextSteps: z.array(z.string()).default([]),
	tasks: z
		.array(
			z.object({
				title: z.string(),
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
	refinedTranscriptChapterTitles: z.array(z.string()).default([]),
	refinedTranscriptIntroPurpose: z.string().default(""),
});

const CUE_BATCH_SIZE = 80;
const PARAGRAPH_BATCH_SIZE = 50;

/**
 * Translate a flat list of strings into the target language via Gemini,
 * chunked into batches of at most `batchSize` items per call so a single call
 * never risks MAX_TOKENS truncation. Each batch sends a numbered list and
 * expects exactly that many lines back, in order. Throws on count mismatch
 * (per batch). Returns the full in-order list across all batches.
 */
async function translateStringList(
	items: string[],
	language: LanguageCode,
	context: AiCallContext,
	batchSize: number,
): Promise<string[]> {
	if (items.length === 0) return [];

	const languageInstruction = getTranslationLanguageInstruction(language);
	const results: string[] = [];

	for (let offset = 0; offset < items.length; offset += batchSize) {
		const batch = items.slice(offset, offset + batchSize);
		const numbered = batch.map((text, i) => `${i + 1}. ${text}`).join("\n");

		const prompt = `You are translating text lines extracted from a video. ${languageInstruction}

Below is a numbered list of ${batch.length} lines, in order. Translate EACH line into the target language and return a JSON object with this exact shape:
{"lines": ["translated line 1", "translated line 2", ...]}

The "lines" array MUST contain exactly ${batch.length} entries, in the SAME order as the input. Do not merge, split, skip, or reorder lines.

Lines:
${numbered}`;

		const content = await callGeminiJson(prompt, context);
		const parsed = JSON.parse(cleanJsonResponse(content).trim()) as {
			lines?: unknown;
		};

		if (!Array.isArray(parsed.lines)) {
			throw new Error(
				"[translate-ai] batch translation response missing 'lines' array",
			);
		}
		if (parsed.lines.length !== batch.length) {
			throw new Error(
				`[translate-ai] batch translation count mismatch: expected ${batch.length}, got ${parsed.lines.length}`,
			);
		}
		results.push(
			...parsed.lines.map((l) => (typeof l === "string" ? l : String(l))),
		);
	}

	return results;
}

/**
 * Translate the AiSummary JSON shape into the target language. To avoid a
 * single Gemini call truncating on long (2h+) videos, this is split into:
 * 1) one call for the compact fields (overview/topics/nextSteps/tasks/chapters
 *    + refinedTranscript chapter titles + intro.purpose), and
 * 2) batched calls translating refinedTranscript.chapters[].paragraphs[]
 *    (flattened across all chapters, ~PARAGRAPH_BATCH_SIZE per call).
 * Numeric startSec values, task metadata, category and intro participants/
 * duration are always copied from the ORIGINAL summary, never trusted from
 * model output. Validates the reassembled result against AiSummarySchema.
 */
async function translateAiSummary(
	summary: AiSummary,
	language: LanguageCode,
	context: AiCallContext,
): Promise<AiSummary> {
	const languageInstruction = getTranslationLanguageInstruction(language);

	const compactInput = {
		overview: summary.overview,
		topics: summary.topics,
		nextSteps: summary.nextSteps,
		tasks: summary.tasks,
		chapters: summary.chapters,
		refinedTranscriptChapterTitles: summary.refinedTranscript.chapters.map(
			(c) => c.title,
		),
		refinedTranscriptIntroPurpose:
			summary.refinedTranscript.intro?.purpose ?? "",
	};

	const compactPrompt = `You are translating a structured video analysis JSON object. ${languageInstruction}

Rules:
- Do NOT change any numeric values (startSec, etc.) — copy them exactly as given.
- Do NOT change tasks[].assignee, tasks[].priority, tasks[].deadline, or tasks[].done — copy them exactly as given. Only translate tasks[].title.
- Translate: overview, every topics[].title and topics[].body, every nextSteps[] entry, every tasks[].title, every chapters[].title and chapters[].body, every refinedTranscriptChapterTitles[] entry, and refinedTranscriptIntroPurpose.
- Keep the exact same JSON structure and property names as the input.
- Return ONLY valid JSON, no markdown code fences, no explanations.

Input JSON:
${JSON.stringify(compactInput)}`;

	const compactContent = await callGeminiJson(compactPrompt, context);
	const compactParsed = JSON.parse(cleanJsonResponse(compactContent).trim());
	const compactResult = CompactAiSummarySchema.safeParse(compactParsed);
	if (!compactResult.success) {
		throw new Error(
			`[translate-ai] translated AiSummary (compact) failed validation: ${compactResult.error.message}`,
		);
	}
	const compact = compactResult.data;

	// Guard against SILENT LOSS: the model must return exactly as many items as
	// it was given. zod's `.default([])` would otherwise accept a truncated /
	// omitted array (e.g. the model drops tasks or chapters) and we'd cache a
	// translation that silently lost content the base summary still has.
	if (
		compact.topics.length !== summary.topics.length ||
		compact.nextSteps.length !== summary.nextSteps.length ||
		compact.tasks.length !== summary.tasks.length ||
		compact.chapters.length !== summary.chapters.length ||
		compact.refinedTranscriptChapterTitles.length !==
			summary.refinedTranscript.chapters.length
	) {
		throw new Error(
			`[translate-ai] compact translation count mismatch — refusing to cache lossy translation ` +
				`(topics ${compact.topics.length}/${summary.topics.length}, ` +
				`nextSteps ${compact.nextSteps.length}/${summary.nextSteps.length}, ` +
				`tasks ${compact.tasks.length}/${summary.tasks.length}, ` +
				`chapters ${compact.chapters.length}/${summary.chapters.length}, ` +
				`refinedTitles ${compact.refinedTranscriptChapterTitles.length}/${summary.refinedTranscript.chapters.length})`,
		);
	}

	// Flatten all paragraphs across all chapters into one ordered list,
	// translate in batches, then re-distribute back into chapter shape.
	const paragraphCounts = summary.refinedTranscript.chapters.map(
		(c) => c.paragraphs.length,
	);
	const flatParagraphs = summary.refinedTranscript.chapters.flatMap(
		(c) => c.paragraphs,
	);
	const translatedFlatParagraphs = await translateStringList(
		flatParagraphs,
		language,
		context,
		PARAGRAPH_BATCH_SIZE,
	);

	let cursor = 0;
	const translatedChapters = summary.refinedTranscript.chapters.map(
		(originalChapter, i) => {
			const count = paragraphCounts[i] ?? 0;
			const paragraphs = translatedFlatParagraphs.slice(cursor, cursor + count);
			cursor += count;
			return {
				startSec: originalChapter.startSec,
				title:
					compact.refinedTranscriptChapterTitles[i] ?? originalChapter.title,
				paragraphs,
			};
		},
	);

	// category is language-neutral and not re-translated (the compact schema
	// omits it); carry it over from the base task at the same index. The count
	// mismatch guard above guarantees these arrays are the same length.
	const reassembled = {
		overview: compact.overview,
		topics: compact.topics,
		nextSteps: compact.nextSteps,
		tasks: compact.tasks.map((task, i) => ({
			...task,
			...(summary.tasks[i]?.category
				? { category: summary.tasks[i].category }
				: {}),
		})),
		chapters: compact.chapters.map((chapter, i) => ({
			...chapter,
			startSec: summary.chapters[i]?.startSec ?? chapter.startSec,
		})),
		refinedTranscript: {
			// intro participants/duration are language-neutral — copy from the base;
			// only the purpose sentence is translated.
			...(summary.refinedTranscript.intro
				? {
						intro: {
							...summary.refinedTranscript.intro,
							purpose:
								compact.refinedTranscriptIntroPurpose ||
								summary.refinedTranscript.intro.purpose,
						},
					}
				: {}),
			chapters: translatedChapters,
		},
	};

	const result = AiSummarySchema.safeParse(reassembled);
	if (!result.success) {
		throw new Error(
			`[translate-ai] reassembled translated AiSummary failed validation: ${result.error.message}`,
		);
	}
	// zod strips the optional `intro`; merge it back so it survives.
	return {
		...result.data,
		refinedTranscript: {
			...result.data.refinedTranscript,
			...(reassembled.refinedTranscript.intro
				? { intro: reassembled.refinedTranscript.intro }
				: {}),
		},
	};
}

export interface VttCue {
	start: string;
	end: string;
	text: string;
}

/**
 * Parse a WebVTT string into cues (timestamp pair + text). Pure helper,
 * unit-testable. Assumes standard "HH:MM:SS.mmm --> HH:MM:SS.mmm" cue blocks
 * separated by blank lines.
 */
export function parseVttCues(vtt: string): VttCue[] {
	const lines = vtt.split(/\r?\n/);
	const cues: VttCue[] = [];

	let start: string | null = null;
	let end: string | null = null;
	let textLines: string[] = [];

	const flush = () => {
		if (start !== null && end !== null) {
			const text = textLines.join(" ").trim();
			if (text) cues.push({ start, end, text });
		}
		start = null;
		end = null;
		textLines = [];
	};

	for (const rawLine of lines) {
		const line = rawLine.trim();

		if (!line) {
			flush();
			continue;
		}

		if (/^WEBVTT/i.test(line)) continue;

		const rangeMatch = line.match(
			/^(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/,
		);
		if (rangeMatch) {
			flush();
			start = rangeMatch[1] ?? null;
			end = rangeMatch[2] ?? null;
			continue;
		}

		// Skip bare cue-index numbers.
		if (/^\d+$/.test(line) && start === null) continue;

		if (start !== null) {
			textLines.push(line);
		}
	}

	flush();
	return cues;
}

/**
 * Re-emit a valid WebVTT document from parsed cues, substituting each cue's
 * text with the corresponding entry in translatedTexts (same order, same
 * count). Timestamps are preserved exactly. Throws if the counts mismatch.
 */
export function buildVttFromCues(
	cues: VttCue[],
	translatedTexts: string[],
): string {
	if (cues.length !== translatedTexts.length) {
		throw new Error(
			`[translate-ai] cue count mismatch: ${cues.length} cues vs ${translatedTexts.length} translated texts`,
		);
	}

	let out = "WEBVTT\n\n";
	for (let i = 0; i < cues.length; i++) {
		const cue = cues[i];
		const text = translatedTexts[i];
		if (!cue) continue;
		out += `${cue.start} --> ${cue.end}\n${(text ?? "").trim()}\n\n`;
	}
	return out;
}

/**
 * Translate cue texts (only) into the target language. Batched into calls of
 * at most CUE_BATCH_SIZE cues each so a single Gemini call never risks
 * MAX_TOKENS truncation on long videos with hundreds/thousands of cues.
 */
async function translateVttCueTexts(
	cues: VttCue[],
	language: LanguageCode,
	context: AiCallContext,
): Promise<string[]> {
	return translateStringList(
		cues.map((c) => c.text),
		language,
		context,
		CUE_BATCH_SIZE,
	);
}

async function getCurrentVideoRow(videoId: Video.VideoId) {
	const [row] = await db().select().from(videos).where(eq(videos.id, videoId));
	return row ?? null;
}

/**
 * Read-modify-write a video's metadata JSON. Re-selects the current row each
 * call so it never clobbers a concurrent partial write of an unrelated field.
 */
async function patchVideoMetadata(
	videoId: Video.VideoId,
	patch: (current: VideoMetadata) => VideoMetadata,
): Promise<void> {
	const row = await getCurrentVideoRow(videoId);
	if (!row) return;
	const current = (row.metadata as VideoMetadata) || {};
	await db()
		.update(videos)
		.set({ metadata: patch(current) })
		.where(eq(videos.id, videoId));
}

/**
 * Translate a video's stored AI summary + transcript into `language` and cache
 * the result additively under `metadata.translations[language]`. Sets status
 * PROCESSING → COMPLETE (or ERROR). Intended to run in the background (the
 * endpoint schedules it via `after()`).
 */
export async function translateAiContent({
	videoId,
	userId,
	language,
}: TranslateAiContentPayload): Promise<void> {
	const video = await getCurrentVideoRow(videoId);
	if (!video) {
		throw new Error(`[translate-ai] video not found: ${videoId}`);
	}

	const metadata = (video.metadata as VideoMetadata) || {};
	const baseSummary = metadata.aiSummary;
	if (!baseSummary) {
		throw new Error(
			`[translate-ai] cannot translate: video ${videoId} has no base aiSummary`,
		);
	}

	const nowIso = new Date().toISOString();
	await patchVideoMetadata(videoId, (current) => ({
		...current,
		translations: {
			...current.translations,
			[language]: {
				...current.translations?.[language],
				status: "PROCESSING",
				requestedAt: current.translations?.[language]?.requestedAt ?? nowIso,
				updatedAt: nowIso,
			},
		},
	}));

	const context: AiCallContext = {
		orgId: video.orgId,
		userId,
		videoId,
	};

	try {
		const translatedSummary = restoreRussianScriptDeep(
			await translateAiSummary(baseSummary, language, context),
		);

		let captionsKey: string | undefined;

		const vttResult = await Effect.gen(function* () {
			const [bucket] = yield* Storage.getAccessForVideo(
				decodeStorageVideo(video),
			);
			return yield* bucket.getObject(
				`${video.ownerId}/${videoId}/transcription.vtt`,
			);
		}).pipe(runPromise);

		if (Option.isSome(vttResult)) {
			const cues = parseVttCues(vttResult.value);
			if (cues.length > 0) {
				const translatedTexts = (
					await translateVttCueTexts(cues, language, context)
				).map(restoreRussianScript);
				const translatedVtt = buildVttFromCues(cues, translatedTexts);
				const key = `${video.ownerId}/${videoId}/transcription.${language}.vtt`;

				await Effect.gen(function* () {
					const [bucket] = yield* Storage.getAccessForVideo(
						decodeStorageVideo(video),
					);
					yield* bucket.putObject(key, translatedVtt, {
						contentType: "text/vtt",
					});
				}).pipe(runPromise);

				captionsKey = key;
			}
		}

		const completedAt = new Date().toISOString();
		await patchVideoMetadata(videoId, (current) => ({
			...current,
			translations: {
				...current.translations,
				[language]: {
					...current.translations?.[language],
					status: "COMPLETE",
					aiSummary: translatedSummary,
					captionsKey,
					updatedAt: completedAt,
					error: undefined,
				},
			},
		}));
	} catch (error) {
		console.error(
			`[translate-ai] translation failed for video ${videoId} language ${language}:`,
			error,
		);
		const failedAt = new Date().toISOString();
		await patchVideoMetadata(videoId, (current) => ({
			...current,
			translations: {
				...current.translations,
				[language]: {
					...current.translations?.[language],
					status: "ERROR",
					updatedAt: failedAt,
					error: error instanceof Error ? error.message : String(error),
				},
			},
		}));
		throw error;
	}
}
