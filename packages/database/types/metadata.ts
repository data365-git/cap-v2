/**
 * Type definitions for JSON metadata fields
 */

import type { LanguageCode } from "@cap/web-domain";

export interface AiSummary {
	overview: string;
	topics: { title: string; body: string }[];
	nextSteps: string[];
	tasks: {
		title: string;
		/** Context group label (a person, workstream, or stage — the AI's chosen axis). */
		category?: string;
		assignee: string;
		priority: "high" | "medium" | "low";
		deadline: string;
		done: boolean;
	}[];
	chapters: { startSec: number; title: string; body: string }[];
	refinedTranscript: {
		intro?: {
			participants: string[];
			duration: string;
			purpose: string;
		};
		chapters: { startSec: number; title: string; paragraphs: string[] }[];
	};
}

/** Lifecycle of an on-demand summary/transcript translation. */
export type TranslationStatus = "PROCESSING" | "COMPLETE" | "ERROR";

/**
 * A single cached translation of a video's AI content into one target
 * language. Stored under `VideoMetadata.translations[<langCode>]`. Purely
 * additive: the base `aiSummary` and original transcript are never mutated.
 */
export interface VideoTranslation {
	status: TranslationStatus;
	/** Translated copy of the base `aiSummary` (same shape). */
	aiSummary?: AiSummary;
	/**
	 * R2 key of the translated transcript VTT, when produced. Lives at
	 * `{ownerId}/{videoId}/transcription.{lang}.vtt`.
	 */
	captionsKey?: string;
	/** ISO timestamp when the translation was requested. */
	requestedAt?: string;
	/** ISO timestamp of the last status change. */
	updatedAt?: string;
	/** Human-readable failure reason when status === "ERROR". */
	error?: string;
}

export type PipelinePhaseKey = "audio" | "transcribe" | "analyze" | "index";

export interface PipelinePhase {
	key: PipelinePhaseKey;
	/** Uzbek: Audio tayyorlash | Transkripsiya | AI tahlil | AI indekslash */
	label: string;
	status: "queued" | "active" | "done" | "error";
	/** units completed */
	done: number;
	/** total units (chunks); audio: 100 if % parsed else 0; analyze: 1 (atomic) */
	total: number;
	startedAt?: string; // ISO
	completedAt?: string; // ISO
	/** transcribe/index: per-chunk wall-clock durations in ms (for median ETA) */
	unitTimesMs?: number[];
	/** Index of the chunk currently being processed (0-based) */
	activeUnitIndex?: number;
	/** ISO timestamp when the current chunk started processing */
	activeUnitStartedAt?: string;
	/** Human-readable label for what the current chunk is doing */
	activeUnitLabel?: string;
	/** Estimated seconds remaining for the current chunk */
	activeUnitEtaSec?: number;
}

export interface PipelineProgress {
	currentPhase: PipelinePhaseKey;
	phases: PipelinePhase[];
	startedAt: string; // overall ISO
	updatedAt: string; // ISO
}

/**
 * Video metadata structure
 */
