"use client";

/**
 * CapAudioPlayer — compact audio player for webAudio recordings.
 *
 * Renders a static cover image + audio controls bar (play/pause, seek,
 * speed, volume, time) backed by the same MediaPlayer / media-chrome
 * infrastructure used by CapVideoPlayer, so SegmentedProgressBar and
 * all existing controls work without modification.
 *
 * AU5 will add "webAudio" to the Video.Source union; for now we rely on a
 * type assertion at the call site in ShareVideo.tsx.
 */

import { Pin, PinOff } from "lucide-react";
import {
	MediaPlayer,
	MediaPlayerAudio,
	MediaPlayerControls,
	MediaPlayerControlsOverlay,
	MediaPlayerPlay,
	MediaPlayerSeekBackward,
	MediaPlayerSeekForward,
	MediaPlayerSettings,
	MediaPlayerTime,
	MediaPlayerVolume,
} from "./video/media-player";
import { SegmentedProgressBar } from "./video/SegmentedProgressBar";

interface Props {
	videoSrc: string;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	duration?: number | null;
	defaultPlaybackSpeed?: number;
	isPinned?: boolean;
	onTogglePin?: () => void;
}

export function CapAudioPlayer({
	videoSrc,
	videoRef,
	duration,
	isPinned,
	onTogglePin,
}: Props) {
	const playerDuration = duration ?? 0;

	return (
		<div className="flex flex-col w-full" style={{ borderRadius: 12, overflow: "hidden", background: "#000" }}>
			{/* Cover image */}
			<div
				style={{
					width: "100%",
					height: 240,
					borderRadius: 12,
					overflow: "hidden",
					flexShrink: 0,
				}}
			>
				{/* eslint-disable-next-line @next/next/no-img-element */}
				<img
					src="/audio-cover-default.svg"
					alt=""
					aria-hidden="true"
					style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
				/>
			</div>

			{/* Compact audio controls bar */}
			<MediaPlayer className="w-full" autoHide>
				{/*
				 * MediaPlayerAudio registers the <audio> element with media-chrome's
				 * MediaProvider so all control primitives (play/pause/volume/time)
				 * work identically to the video path.
				 *
				 * videoRef is typed as RefObject<HTMLVideoElement | null> by the parent
				 * but HTMLAudioElement shares the HTMLMediaElement interface, so we
				 * cast here. The ref is used only for currentTime reads in
				 * SegmentedProgressBar and the transcript-follow logic in ShareVideo,
				 * both of which only access HTMLMediaElement members.
				 */}
				<MediaPlayerAudio
					src={videoSrc}
					preload="metadata"
					ref={
						// AU5 will widen the ref type; for now cast to satisfy the audio element ref.
						videoRef as unknown as React.RefObject<HTMLAudioElement>
					}
				/>
				<MediaPlayerControls className="flex-col items-start gap-2.5" isUploadingOrFailed={false}>
					<MediaPlayerControlsOverlay className="rounded-b-xl" />
					<SegmentedProgressBar
						chapters={[]}
						duration={playerDuration}
						fallbackDuration={playerDuration}
						videoRef={videoRef}
					/>
					<div className="flex gap-2 items-center w-full">
						<div className="flex flex-1 gap-2 items-center">
							<MediaPlayerPlay />
							{/* className prop accepted at runtime even though TS type misses it (pre-existing in CapVideoPlayer) */}
							<MediaPlayerSeekBackward {...({ className: "hidden sm:inline-flex" } as object)} />
							<MediaPlayerSeekForward {...({ className: "hidden sm:inline-flex" } as object)} />
							<MediaPlayerVolume expandable />
							<MediaPlayerTime fallbackDuration={playerDuration} />
						</div>
						<div className="flex gap-2 items-center">
							{onTogglePin !== undefined && (
								<button
									type="button"
									onClick={onTogglePin}
									aria-label={isPinned ? "Tepadan ajratish" : "Tepada qotirish"}
									title={isPinned ? "Tepadan ajratish" : "Tepada qotirish"}
									className="inline-flex items-center justify-center rounded-full transition-colors"
									style={{
										width: 28,
										height: 28,
										background: isPinned ? "rgba(255,255,255,0.18)" : "none",
										color: isPinned ? "#fff" : "rgba(255,255,255,.65)",
										border: "none",
										cursor: "pointer",
									}}
								>
									{isPinned ? (
										<Pin className="size-3.5" fill="currentColor" />
									) : (
										<PinOff className="size-3.5" />
									)}
								</button>
							)}
							{/* SM/MD/LG toggle is intentionally hidden in audio mode */}
							{/* sideOffset has a runtime default; passing 10 (FLOATING_MENU_SIDE_OFFSET) to satisfy the TS type */}
							<MediaPlayerSettings hasCaptions={false} sideOffset={10} />
						</div>
					</div>
				</MediaPlayerControls>
			</MediaPlayer>
		</div>
	);
}
