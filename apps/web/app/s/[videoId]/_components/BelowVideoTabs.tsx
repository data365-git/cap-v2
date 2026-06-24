"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
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
	isOwner?: boolean;
}

export function BelowVideoTabs({
	summary,
	tasks,
	transcript,
	refined,
	isOwner: _isOwner = false,
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

	// FIX 2 — sliding indicator pill
	const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});
	const [indicatorStyle, setIndicatorStyle] = useState<{ left: number; width: number }>({ left: 0, width: 0 });

	const updateIndicator = useCallback((id: TabId) => {
		const btn = tabRefs.current[id];
		if (btn) {
			setIndicatorStyle({ left: btn.offsetLeft, width: btn.offsetWidth });
		}
	}, []);

	// Update indicator on mount and whenever activeTab changes
	useEffect(() => {
		updateIndicator(activeTab);
	}, [activeTab, updateIndicator]);

	// FIX 3 — per-tab scroll memory
	const scrollPositions = useRef<Partial<Record<TabId, number>>>({});
	const panelRef = useRef<HTMLDivElement | null>(null);

	const handleTabClick = useCallback(
		(id: TabId) => {
			// Save current panel's scroll before switching
			if (panelRef.current) {
				scrollPositions.current[activeTab] = panelRef.current.scrollTop;
			}

			setActiveTab(id);
			const params = new URLSearchParams(searchParams.toString());
			params.set("tab", id);
			router.replace(`?${params.toString()}`, { scroll: false });
		},
		[router, searchParams, activeTab],
	);

	// Restore scroll after panel content renders
	useLayoutEffect(() => {
		const saved = scrollPositions.current[activeTab];
		if (panelRef.current && saved !== undefined) {
			panelRef.current.scrollTop = saved;
		}
	}, [activeTab]);

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
							id={`tab-${tab.id}`}
							role="tab"
							aria-selected={activeTab === tab.id}
							aria-controls={`panel-${tab.id}`}
							className={`bv-tab${activeTab === tab.id ? " active" : ""}`}
							ref={(el) => { tabRefs.current[tab.id] = el; }}
							onClick={() => handleTabClick(tab.id)}
						>
							{tab.label}
						</button>
					))}
					<div
						className="bv-tab-indicator"
						style={{ left: indicatorStyle.left, width: indicatorStyle.width }}
					/>
				</div>

				{/* One panel at a time. `panelIn` only translates (never opacity 0) so
				    the content stays visible for print/PDF. key forces the animation. */}
				<div
					className="bv-panel"
					key={activeTab}
					id={`panel-${activeTab}`}
					role="tabpanel"
					aria-labelledby={`tab-${activeTab}`}
					ref={panelRef}
				>
					{content[activeTab]}
				</div>
			</section>
		</div>
	);
}
