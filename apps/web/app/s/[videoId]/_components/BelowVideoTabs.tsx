"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import "./share-redesign.css";

type TabId = "summary" | "tasks" | "transcript" | "refined";

const TABS: { id: TabId; label: string }[] = [
	{ id: "summary", label: "Summary" },
	{ id: "tasks", label: "Tasks" },
	{ id: "transcript", label: "Transcript" },
	{ id: "refined", label: "Refined" },
];

interface BelowVideoTabsProps {
	summary?: React.ReactNode;
	tasks?: React.ReactNode;
	transcript?: React.ReactNode;
	refined?: React.ReactNode;
}

export function BelowVideoTabs({
	summary,
	tasks,
	transcript,
	refined,
}: BelowVideoTabsProps) {
	const searchParams = useSearchParams();
	const router = useRouter();

	const rawParam = searchParams.get("tab");
	const initialTab: TabId =
		rawParam === "tasks" ||
		rawParam === "transcript" ||
		rawParam === "refined" ||
		rawParam === "summary"
			? rawParam
			: "summary";

	const [activeTab, setActiveTab] = useState<TabId>(initialTab);

	const handleTabClick = useCallback(
		(id: TabId) => {
			setActiveTab(id);
			// Keep the active tab shareable via the URL (no scroll jump).
			const params = new URLSearchParams(searchParams.toString());
			params.set("tab", id);
			router.replace(`?${params.toString()}`, { scroll: false });
		},
		[router, searchParams],
	);

	const content: Record<TabId, React.ReactNode> = {
		summary,
		tasks,
		transcript,
		refined,
	};

	return (
		<div className="share-rd">
			<section className="below-video-tabs">
				<div className="bv-tab-bar" role="tablist" aria-label="Recording details">
					{TABS.map((tab) => (
						<button
							key={tab.id}
							type="button"
							role="tab"
							aria-selected={activeTab === tab.id}
							className={`bv-tab${activeTab === tab.id ? " active" : ""}`}
							onClick={() => handleTabClick(tab.id)}
						>
							{tab.label}
						</button>
					))}
				</div>

				{/* One panel at a time. `panelIn` only translates (never opacity 0) so
				    the content stays visible for print/PDF. key forces the animation. */}
				<div className="bv-panel" key={activeTab} role="tabpanel">
					{content[activeTab]}
				</div>
			</section>
		</div>
	);
}
