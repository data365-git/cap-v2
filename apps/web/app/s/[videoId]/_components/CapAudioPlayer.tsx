"use client";

/**
 * CapAudioPlayer — compact horizontal-bar audio player.
 *
 * Built on a raw <audio> element (no media-chrome). Matches the visual mockup
 * at "Audio Player.html" with purple accent (#7C5BFF) instead of blue.
 */

import React, {
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";

// ─── helpers ────────────────────────────────────────────────────────────────

function formatTime(s: number): string {
	if (!Number.isFinite(s) || s < 0) return "0:00";
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = Math.floor(s % 60);
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
		: `${m}:${String(r).padStart(2, "0")}`;
}

const SPEEDS = [0.75, 1.0, 1.25, 1.5, 2.0];

// ─── SVG icons ──────────────────────────────────────────────────────────────

function PlayIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" width={24} height={24}>
			<polygon points="6,4 20,12 6,20" />
		</svg>
	);
}

function PauseIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="currentColor" width={24} height={24} className="audio-pause-ic">
			<rect x="6" y="4" width="4" height="16" rx="1.3" />
			<rect x="14" y="4" width="4" height="16" rx="1.3" />
		</svg>
	);
}

function RewindIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={17} height={17}>
			<polyline points="11 17 6 12 11 7" />
			<polyline points="18 17 13 12 18 7" />
		</svg>
	);
}

function ForwardIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={17} height={17}>
			<polyline points="13 17 18 12 13 7" />
			<polyline points="6 17 11 12 6 7" />
		</svg>
	);
}

function VolumeIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={17} height={17}>
			<polygon points="11 5 6 9 2 9 2 15 6 15 11 19" />
			<path d="M15.54 8.46a5 5 0 010 7.07" />
			<path d="M19.07 4.93a10 10 0 010 14.14" />
		</svg>
	);
}

function MuteIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={17} height={17}>
			<polygon points="11 5 6 9 2 9 2 15 6 15 11 19" />
			<line x1="23" y1="9" x2="17" y2="15" />
			<line x1="17" y1="9" x2="23" y2="15" />
		</svg>
	);
}

function DownloadIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={17} height={17}>
			<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
			<polyline points="7 10 12 15 17 10" />
			<line x1="12" y1="15" x2="12" y2="3" />
		</svg>
	);
}

function PinOnIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={17} height={17}>
			<line x1="12" y1="17" x2="12" y2="22" />
			<path d="M5 17h14v-1.76a2 2 0 00-1.11-1.79l-1.78-.9A2 2 0 0115 10.76V6h1a2 2 0 000-4H8a2 2 0 000 4h1v4.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17z" />
		</svg>
	);
}

function PinOffIcon() {
	return (
		<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" width={17} height={17}>
			<line x1="2" y1="2" x2="22" y2="22" />
			<line x1="12" y1="17" x2="12" y2="22" />
			<path d="M9 9v1.76a2 2 0 01-1.11 1.79l-1.78.9A2 2 0 005 15.24V17h12" />
			<path d="M15 9.34V6h1a2 2 0 000-4H7.89" />
		</svg>
	);
}

// ─── types ───────────────────────────────────────────────────────────────────

interface Chapter {
	startSec: number;
	title: string;
	body?: string;
}

interface Props {
	videoSrc: string;
	videoRef: React.RefObject<HTMLVideoElement | null>;
	duration?: number | null;
	defaultPlaybackSpeed?: number;
	isPinned?: boolean;
	onTogglePin?: () => void;
	chapters?: Chapter[];
	title?: string;
	downloadUrl?: string;
	downloadFileName?: string;
}

// ─── component ───────────────────────────────────────────────────────────────