export interface VideoMetadata {
	/**
	 * Custom created date that can be edited by the user
	 * This overrides the display of the actual createdAt timestamp
	 */
	customCreatedAt?: string;
	/**
	 * Title of the captured monitor or window
	 */
	sourceName?: string;
	/**
	 * AI generated title for the video
	 */
	aiTitle?: string;
	titleManuallyEdited?: boolean;
	/**
	 * AI generated summary of the content
	 */
	summary?: string;
	/**
	 * Chapter markers generated from the transcript
	 */
	chapters?: { title: string; start: number }[];
	aiGenerationStatus?:
		| "QUEUED"
		| "PROCESSING"
		| "COMPLETE"
		| "ERROR"
		| "SKIPPED";
	enhancedAudioStatus?: "PROCESSING" | "COMPLETE" | "ERROR" | "SKIPPED";
	isDemo?: boolean;
	aiSummary?: AiSummary | null;
	/**
	 * Server-side probe results from ffprobe / ffmpeg -i (process-video workflow).
	 * Duration / width / height are also written to the top-level video columns;
	 * codec/container live here because they are diagnostic only.
	 */
	videoCodec?: string;
	audioCodec?: string;
	containerFormat?: string;
	/**
	 * True once a Safari-friendly MP4 has been written at <owner>/<videoId>/transcoded.mp4.
	 * The playlist route prefers transcoded.mp4 over the raw upload when this is true.
	 */
	mp4Ready?: boolean;
	/**
	 * Set by the owner-only "replace with audio" storage-reclaim action
	 * (actions/video/replace-with-audio.ts). When true the heavy video objects
	 * (transcoded.mp4 / result.* / raw-upload.*) have been deleted and an
	 * audio-only file lives at <owner>/<videoId>/audio-only.mp3. The playlist
	 * route serves that audio file for media-playback requests instead of the
	 * (now-absent) video. Additive: absent → current behavior unchanged.
	 * Irreversible — the original video bytes are gone once this is set.
	 */
	isAudio?: boolean;
	/**
	 * Generation status for the screen-capture thumbnail + animated preview.
	 * "pending" is the implicit default for old rows (treat undefined as pending).
	 */
	thumbnailStatus?: "pending" | "ready" | "failed";
	/**
	 * S3/R2 key for the waveform PNG generated from audio sources at upload time.
	 * Audio-only uploads get a `showwavespic` visualization at 1200x180px.
	 * Persisted during process-video workflow; undefined for video sources.
	 */
	waveformKey?: string;
	/**
	 * Live progress for the transcription → AI generation pipeline.
	 * Written by the transcribe + generate-ai workflows; read-modify-write into
	 * the metadata JSON (no DB column). Exposes the real units of work per phase
	 * so the frontend can build a counting-down ETA (per-chunk wall-clock times)
	 * and a real audio-conversion %.
	 *
	 * The two workflows share this single `phases` array via read-modify-write:
	 * transcribe.ts initializes all four phases, advances audio/transcribe/index;
	 * generate-ai.ts flips the analyze phase. Phases are ordered to match real
	 * execution order: audio → transcribe → index → analyze.
	 */
	pipelineProgress?: PipelineProgress;
	/**
	 * Human-readable reason the transcription failed (videos table has no
	 * errorMessage column). Cleared at the start of every transcription run.
	 */
	transcriptionError?: string;
	/**
	 * Set by the cancel endpoint to request that an in-flight transcription stop.
	 * The workflow checks this between chunk batches (cooperative cancellation:
	 * the running background job can't be force-killed, but it stops making
	 * further Gemini calls at the next checkpoint) and settles as CANCELLED.
	 */
	cancelRequested?: boolean;
	/**
	 * Per-chunk VTT results for parallel audio transcription (T12 path).
	 * Keys are chunk indices (as strings). Written after each chunk succeeds so
	 * a retry can skip already-completed chunks without re-transcribing them.
	 * Cleared when transcription completes successfully.
	 */
	completedChunks?: Record<string, string>;
	/**
	 * How many times the stale-job recovery cron has re-triggered this video's
	 * transcription / AI generation workflow. Acts as a hard anti-loop cap so a
	 * permanently-broken video can never be re-triggered forever (and rack up
	 * cost). See app/api/cron/recover-stale-ai-jobs/route.ts.
	 */
	recoveryAttempts?: number;
	/**
	 * Opt-in ElevenLabs Scribe timestamp refinement (per-video owner action).
	 * Gemini timing remains the default for every transcript; the owner may
	 * choose "Refine timestamps" to replace the estimated cue timing with
	 * Scribe's word-accurate timing while preserving the transcript TEXT.
	 *
	 * `timestampsRefined` is true once a refinement has successfully rewritten
	 * the stored VTT. `timestampRefineStatus` tracks the in-flight/terminal state
	 * of the most recent request. Both live in this JSON column (no new DB
	 * column / migration) and default to undefined for every existing row.
	 * Dormant unless ELEVENLABS_API_KEY is configured.
	 */
	timestampsRefined?: boolean;
	timestampRefineStatus?: "PROCESSING" | "COMPLETE" | "ERROR";
	/** Human-readable reason the most recent refinement failed. */
	timestampRefineError?: string;
	/** ISO timestamp of the most recent successful refinement. */
	timestampRefinedAt?: string;
	/**
	 * Set by the storage-reconcile cron when the video's underlying S3/R2 object
	 * can no longer be found (orphaned DB row). Purely a diagnostic flag so the
	 * reconcile job skips already-flagged rows on subsequent runs; it does not
	 * change playback behavior. See app/api/cron/reconcile-storage/route.ts.
	 */
	storageMissing?: boolean;
	/**
	 * On-demand translations of the AI summary + transcript into other
	 * languages, keyed by ISO language code (see `@cap/web-domain` LanguageCode).
	 * Additive: the base `aiSummary` and original transcript VTT are untouched;
	 * each entry caches a translated copy plus the R2 key of its translated VTT.
	 * Written by lib/translate-ai.ts via the translate endpoint.
	 */
	translations?: Partial<Record<LanguageCode, VideoTranslation>>;
	/**
	 * Per-video default display language chosen by the owner. When set and a
	 * matching entry exists in `translations`, the share page opens in that
	 * language instead of the base content.
	 */
	preferredLanguage?: LanguageCode;
}

export type VideoEditRange = {
	start: number;
	end: number;
};

export type VideoEditSpec = {
	version: 1;
	sourceDuration: number;
	keepRanges: VideoEditRange[];
};

/**
 * Space metadata structure
 */
export interface SpaceMetadata {
	[key: string]: never;
}

/**
 * User metadata structure
 */
export interface UserMetadata {
	[key: string]: never;
}
