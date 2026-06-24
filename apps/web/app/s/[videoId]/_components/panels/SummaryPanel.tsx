"use client";

import { Clock, LayoutGrid, List, ListChecks, Sparkles, Users } from "lucide-react";
import { useState } from "react";
import { GenerateSection } from "../GenerateSection";
import { formatTimeMinutes } from "../utils/transcript-utils";

type SummaryView = "cards" | "timeline" | "document";

interface SummaryPanelProps {
	videoId: string;
	transcriptionStatus?: string | null;
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

/** Format seconds → "M:SS" */
function fmtSec(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

export function SummaryPanel({
	videoId,
	transcriptionStatus,
	isOwner = false,
	data,
	onVideoJump,
}: SummaryPanelProps) {
	const [view, setView] = useState<SummaryView>("cards");
	const { aiSummary } = data;
	const topics = aiSummary?.topics ?? [];
	const nextSteps = aiSummary?.nextSteps ?? [];
	const chapters = aiSummary?.chapters ?? [];

	if (!aiSummary) {
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
					<p>{aiSummary.overview}</p>
				</div>
			)}

			{/* View switcher */}
			<div className="sum-switcher-toolbar">
				<div className="tasks-switch" role="tablist" aria-label="Summary view">
					<button
						className={`tasks-switch-btn${view === "cards" ? " active" : ""}`}
						type="button"
						onClick={() => setView("cards")}
					>
						<LayoutGrid size={15} />
						Cards
					</button>
					<button
						className={`tasks-switch-btn${view === "timeline" ? " active" : ""}`}
						type="button"
						onClick={() => setView("timeline")}
					>
						<Clock size={15} />
						Timeline
					</button>
					<button
						className={`tasks-switch-btn${view === "document" ? " active" : ""}`}
						type="button"
						onClick={() => setView("document")}
					>
						<List size={15} />
						Document
					</button>
				</div>
			</div>

			{/* ===== CARDS view ===== */}
			{view === "cards" && (
				<div>
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
										<span className="step-num">{String(i + 1).padStart(2, "0")}</span>
										<span className="t">{step}</span>
									</div>
								))}
							</div>
						</>
					)}

					{topics.length === 0 && nextSteps.length === 0 && (
						<div className="rd-empty">No content available yet.</div>
					)}
				</div>
			)}

			{/* ===== TIMELINE view ===== */}
			{view === "timeline" && (
				<div>
					{chapters.length > 0 ? (
						<>
							<div className="sec-eyebrow">
								<span className="ic">
									<Clock size={14} />
								</span>
								Chapters
							</div>
							<div className="chapter-list">
								{chapters.map((ch) => (
									<div className="chapter" key={ch.startSec}>
										<span className="chapter-dot" />
										<button
											className="chapter-time"
											type="button"
											onClick={() => onVideoJump?.(ch.startSec)}
										>
											{fmtSec(ch.startSec)}
										</button>
										<div className="chapter-body">
											<div className="ct">{ch.title}</div>
											{ch.body && <div className="cd">{ch.body}</div>}
										</div>
									</div>
								))}
							</div>
						</>
					) : (
						<div className="rd-empty">No chapters available yet.</div>
					)}
				</div>
			)}

			{/* ===== DOCUMENT view ===== */}
			{view === "document" && (
				<div className="doc-view">
					{topics.length > 0 && (
						<>
							<div className="sec-eyebrow">Topics</div>
							<ul>
								{topics.map((topic) => (
									<li key={topic.title}>
										<b>{topic.title}</b>
										{topic.body ? ` — ${topic.body}` : ""}
									</li>
								))}
							</ul>
						</>
					)}

					{nextSteps.length > 0 && (
						<>
							<div className="sec-eyebrow">Next steps</div>
							<ul>
								{nextSteps.map((step) => (
									<li key={step}>{step}</li>
								))}
							</ul>
						</>
					)}

					{topics.length === 0 && nextSteps.length === 0 && (
						<div className="rd-empty">No content available yet.</div>
					)}
				</div>
			)}
		</>
	);
}
