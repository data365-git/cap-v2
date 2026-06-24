"use client";

import { Play } from "lucide-react";
import { useEffect, useRef } from "react";
import { GenerateSection } from "../GenerateSection";
import { RichText } from "../RichText";

interface TranscriptPanelProps {
	videoId: string;
	transcriptionStatus?: string | null;
	transcriptContent?: string;
	currentTime?: number;
	onVideoJump?: (seconds: number) => void;
	isOwner?: boolean;
}

interface Cue {
	id: number;
	startSeconds: number;
	endSeconds: number;
	text: string;
	speaker: string;
	timestamp: string;
}

function parseVTTCues(vttContent: string): Cue[] {
	const lines = vttContent.split(/\r?\n/);
	const cues: Cue[] = [];
	let cueId = 0;
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]?.trim() ?? "";

		if (line === "WEBVTT" || line === "") {
			i++;
			continue;
		}

		if (/^\d+$/.test(line)) {
			cueId = parseInt(line, 10);
			i++;
			continue;
		}

		if (line.includes("-->")) {
			const [startStr, endStr] = line.split(" --> ");
			const startSeconds = vttTimeToSeconds(startStr?.trim() ?? "");
			const endSeconds = vttTimeToSeconds(endStr?.split(" ")[0]?.trim() ?? "");

			i++;
			const textLines: string[] = [];
			while (i < lines.length && (lines[i]?.trim() ?? "") !== "") {
				textLines.push(lines[i] ?? "");
				i++;
			}

			const rawText = textLines.join(" ").trim();
			if (rawText && startSeconds !== null && endSeconds !== null) {
				const { speaker, text } = extractSpeaker(rawText);
				cues.push({
					id: cueId,
					startSeconds,
					endSeconds,
					text,
					speaker,
					timestamp: formatTimestamp(startSeconds),
				});
			}
			continue;
		}

		i++;
	}

	return cues;
}

function vttTimeToSeconds(timeStr: string): number | null {
	const parts = timeStr.split(":");
	if (parts.length === 3) {
		const [h, m, s] = parts;
		const hours = parseInt(h ?? "0", 10);
		const minutes = parseInt(m ?? "0", 10);
		const seconds = parseFloat(s ?? "0");
		if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds))
			return null;
		return hours * 3600 + minutes * 60 + seconds;
	}
	if (parts.length === 2) {
		const [m, s] = parts;
		const minutes = parseInt(m ?? "0", 10);
		const seconds = parseFloat(s ?? "0");
		if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
		return minutes * 60 + seconds;
	}
	return null;
}

function extractSpeaker(text: string): { speaker: string; text: string } {
	const match = text.match(/^<v\s+([^>]+)>(.*)$/);
	if (match) {
		return {
			speaker: match[1]?.trim() ?? "Speaker",
			text: match[2]?.trim() ?? text,
		};
	}
	const colonMatch = text.match(/^([^:]{1,30}):\s+(.+)$/);
	if (colonMatch) {
		return {
			speaker: colonMatch[1]?.trim() ?? "Speaker",
			text: colonMatch[2]?.trim() ?? text,
		};
	}
	return { speaker: "Speaker", text };
}

function formatTimestamp(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = Math.floor(seconds % 60);
	return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function speakerInitials(name: string): string {
	return name
		.split(/\s+/)
		.slice(0, 2)
		.map((w) => w[0]?.toUpperCase() ?? "")
		.join("");
}

function isActive(cue: Cue, currentTime: number): boolean {
	return currentTime >= cue.startSeconds && currentTime < cue.endSeconds;
}

export function TranscriptPanel({
	videoId,
	transcriptionStatus,
	transcriptContent,
	currentTime = 0,
	onVideoJump,
	isOwner = false,
}: TranscriptPanelProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const activeRef = useRef<HTMLDivElement>(null);

	const cues = transcriptContent ? parseVTTCues(transcriptContent) : [];

	const activeCueId = cues.find((c) => isActive(c, currentTime))?.id ?? null;

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeCueId drives which DOM node activeRef points to; re-running when it changes is intentional
	useEffect(() => {
		if (activeRef.current) {
			activeRef.current.scrollIntoView({
				behavior: "smooth",
				block: "nearest",
			});
		}
	}, [activeCueId]);

	if (!transcriptContent || cues.length === 0) {
		// Transcript already done but cues empty (e.g. NO_AUDIO) → plain message.
		// Otherwise offer on-demand generation.
		return (
			<div className="rd-empty">
				{transcriptionStatus === "COMPLETE" ||
				transcriptionStatus === "NO_AUDIO" ||
				transcriptionStatus === "SKIPPED" ? (
					"No transcript available."
				) : isOwner ? (
					<GenerateSection
						videoId={videoId}
						kind="transcript"
						label="Generate transcript"
						description="No transcript available."
					/>
				) : (
					"No transcript available yet."
				)}
			</div>
		);
	}

	// Two-tone speaker coloring (design: --sp-1 slate, .s2 = accent). First
	// distinct speaker is slate; subsequent speakers alternate to accent.
	const speakerOrder: string[] = [];
	for (const c of cues) {
		if (!speakerOrder.includes(c.speaker)) speakerOrder.push(c.speaker);
	}
	const isS2 = (speaker: string) => speakerOrder.indexOf(speaker) % 2 === 1;

	return (
		<div ref={containerRef} className="transcript-list">
			{cues.map((cue) => {
				const active = cue.id === activeCueId;
				const s2 = isS2(cue.speaker);
				return (
					<div
						key={cue.id}
						ref={active ? activeRef : undefined}
						className={`transcript-entry${s2 ? " s2" : ""}${active ? " active" : ""}`}
					>
						<div className="transcript-avatar" title={cue.speaker}>
							{speakerInitials(cue.speaker)}
						</div>
						<div className="transcript-body">
							<div className="transcript-meta">
								<span className="transcript-meta-speaker">{cue.speaker}</span>
								<span className="transcript-meta-time">{cue.timestamp}</span>
							</div>
							<div className="transcript-text"><RichText inline>{cue.text}</RichText></div>
						</div>
						<button
							type="button"
							className="transcript-play"
							onClick={() => onVideoJump?.(cue.startSeconds)}
							aria-label={`Jump to ${cue.timestamp}`}
						>
							<Play fill="currentColor" />
						</button>
					</div>
				);
			})}
		</div>
	);
}
