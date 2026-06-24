"use client";

import { useQuery } from "@tanstack/react-query";
import { Database, FileText, LayoutGrid, MessageSquare } from "lucide-react";
import { getMonthlySpend } from "@/actions/billing/get-monthly-spend";
import "../share-redesign.css";

interface MeetingCostPanelProps {
	videoId: string;
}

// USD → UZS display rate (placeholder; wire to a real FX source if needed).
const RATE = 12950;

function formatUsd(cents: number): string {
	return `$${(cents / 100).toFixed(4)}`;
}
function formatUzs(cents: number): string {
	const uzs = Math.round((cents / 100) * RATE);
	return `${uzs.toLocaleString("en-US").replace(/,/g, " ")} so'm`;
}

const OPERATIONS: { key: string; label: string; icon: React.ReactNode }[] = [
	{ key: "transcription", label: "Transcription", icon: <FileText /> },
	{ key: "summary", label: "Summary", icon: <LayoutGrid /> },
	{ key: "embedding", label: "Embeddings", icon: <Database /> },
	{ key: "chat", label: "Chat", icon: <MessageSquare /> },
];

export function MeetingCostPanel({ videoId }: MeetingCostPanelProps) {
	const { data, isLoading, error } = useQuery({
		queryKey: ["cost", videoId],
		queryFn: () => getMonthlySpend({ type: "video", id: videoId }),
		staleTime: 60_000,
	});

	if (isLoading) return null;

	if (error || !data) {
		return (
			<div className="share-rd">
				<div className="rd-empty" style={{ color: "#dc2626" }}>
					Could not load cost data.
				</div>
			</div>
		);
	}

	if (data.totalUsdCents <= 0) return null;

	const items = OPERATIONS.map((op) => ({
		...op,
		cents: data.breakdown[op.key] ?? 0,
	})).filter((op) => op.cents > 0);

	return (
		<div className="share-rd">
			<div className="cost-card">
				<div className="cost-head">
					<span className="cost-title">Xarajat</span>
					<span className="cost-rate">1$ = {RATE.toLocaleString("en-US").replace(/,/g, " ")} so'm</span>
				</div>

				{items.length > 0 && (
					<div className="cost-items">
						{items.map((op) => (
							<div className="cost-item" key={op.key}>
								<span className="cost-ic">{op.icon}</span>
								<span className="cost-item-name">{op.label}</span>
								<span className="cost-vals">
									<div className="cost-usd">{formatUsd(op.cents)}</div>
									<div className="cost-uzs">{formatUzs(op.cents)}</div>
								</span>
							</div>
						))}
					</div>
				)}

				<div className="cost-total">
					<span className="cost-total-label">Jami</span>
					<span style={{ textAlign: "right" }}>
						<div className="cost-total-usd">{formatUsd(data.totalUsdCents)}</div>
						<div className="cost-total-uzs">{formatUzs(data.totalUsdCents)}</div>
					</span>
				</div>
			</div>
		</div>
	);
}
