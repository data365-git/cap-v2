"use client";

import { Clock, LayoutGrid, ListChecks, Sparkles, Users } from "lucide-react";
import { GenerateSection } from "../GenerateSection";
import { formatTimeMinutes } from "../utils/transcript-utils";

interface SummaryPanelProps {
	videoId: string;
	transcriptionStatus?: string | null;
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
	data,
	onVideoJump: _onVideoJump,
}: SummaryPanelProps) {
	const { aiSummary } = data;
	const topics = aiSummary?.topics ?? [];
	const nextSteps = aiSummary?.nextSteps ?? [];
	const chapters = aiSummary?.chapters ?? [];

	if (!aiSummary) {
		return (
			<div className="rd-empty">
				<GenerateSection
					videoId={videoId}
					kind="ai"
					label="Generate summary"
					description="No AI summary available."
					transcriptReady={transcriptionStatus === "COMPLETE"}
				/>
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
					<p>{aiSummary.overview}</p>
				</div>
			)}

			{/* Topic cards */}
			{topics.length > 0 && (
				<>
					<div className="sec-eyebrow">
						<span className="ic">
							<LayoutGrid size={14} />
						</span>
						Topics
					</div>
					<div className="topic-grid">
						{topics.map((topic) => (
							<div className="topic-card" key={topic.title}>
								<div className="topic-dot">
									<Sparkles />
								</div>
								<div className="topic-text">
									<b>{topic.title}</b>
									{topic.body ? <> — {topic.body}</> : null}
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
						<span className="ic">
							<ListChecks size={14} />
						</span>
						Next steps
					</div>
					<div className="step-list">
						{nextSteps.map((step, i) => (
							<div className="step-item" key={step}>
								<span className="step-num">{i + 1}</span>
								<span className="t">{step}</span>
							</div>
						))}
					</div>
				</>
			)}

			{topics.length === 0 &&
				nextSteps.length === 0 &&
				chapters.length === 0 &&
				!aiSummary.overview && <div className="rd-empty">No content available yet.</div>}
		</>
	);
}