export function CapAudioPlayer({
	videoSrc,
	videoRef,
	duration: durationProp,
	defaultPlaybackSpeed = 1,
	isPinned,
	onTogglePin,
	chapters = [],
	title,
	downloadUrl,
	downloadFileName,
}: Props) {
	const audioRef = useRef<HTMLAudioElement | null>(null);
	const segRefs = useRef<HTMLButtonElement[]>([]);
	const barRef = useRef<HTMLDivElement>(null);

	const [isPlaying, setIsPlaying] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const [duration, setDuration] = useState<number>(durationProp ?? 0);
	const [isMuted, setIsMuted] = useState(false);
	const [speedIdx, setSpeedIdx] = useState(() => {
		const i = SPEEDS.indexOf(defaultPlaybackSpeed);
		return i >= 0 ? i : 1;
	});
	const [dotLeft, setDotLeft] = useState(0);

	// Sync audioRef with the videoRef slot so callers can read currentTime
	useEffect(() => {
		const audioEl = audioRef.current;
		if (!audioEl) return;
		// Cast: callers only use HTMLMediaElement members (currentTime, etc.)
		(videoRef as React.MutableRefObject<HTMLMediaElement | null>).current = audioEl as unknown as HTMLVideoElement;
	}, [videoRef]);

	// ── dot position calculation ──────────────────────────────────────────────
	const computeDot = useCallback((ct: number) => {
		const segs = segRefs.current;
		if (!segs.length || !barRef.current) return;
		const dur = audioRef.current?.duration ?? duration;
		if (!dur) return;

		const bounds = [
			...chapters.map((c) => c.startSec),
			dur,
		];

		if (chapters.length === 0) {
			// Single fallback segment
			const bar = barRef.current;
			const singleSeg = bar.querySelector<HTMLButtonElement>(".progress-seg");
			if (singleSeg) {
				const f = Math.max(0, Math.min(1, ct / dur));
				setDotLeft(singleSeg.offsetLeft + f * singleSeg.offsetWidth);
			}
			return;
		}

		let left = 0;
		for (let i = 0; i < segs.length; i++) {
			const start = bounds[i] ?? 0;
			const end = bounds[i + 1] ?? dur;
			const el = segs[i];
			if (!el) continue;
			if (ct >= end) {
				left = el.offsetLeft + el.offsetWidth;
			} else if (ct >= start) {
				const f = (ct - start) / (end - start);
				left = el.offsetLeft + f * el.offsetWidth;
				break;
			}
		}
		setDotLeft(left);
	}, [chapters, duration]);

	// Recompute on resize
	useEffect(() => {
		const bar = barRef.current;
		if (!bar) return;
		const ro = new ResizeObserver(() => {
			const ct = audioRef.current?.currentTime ?? 0;
			computeDot(ct);
		});
		ro.observe(bar);
		return () => ro.disconnect();
	}, [computeDot]);

	// ── audio event handlers ──────────────────────────────────────────────────
	const handleTimeUpdate = useCallback(() => {
		const el = audioRef.current;
		if (!el) return;
		setCurrentTime(el.currentTime);
		computeDot(el.currentTime);
	}, [computeDot]);

	const handleLoadedMetadata = useCallback(() => {
		const el = audioRef.current;
		if (!el) return;
		if (el.duration && Number.isFinite(el.duration)) {
			setDuration(el.duration);
		}
		if (el.playbackRate !== SPEEDS[speedIdx]) {
			el.playbackRate = SPEEDS[speedIdx] ?? 1;
		}
	}, [speedIdx]);

	const handlePlay = useCallback(() => setIsPlaying(true), []);
	const handlePause = useCallback(() => setIsPlaying(false), []);
	const handleEnded = useCallback(() => setIsPlaying(false), []);

	// ── controls ──────────────────────────────────────────────────────────────
	const togglePlay = useCallback(() => {
		const el = audioRef.current;
		if (!el) return;
		if (el.paused) {
			el.play().catch(() => {});
		} else {
			el.pause();
		}
	}, []);

	const seekBy = useCallback((delta: number) => {
		const el = audioRef.current;
		if (!el) return;
		el.currentTime = Math.max(0, Math.min(el.duration || 0, el.currentTime + delta));
	}, []);

	const cycleSpeed = useCallback(() => {
		const nextIdx = (speedIdx + 1) % SPEEDS.length;
		setSpeedIdx(nextIdx);
		if (audioRef.current) {
			audioRef.current.playbackRate = SPEEDS[nextIdx] ?? 1;
		}
	}, [speedIdx]);

	const toggleMute = useCallback(() => {
		const el = audioRef.current;
		if (!el) return;
		el.muted = !el.muted;
		setIsMuted(el.muted);
	}, []);

	// ── keyboard on progress bar ──────────────────────────────────────────────
	const handleBarKey = useCallback(
		(e: React.KeyboardEvent<HTMLDivElement>) => {
			switch (e.key) {
				case " ":
				case "k":
				case "K":
					e.preventDefault();
					togglePlay();
					break;
				case "ArrowLeft":
					e.preventDefault();
					seekBy(-5);
					break;
				case "ArrowRight":
					e.preventDefault();
					seekBy(5);
					break;
				case "j":
				case "J":
					e.preventDefault();
					seekBy(-10);
					break;
				case "l":
				case "L":
					e.preventDefault();
					seekBy(10);
					break;
				case "Home":
					e.preventDefault();
					if (audioRef.current) audioRef.current.currentTime = 0;
					break;
				case "End":
					e.preventDefault();
					if (audioRef.current) audioRef.current.currentTime = Math.max(0, (audioRef.current.duration || 0) - 1);
					break;
			}
		},
		[togglePlay, seekBy],
	);

	// ── chapter segment clicks ────────────────────────────────────────────────
	const seekToChapter = useCallback((startSec: number) => {
		const el = audioRef.current;
		if (!el) return;
		el.currentTime = startSec;
		if (el.paused) el.play().catch(() => {});
	}, []);

	// Single fallback segment: click seeks to ratio position
	const handleFallbackClick = useCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const el = audioRef.current;
			if (!el) return;
			const rect = e.currentTarget.getBoundingClientRect();
			const f = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
			el.currentTime = f * (el.duration || 0);
		},
		[],
	);

	// ── derived display values ────────────────────────────────────────────────
	const dur = (audioRef.current?.duration && Number.isFinite(audioRef.current.duration))
		? audioRef.current.duration
		: duration;

	const subtitle = dur > 0
		? `Audio yozuv · ${formatTime(dur)} · MP3`
		: "Audio yozuv";

	const bounds = chapters.length > 0
		? [...chapters.map((c) => c.startSec), dur]
		: null;

	// ── render ────────────────────────────────────────────────────────────────
	return (
		<div className="audio-player">
			<div className="audio-aura" aria-hidden="true" />

			<button
				type="button"
				className="audio-play"
				onClick={togglePlay}
				aria-label={isPlaying ? "Pauza" : "Ijro"}
				title={isPlaying ? "Pauza" : "Ijro"}
			>
				{isPlaying ? <PauseIcon /> : <PlayIcon />}
			</button>

			<div className="audio-main">
				<div className="audio-head">
					<div className="audio-meta">
						{title && <div className="audio-title">{title}</div>}
						<div className="audio-sub">{subtitle}</div>
					</div>
				</div>

				{/* ── progress bar ── */}
				<div
					ref={barRef}
					className="progress-bar"
					role="slider"
					aria-label="Audio davomi"
					aria-valuemin={0}
					aria-valuemax={dur || 100}
					aria-valuenow={Math.round(currentTime)}
					tabIndex={0}
					onKeyDown={handleBarKey}
				>
					{chapters.length > 0 && bounds ? (
						chapters.map((ch, i) => {
							const start = bounds[i] ?? 0;
							const end = bounds[i + 1] ?? dur;
							const segDur = end - start;
							const fillPct =
								dur > 0
									? Math.max(0, Math.min(1, (currentTime - start) / Math.max(1, end - start))) * 100
									: 0;
							return (
								<button
									key={ch.startSec}
									type="button"
									className="progress-seg"
									style={{ flexGrow: segDur }}
									aria-label={`${formatTime(start)} ${ch.title}`}
									ref={(el) => {
										if (el) segRefs.current[i] = el;
									}}
									onClick={(e) => {
										e.stopPropagation();
										seekToChapter(ch.startSec);
									}}
								>
									<span
										className="progress-seg-fill"
										style={{ width: `${fillPct}%` }}
									/>
									<span className="chapter-tip">
										<b>{formatTime(start)}</b>
										{ch.title}
									</span>
								</button>
							);
						})
					) : (
						// Empty-chapters fallback: single full-width segment, ratio-seek on click
						<button
							type="button"
							className="progress-seg"
							style={{ flexGrow: 1 }}
							aria-label="Audio davomi"
							ref={(el) => {
								if (el) segRefs.current[0] = el;
							}}
							onClick={handleFallbackClick}
						>
							<span
								className="progress-seg-fill"
								style={{
									width: dur > 0 ? `${(currentTime / dur) * 100}%` : "0%",
								}}
							/>
						</button>
					)}

					<span
						className="progress-dot"
						style={{ left: dotLeft }}
						aria-hidden="true"
					/>
				</div>

				{/* ── footer ── */}
				<div className="audio-foot">
					<span className="time-display">
						{formatTime(currentTime)} / {formatTime(dur)}
					</span>
					<div className="audio-right">
						<button
							type="button"
							className="audio-ctrl"
							title="Orqaga 10 soniya"
							aria-label="Orqaga 10 soniya"
							onClick={() => seekBy(-10)}
						>
							<RewindIcon />
						</button>

						<button
							type="button"
							className="audio-ctrl"
							title="Oldinga 10 soniya"
							aria-label="Oldinga 10 soniya"
							onClick={() => seekBy(10)}
						>
							<ForwardIcon />
						</button>

						<button
							type="button"
							className="audio-ctrl audio-speed"
							title="Tezlik"
							aria-label="Ijro tezligi"
							onClick={cycleSpeed}
						>
							{SPEEDS[speedIdx] ?? 1}×
						</button>

						<button
							type="button"
							className="audio-ctrl"
							title={isMuted ? "Ovoz yoqish" : "Ovozni o'chirish"}
							aria-label={isMuted ? "Ovoz yoqish" : "Ovozni o'chirish"}
							onClick={toggleMute}
						>
							{isMuted ? <MuteIcon /> : <VolumeIcon />}
						</button>

						{onTogglePin !== undefined && (
							<button
								type="button"
								className="audio-ctrl"
								title={isPinned ? "Tepadan ajratish" : "Tepada qotirish"}
								aria-label={isPinned ? "Tepadan ajratish" : "Tepada qotirish"}
								onClick={onTogglePin}
							>
								{isPinned ? <PinOffIcon /> : <PinOnIcon />}
							</button>
						)}

						{downloadUrl && (
							<a
								href={downloadUrl}
								download={downloadFileName ?? true}
								className="audio-ctrl"
								title="Yuklab olish"
								aria-label="Yuklab olish"
							>
								<DownloadIcon />
							</a>
						)}
					</div>
				</div>
			</div>

			{/* Hidden audio element */}
			<audio
				ref={(el) => {
					audioRef.current = el;
				}}
				src={videoSrc}
				preload="metadata"
				style={{ display: "none" }}
				onTimeUpdate={handleTimeUpdate}
				onLoadedMetadata={handleLoadedMetadata}
				onPlay={handlePlay}
				onPause={handlePause}
				onEnded={handleEnded}
			/>
		</div>
	);
}
