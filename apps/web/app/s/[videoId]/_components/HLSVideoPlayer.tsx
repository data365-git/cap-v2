"use client";

/**
 * DEPRECATED: This component is a thin wrapper around CapVideoPlayer.
 *
 * All playback now goes through the native <video> element (CapVideoPlayer).
 * This file exists only so that any leftover imports compile without error.
 * New code should import CapVideoPlayer directly.
 */

import type { Video } from "@cap/web-domain";
import { CapVideoPlayer } from "./CapVideoPlayer";

interface CaptionOption {
	code: string;
	name: string;
}

interface Props {
	videoSrc: string;
	videoId: Video.VideoId;
	chaptersSrc: string;
	captionsSrc: string;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	mediaPlayerClassName?: string;
	disableCaptions?: boolean;
	autoplay?: boolean;
	hasActiveUpload?: boolean;
	isLiveSegments?: boolean;
	allowSegmentProbeDuringUpload?: boolean;
	enhancedAudioUrl?: string | null;
	enhancedAudioStatus?: string | null;
	captionLanguage?: string;
	onCaptionLanguageChange?: (language: string) => void;
	availableCaptions?: CaptionOption[];
	isCaptionLoading?: boolean;
	hasCaptions?: boolean;
	canRetryProcessing?: boolean;
	duration?: number | null;
	defaultPlaybackSpeed?: number;
	previewMode?: "background";
	chapters?: { startSec: number; title: string }[];
}

export function HLSVideoPlayer({
	videoSrc,
	videoId,
	chaptersSrc,
	captionsSrc,
	videoRef,
	mediaPlayerClassName,
	autoplay = false,
	hasActiveUpload,
	disableCaptions,
	captionLanguage,
	onCaptionLanguageChange,
	availableCaptions = [],
	isCaptionLoading = false,
	hasCaptions = false,
	canRetryProcessing = false,
	duration,
	defaultPlaybackSpeed,
	chapters = [],
}: Props) {
	// Rewrite HLS playlist URLs to the mp4 endpoint so CapVideoPlayer
	// resolves a direct signed MP4 URL instead of an .m3u8 manifest.
	let mp4Src = videoSrc;
	if (typeof window !== "undefined") {
		try {
			const url = new URL(videoSrc, window.location.origin);
			const vt = url.searchParams.get("videoType");
			if (
				vt &&
				[
					"segments-master",
					"segments-video",
					"segments-audio",
					"master",
					"video",
					"audio",
				].includes(vt)
			) {
				url.searchParams.set("videoType", "mp4");
				mp4Src = `${url.pathname}${url.search}`;
			}
		} catch {
			// keep original src on parse failure
		}
	}

	return (
		<CapVideoPlayer
			videoSrc={mp4Src}
			videoId={videoId}
			chaptersSrc={chaptersSrc}
			captionsSrc={captionsSrc}
			videoRef={videoRef}
			mediaPlayerClassName={mediaPlayerClassName}
			autoplay={autoplay}
			enableCrossOrigin
			hasActiveUpload={hasActiveUpload}
			disableCaptions={disableCaptions}
			captionLanguage={captionLanguage}
			onCaptionLanguageChange={onCaptionLanguageChange}
			availableCaptions={availableCaptions}
			isCaptionLoading={isCaptionLoading}
			hasCaptions={hasCaptions}
			canRetryProcessing={canRetryProcessing}
			duration={duration}
			defaultPlaybackSpeed={defaultPlaybackSpeed}
			chapters={chapters}
		/>
	);
}
