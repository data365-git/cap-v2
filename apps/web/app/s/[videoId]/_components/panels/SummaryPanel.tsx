"use client";

import { Clock, LayoutGrid, ListChecks, Sparkles, Users } from "lucide-react";
import { GenerateSection } from "../GenerateSection";
import { RichText } from "../RichText";
import { Skeleton, SkeletonGroup } from "../Skeleton";
import { formatTimeMinutes } from "../utils/transcript-utils";

interface SummaryPanelProps {
	videoId: string;
	transcriptionStatus?: string | null;
	aiGenerationStatus?: string | null;
	isOwner?: boolean;
	data: {
		duration?: number;
		aiSummary?: {
			overview?: string;
			topics?: { title: string; body: string }[];
			nextSteps?: string[];
			chapters?: { startSec: number; title: string; body: string }[];
		};
		speakerCount?: number;
	};
	onVideoJump?: (seconds: number) => void;
}

export function SummaryPanel({
	videoId,
	transcriptionStatus,
	aiGenerationStatus,
	isOwner = false,
	data,
}: SummaryPanelProps) {
	const { aiSummary } = data;
	const topics = aiSummary?.topics ?? [];
	const nextSteps = aiSummary?.nextSteps ?? [];

	if (!aiSummary) {
		const isInFlight =
			aiGenerationStatus === "PROCESSING" ||
			aiGenerationStatus === "QUEUED" ||
			transcriptionStatus === "PROCESSING" ||
			transcriptionStatus === "QUEUED";

		if (isInFlight) {
			return (
				<SkeletonGroup>
					{/* Stat strip */}
					<div style={{ display: "flex", gap: 8 }}>
						{[0, 1, 2, 3].map((i) => (
							<Skeleton key={i} style={{ height: 56, flex: 1 }} />
						))}
					</div>
					{/* Lead card */}
					<Skeleton style={{ height: 80 }} />
					{/* Topic cards */}
					<Skeleton style={{ height: 52 }} />
					<Skeleton style={{ height: 52 }} />
					<Skeleton style={{ height: 52 }} />
				</SkeletonGroup>
			);
		}

		return (
			<div className="rd-empty">
				{isOwner ? (
					<GenerateSection
						videoId={videoId}
						kind="ai"
						label="Generate summary"
						description="No AI summary available."
						transcriptReady={transcriptionStatus === "COMPLETE"}
					/>
				) : (
					<span>Not available yet</span>
				)}
			</div>
		);
	}

	const stats: { icon: React.ReactNode; num: string; label: string }[] = [
		{
			icon: <Clock />,
			num: data.duration ? formatTimeMinutes(data.duration) : "—",
			label: "Duration",
		},
		{
			icon: <Users />,
			num: String(data.speakerCount ?? "—"),
			label: "Participants",
		},
		{ icon: <LayoutGrid />, num: String(topics.length), label: "Topics" },
		{ icon: <ListChecks />, num: String(nextSteps.length), label: "Next steps" },
	];

	return (
		<>
			{/* Stat strip */}
			<div className="sum-stats">
				{stats.map((s) => (
					<div className="stat-card" key={s.label}>
						<div className="stat-ic">{s.icon}</div>
						<div className="stat-num">{s.num}</div>
						<div className="stat-lbl">{s.label}</div>
					</div>
				))}
			</div>

			{/* Overview lead card */}
			{aiSummary.overview && (
				<div className="lead-card">
					<RichText>{aiSummary.overview}</RichText>
				</div>
			)}

			{/* Topic cards */}
			{topics.length > 0 && (
				<>
					<div className="sec-eyebrow">
						<span className="ic" aria-hidden="true">
							<LayoutGrid size={14} aria-hidden="true" />
						</span>
						Topics
					</div>
					<div className="topic-grid">
						{topics.map((topic) => (
							<div className="topic-card" key={topic.title}>
								<div className="topic-dot" aria-hidden="true">
									<Sparkles aria-hidden="true" />
								</div>
								<div className="topic-text">
									<b>{topic.title}</b>
									{topic.body ? <> — <RichText inline>{topic.body}</RichText></> : null}
								</div>
							</div>
						))}
					</div>
				</>
			)}

			{/* Next steps — accent checklist */}
			{nextSteps.length > 0 && (
				<>
					<div className="sec-eyebrow">
						<span className="ic" aria-hidden="true">
							<ListChecks size={14} aria-hidden="true" />
						</span>
						Next steps
					</div>
					<div className="step-list">
						{nextSteps.map((step, i) => (
							<div className="step-item" key={step}>
								<span className="step-num">{String(i + 1).padStart(2, "0")}</span>
								<span className="t"><RichText inline>{step}</RichText></span>
							</div>
						))}
					</div>
				</>
			)}

			{topics.length === 0 && nextSteps.length === 0 && (
				<div className="rd-empty">No content available yet.</div>
			)}
		</>
	);
}
