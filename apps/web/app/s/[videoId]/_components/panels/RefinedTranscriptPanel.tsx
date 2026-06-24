"use client";

import { Play } from "lucide-react";
import { GenerateSection } from "../GenerateSection";
import { formatTimeMinutes } from "../utils/transcript-utils";

interface RefinedTranscriptPanelProps {
	videoId: string;
	transcriptionStatus?: string | null;
	refinedTranscript?: {
		chapters: {
			startSec: number;
			title: string;
			paragraphs: string[];
		}[];
	};
	onVideoJump?: (seconds: number) => void;
}

export function RefinedTranscriptPanel({
	videoId,
	transcriptionStatus,
	refinedTranscript,
	onVideoJump,
}: RefinedTranscriptPanelProps) {
	if (!refinedTranscript || refinedTranscript.chapters.length === 0) {
		return (
			<div className="rd-empty">
				<GenerateSection
					videoId={videoId}
					kind="ai"
					label="Generate refined transcript"
					description="Refined transcript not available yet"
					transcriptReady={transcriptionStatus === "COMPLETE"}
				/>
			</div>
		);
	}

	return (
		<>
			{refinedTranscript.chapters.map((chapter) => (
				<section className="refined-section" key={chapter.startSec}>
					<div className="refined-head">
						<button
							type="button"
							className="refined-play"
							onClick={() => onVideoJump?.(chapter.startSec)}
							aria-label={`Play from ${chapter.title}`}
						>
							<Play fill="currentColor" />
						</button>
						<div className="refined-head-text">
							<div className="refined-section-title">{chapter.title}</div>
							<div className="refined-time-badge">
								{formatTimeMinutes(chapter.startSec)}
							</div>
						</div>
					</div>
					{chapter.paragraphs.map((paragraph) => (
						<p className="refined-para" key={paragraph}>
							{paragraph}
						</p>
					))}
				</section>
			))}
		</>
	);
}
