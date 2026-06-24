"use client";

import { Play } from "lucide-react";
import { useEffect, useRef } from "react";
import { GenerateSection } from "../GenerateSection";
import { RichText } from "../RichText";
import { Skeleton, SkeletonGroup } from "../Skeleton";
import { formatTimeMinutes } from "../utils/transcript-utils";

const MANUAL_SCROLL_GRACE_MS = 3000;

interface RefinedTranscriptPanelProps {
	videoId: string;
	transcriptionStatus?: string | null;
	aiGenerationStatus?: string | null;
	currentTime?: number;
	refinedTranscript?: {
		intro?: {
			participants: string[];
			duration: string;
			purpose: string;
		};
		chapters: {
			startSec: number;
			title: string;
			paragraphs: string[];
		}[];
	};
	onVideoJump?: (seconds: number) => void;
	isOwner?: boolean;
}

export function RefinedTranscriptPanel({
	videoId,
	transcriptionStatus,
	aiGenerationStatus,
	currentTime = 0,
	refinedTranscript,
	onVideoJump,
	isOwner = false,
}: RefinedTranscriptPanelProps) {
	const containerRef = useRef<HTMLElement | null>(null);
	const activeRef = useRef<HTMLElement | null>(null);
	const lastUserScrollAt = useRef<number>(0);
	const programmaticScroll = useRef<boolean>(false);

	const chapters = refinedTranscript?.chapters ?? [];

	// Active chapter = last chapter whose startSec <= currentTime
	const activeStartSec =
		chapters.reduce<number | null>((acc, ch) => {
			if (ch.startSec <= currentTime) {
				return acc === null || ch.startSec > acc ? ch.startSec : acc;
			}
			return acc;
		}, null);

	// Scroll listener on the scrollable ancestor (parent of the wrapper div)
	useEffect(() => {
		const container = containerRef.current?.parentElement;
		if (!container) return;
		const onScroll = () => {
			if (programmaticScroll.current) return;
			lastUserScrollAt.current = Date.now();
		};
		container.addEventListener("scroll", onScroll, { passive: true });
		return () => container.removeEventListener("scroll", onScroll);
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies: activeStartSec drives which DOM node activeRef points to; re-running when it changes is intentional
	useEffect(() => {
		if (!activeRef.current) return;
		if (Date.now() - lastUserScrollAt.current < MANUAL_SCROLL_GRACE_MS) return;

		programmaticScroll.current = true;
		activeRef.current.scrollIntoView({
			behavior: "smooth",
			block: "center",
		});
		Promise.resolve().then(() => {
			setTimeout(() => {
				programmaticScroll.current = false;
			}, 50);
		});
	}, [activeStartSec]);
	if (!refinedTranscript || refinedTranscript.chapters.length === 0) {
		const isInFlight =
			aiGenerationStatus === "PROCESSING" ||
			aiGenerationStatus === "QUEUED" ||
			transcriptionStatus === "PROCESSING" ||
			transcriptionStatus === "QUEUED";

		if (isInFlight) {
			return (
				<SkeletonGroup>
					{/* Intro card */}
					<Skeleton style={{ height: 60 }} />
					{/* Chapter sections */}
					{[0, 1, 2].map((i) => (
						<div key={i} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
							<Skeleton style={{ height: 20, width: "60%" }} />
							<Skeleton style={{ height: 14 }} />
							<Skeleton style={{ height: 14 }} />
							<Skeleton style={{ height: 14, width: "80%" }} />
						</div>
					))}
				</SkeletonGroup>
			);
		}

		return (
			<div className="rd-empty">
				{isOwner ? (
					<GenerateSection
						videoId={videoId}
						kind="ai"
						label="Generate refined transcript"
						description="Refined transcript not available yet"
						transcriptReady={transcriptionStatus === "COMPLETE"}
					/>
				) : (
					"Refined transcript not available yet."
				)}
			</div>
		);
	}

	const intro = refinedTranscript.intro;
	const hasIntro =
		intro &&
		((intro.participants && intro.participants.length > 0) ||
			intro.duration ||
			intro.purpose);

	return (
		<div ref={(el) => { containerRef.current = el; }}>
			{hasIntro && intro && (
				<div className="refined-doc-intro">
					<div className="refined-doc-intro-label">Uchrashuv hisoboti</div>
					<div className="refined-doc-intro-text">
						{intro.participants && intro.participants.length > 0 && (
							<>
								<strong>Ishtirokchilar:</strong>{" "}
								{intro.participants.join(", ")}
								{(intro.duration || intro.purpose) && " · "}
							</>
						)}
						{intro.duration && (
							<>
								<strong>Davomiyligi:</strong> {intro.duration}
								{intro.purpose && " · "}
							</>
						)}
						{intro.purpose && (
							<>
								<strong>Maqsad:</strong> {intro.purpose}
							</>
						)}
					</div>
				</div>
			)}
			{refinedTranscript.chapters.map((chapter) => {
				const isActive = chapter.startSec === activeStartSec;
				return (
					<section
						className={`refined-section${isActive ? " refined-section-active" : ""}`}
						key={chapter.startSec}
						ref={isActive ? (el) => { activeRef.current = el; } : undefined}
					>
						<div className="refined-head">
							<button
								type="button"
								className="refined-play"
								onClick={() => onVideoJump?.(chapter.startSec)}
								aria-label={`Jump to ${chapter.title}`}
							>
								<Play fill="currentColor" aria-hidden="true" />
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
								<RichText>{paragraph}</RichText>
							</p>
						))}
					</section>
				);
			})}
		</div>
	);
}
