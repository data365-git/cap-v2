"use client";

import { Clock, LayoutGrid, List } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { GenerateSection } from "../GenerateSection";
import { RichText } from "../RichText";

interface Task {
	title: string;
	assignee?: string;
	priority?: "high" | "medium" | "low";
	deadline?: string;
	done: boolean;
}

interface TasksPanelProps {
	videoId: string;
	transcriptionStatus?: string | null;
	tasks?: Task[];
	isOwner?: boolean;
}

type TasksMode = "board" | "checklist";

const PRIORITY_ORDER: Array<"high" | "medium" | "low" | undefined> = [
	"high",
	"medium",
	"low",
	undefined,
];

const GROUP_LABEL: Record<string, string> = {
	high: "High priority",
	medium: "Medium priority",
	low: "Low priority",
	none: "No priority",
};

function initials(name: string): string {
	const parts = name.trim().split(/\s+/);
	return (
		parts.length >= 2
			? (parts[0]?.[0] ?? "") + (parts[parts.length - 1]?.[0] ?? "")
			: name.slice(0, 2)
	).toUpperCase();
}

const AVATAR_COLORS = ["#475569", "#2563eb", "#0ea5e9", "#7c3aed", "#0d9488"];
function avatarColor(name: string): string {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
	return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? "#475569";
}

export function TasksPanel({
	videoId,
	transcriptionStatus,
	tasks: initialTasks = [],
	isOwner = false,
}: TasksPanelProps) {
	const [mode, setMode] = useState<TasksMode>("board");
	const [tasks, setTasks] = useState<Task[]>(initialTasks);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Persist the Board/Checklist choice (design: localStorage key `taskView`).
	useEffect(() => {
		const saved = localStorage.getItem("taskView");
		if (saved === "checklist" || saved === "board") setMode(saved);
	}, []);
	const setView = (v: TasksMode) => {
		setMode(v);
		localStorage.setItem("taskView", v);
	};

	const done = tasks.filter((t) => t.done).length;
	const total = tasks.length;
	const pct = total === 0 ? 0 : Math.round((done / total) * 100);

	function toggle(index: number) {
		setTasks((prev) => {
			const next = prev.map((t, i) => (i === index ? { ...t, done: !t.done } : t));
			if (debounceRef.current) clearTimeout(debounceRef.current);
			debounceRef.current = setTimeout(() => {
				fetch("/api/video/tasks/toggle", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						videoId,
						taskIndex: index,
						done: next[index]?.done,
					}),
				}).catch(() => undefined);
			}, 400);
			return next;
		});
	}

	if (total === 0) {
		return (
			<div className="rd-empty">
				{isOwner ? (
					<GenerateSection
						videoId={videoId}
						kind="ai"
						label="Generate tasks"
						description="No tasks extracted from this meeting"
						transcriptReady={transcriptionStatus === "COMPLETE"}
					/>
				) : (
					"No tasks available yet."
				)}
			</div>
		);
	}

	const groups = PRIORITY_ORDER.map((p) => ({
		key: p ?? "none",
		label: GROUP_LABEL[p ?? "none"],
		items: tasks.map((t, i) => ({ t, i })).filter(({ t }) => t.priority === p),
	})).filter(({ items }) => items.length > 0);

	return (
		<>
			{/* Progress header */}
			<div className="tasks-head">
				<div className="th-top">
					<span className="t">
						{done} / {total} done
					</span>
					<span className="th-pct">{pct}%</span>
				</div>
				<div className="th-bar">
					<div className="th-bar-fill" style={{ width: `${pct}%` }} />
				</div>
				<div className="s">Extracted action items from this meeting</div>
			</div>

			{/* View switch */}
			<div className="tasks-toolbar">
				<div className="tasks-switch" role="tablist" aria-label="Tasks view">
					<button
						type="button"
						className={`tasks-switch-btn${mode === "board" ? " active" : ""}`}
						onClick={() => setView("board")}
					>
						<LayoutGrid /> Board
					</button>
					<button
						type="button"
						className={`tasks-switch-btn${mode === "checklist" ? " active" : ""}`}
						onClick={() => setView("checklist")}
					>
						<List /> Checklist
					</button>
				</div>
			</div>

			<div className="tasks-wrap" data-tasks={mode}>
				{groups.map((g) => (
					<div className="task-group" key={g.key}>
						<div className="task-group-header">
							{g.label}
							<span className="task-group-count">{g.items.length}</span>
						</div>
						<div className="task-grid">
							{g.items.map(({ t, i }) => {
								const prioClass = t.done
									? "is-done"
									: t.priority === "high"
										? "p-high"
										: t.priority === "medium"
											? "p-med"
											: t.priority === "low"
												? "p-low"
												: "";
								return (
									<div className={`task-card ${prioClass}`} key={i}>
										<button
											type="button"
											aria-label={t.done ? "Mark not done" : "Mark done"}
											className={`task-check${t.done ? " done" : ""}`}
											onClick={() => toggle(i)}
										/>
										<div className="task-body">
											<div className="task-title"><RichText inline>{t.title}</RichText></div>
											{(t.assignee || t.deadline) && (
												<div className="task-meta">
													{t.assignee && (
														<span className="task-assignee">
															<span
																className="assignee-av"
																style={{ background: avatarColor(t.assignee) }}
															>
																{initials(t.assignee)}
															</span>
															<span className="assignee-name">{t.assignee}</span>
														</span>
													)}
													{t.deadline && (
														<span className="task-tag deadline">
															<Clock /> {t.deadline}
														</span>
													)}
												</div>
											)}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				))}
			</div>
		</>
	);
}
