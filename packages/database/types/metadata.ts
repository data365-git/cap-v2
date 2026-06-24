/**
 * Type definitions for JSON metadata fields
 */

export interface AiSummary {
	overview: string;
	topics: { title: string; body: string }[];
	nextSteps: string[];
	tasks: {
		title: string;
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
	 * Generation status for the screen-capture thumbnail + animated preview.
	 * "pending" is the implicit default for old rows (treat undefined as pending).
	 */
	thumbnailStatus?: "pending" | "ready" | "failed";
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
