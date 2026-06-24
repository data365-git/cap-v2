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
	{ key: "transcription", label: "Transkripsiya", icon: <FileText /> },
	{
		key: "summary",
		label: "AI tahlil (xulosa·vazifalar·tahrir)",
		icon: <LayoutGrid />,
	},
	{ key: "embedding", label: "RAG indekslash", icon: <Database /> },
	{ key: "chat", label: "AI suhbat", icon: <MessageSquare /> },
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

	const items = OPERATIONS.map((op) => {
		const detail = data.breakdownDetail[op.key];
		const totalCents = data.breakdown[op.key] ?? 0;
		return {
			...op,
			cents: totalCents,
			successCents: detail?.successUsdCents ?? totalCents,
			failedCents: detail?.failedUsdCents ?? 0,
			successCount: detail?.successCount ?? 0,
			failedCount: detail?.failedCount ?? 0,
		};
	}).filter((op) => op.cents > 0);

	const totalFailedCents = data.totalFailedUsdCents ?? 0;

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
								<span className="cost-item-name">
									{op.label}
									{op.failedCount > 0 && (
										<span
											className="cost-outcome-badge"
											title={`${op.successCount} muvaffaqiyatli, ${op.failedCount} muvaffaqiyatsiz urinish`}
											aria-label={`${op.successCount} muvaffaqiyatli, ${op.failedCount} muvaffaqiyatsiz urinish`}
										>
											{" "}
											<span style={{ color: "#16a34a" }}>✓{op.successCount}</span>{" "}
											<span style={{ color: "#dc2626" }}>✗{op.failedCount}</span>
										</span>
									)}
								</span>
								<span className="cost-vals">
									<div className="cost-usd">{formatUsd(op.successCents)}</div>
									<div className="cost-uzs">{formatUzs(op.successCents)}</div>
								</span>
							</div>
						))}
					</div>
				)}

				{totalFailedCents > 0 && (
					<div
						className="cost-item cost-failed-line"
						style={{ opacity: 0.7, fontSize: "0.85em" }}
					>
						<span className="cost-ic" style={{ color: "#dc2626" }}>✗</span>
						<span className="cost-item-name" style={{ color: "#dc2626" }}>
							Muvaffaqiyatsiz urinishlar
						</span>
						<span className="cost-vals">
							<div className="cost-usd" style={{ color: "#dc2626" }}>{formatUsd(totalFailedCents)}</div>
							<div className="cost-uzs" style={{ color: "#dc2626" }}>{formatUzs(totalFailedCents)}</div>
						</span>
					</div>
				)}

				<div className="cost-total">
					<span className="cost-total-label">
						Jami
						{totalFailedCents > 0 && (
							<span
								style={{ fontSize: "0.75em", fontWeight: 400, opacity: 0.6, marginLeft: 4 }}
							>
								(muvaffaqiyatsizlar bilan)
							</span>
						)}
					</span>
					<span style={{ textAlign: "right" }}>
						<div className="cost-total-usd">{formatUsd(data.totalUsdCents)}</div>
						<div className="cost-total-uzs">{formatUzs(data.totalUsdCents)}</div>
					</span>
				</div>
			</div>
		</div>
	);
}
