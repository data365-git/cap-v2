"use client";

/**
 * MiniPlayerController — a slim play/pause + seek bar pinned to the bottom of the
 * viewport. Shown only when the main player (audio OR video) has scrolled out of
 * view, so you can pause or scrub a long recording without scrolling back up.
 *
 * It drives the same shared media element both players sync into `videoRef`, so
 * one control works for either source. State is read by polling the element
 * (media events don't bubble and the ref can populate after mount) — cheap at a
 * 250ms tick and robust against the ref appearing late.
 */

import { useCallback, useEffect, useRef, useState } from "react";

function fmt(s: number): string {
	if (!Number.isFinite(s) || s < 0) return "0:00";
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const r = Math.floor(s % 60);
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`
		: `${m}:${String(r).padStart(2, "0")}`;
}

interface Props {
	videoRef: React.RefObject<HTMLVideoElement | null>;
	visible: boolean;
	title?: string;
}

export function MiniPlayerController({ videoRef, visible, title }: Props) {
	const [playing, setPlaying] = useState(false);
	const [current, setCurrent] = useState(0);
	const [duration, setDuration] = useState(0);
	const barRef = useRef<HTMLButtonElement>(null);
	const rootRef = useRef<HTMLElement>(null);

	// Poll the shared media element for play state + time.
	useEffect(() => {
		if (!visible) return;
		const tick = () => {
			const el = videoRef.current;
			if (!el) return;
			setPlaying(!el.paused);
			setCurrent(el.currentTime || 0);
			if (Number.isFinite(el.duration)) setDuration(el.duration || 0);
		};
		tick();
		const id = window.setInterval(tick, 250);
		return () => window.clearInterval(id);
	}, [visible, videoRef]);

	// Reserve page bottom space equal to the bar's real height + publish it so the
	// AI chat FAB lifts clear. Measured via ResizeObserver so wrapping/mobile
	// layouts reserve the right amount.
	useEffect(() => {
		const root = document.documentElement;
		const clear = () => {
			root.style.setProperty("--bottom-bar-height", "0px");
			document.body.style.paddingBottom = "";
		};
		if (!visible) {
			clear();
			return;
		}
		const el = rootRef.current;
		if (!el) return;
		const apply = (h: number) => {
			root.style.setProperty("--bottom-bar-height", `${h}px`);
			document.body.style.paddingBottom = `${h}px`;
		};
		apply(Math.round(el.getBoundingClientRect().height));
		const ro = new ResizeObserver(([entry]) => {
			if (entry) apply(Math.round(entry.contentRect.height));
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			clear();
		};
	}, [visible]);

	const toggle = useCallback(() => {
		const el = videoRef.current;
		if (!el) return;
		if (el.paused) el.play().catch(() => {});
		else el.pause();
		setPlaying(!el.paused);
	}, [videoRef]);

	const seek = useCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			const el = videoRef.current;
			const bar = barRef.current;
			if (!el || !bar || !Number.isFinite(el.duration)) return;
			const rect = bar.getBoundingClientRect();
			const frac = Math.min(
				1,
				Math.max(0, (e.clientX - rect.left) / rect.width),
			);
			el.currentTime = frac * el.duration;
			setCurrent(el.currentTime);
		},
		[videoRef],
	);

	const skip = useCallback(
		(delta: number) => {
			const el = videoRef.current;
			if (!el) return;
			el.currentTime = Math.max(
				0,
				Math.min(el.duration || 0, el.currentTime + delta),
			);
			setCurrent(el.currentTime);
		},
		[videoRef],
	);

	if (!visible) return null;

	const pct = duration > 0 ? (current / duration) * 100 : 0;

	return (
		<section ref={rootRef} className="mini-player" aria-label="Ijro boshqaruvi">
			<button
				type="button"
				className="mini-player-play"
				onClick={toggle}
				aria-label={playing ? "Pauza" : "Ijro"}
				title={playing ? "Pauza" : "Ijro"}
			>
				{playing ? (
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<rect x="6" y="4" width="4" height="16" rx="1.3" />
						<rect x="14" y="4" width="4" height="16" rx="1.3" />
					</svg>
				) : (
					<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
						<polygon points="6,4 20,12 6,20" />
					</svg>
				)}
			</button>

			<div className="mini-player-main">
				{title && <div className="mini-player-title">{title}</div>}
				<div className="mini-player-row">
					<span className="mini-player-time">{fmt(current)}</span>
					<button
						type="button"
						ref={barRef}
						className="mini-player-bar"
						onClick={seek}
						aria-label="Vaqtni tanlash"
					>
						<span
							className="mini-player-bar-fill"
							style={{ width: `${pct}%` }}
						/>
					</button>
					<span className="mini-player-time">{fmt(duration)}</span>
				</div>
			</div>

			<div className="mini-player-skips">
				<button
					type="button"
					className="mini-player-skip"
					onClick={() => skip(-10)}
					aria-label="Orqaga 10 soniya"
					title="Orqaga 10 soniya"
				>
					«
				</button>
				<button
					type="button"
					className="mini-player-skip"
					onClick={() => skip(10)}
					aria-label="Oldinga 10 soniya"
					title="Oldinga 10 soniya"
				>
					»
				</button>
			</div>
		</section>
	);
}
