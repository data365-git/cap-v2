"use client";

import { useStore } from "@tanstack/react-store";
import Link from "next/link";
import { useEffect, useRef } from "react";
import {
	useUploadingContext,
} from "@/app/(org)/dashboard/caps/UploadingContext";
import { usePipelineProgress } from "./usePipelineProgress";

function UploadProgressContent() {
	const { uploadingStore, cancelCurrent, dismissProcessing } = useUploadingContext();
	const uploadStatus = useStore(uploadingStore, (s) => s.uploadStatus);

	const processingCapId =
		uploadStatus?.status === "processing" ? uploadStatus.capId : null;

	const { phases, currentPhase, isComplete } = usePipelineProgress(processingCapId);

	const autoDismissRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		if (isComplete && uploadStatus?.status === "processing") {
			autoDismissRef.current = setTimeout(() => {
				dismissProcessing();
			}, 2000);
		}
		return () => {
			if (autoDismissRef.current) {
				clearTimeout(autoDismissRef.current);
				autoDismissRef.current = null;
			}
		};
	}, [isComplete, uploadStatus?.status, dismissProcessing]);

	if (!uploadStatus) return null;

	const { status } = uploadStatus;

	const progressPercent =
		uploadStatus && "progress" in uploadStatus
			? Math.round((uploadStatus as { progress: number }).progress)
			: null;

	const activePhaseLabel = phases?.find((p) => p.status === "active")?.label ?? currentPhase ?? null;

	const isUploadPhase =
		status === "parsing" ||
		status === "creating" ||
		status === "converting" ||
		status === "uploadingThumbnail" ||
		status === "uploadingVideo";

	const labelMap: Record<string, string> = {
		parsing: "Analyzing file...",
		creating: "Preparing upload...",
		converting: "Converting...",
		uploadingThumbnail: "Uploading thumbnail...",
		uploadingVideo:
			progressPercent !== null ? `Uploading ${progressPercent}%` : "Uploading...",
		serverProcessing: "Starting processing...",
		processing: isComplete
			? "Processing complete"
			: activePhaseLabel
				? `${activePhaseLabel}…`
				: "Processing...",
	};

	const label = labelMap[status] ?? "Working...";

	return (
		<div
			role="status"
			aria-live="polite"
			aria-label={`Upload status: ${label}`}
			className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2 flex flex-col gap-2 rounded-xl border border-gray-4 bg-gray-12 px-4 py-3 shadow-lg"
			style={{ minWidth: 360, maxWidth: 560 }}
		>
			{/* Top row: icon + label + actions */}
			<div className="flex items-center gap-3">
				{/* Spinner or check icon */}
				<span aria-hidden="true" className="shrink-0">
					{isComplete ? (
						<svg
							className="size-4 text-green-500"
							viewBox="0 0 20 20"
							fill="currentColor"
						>
							<path
								fillRule="evenodd"
								d="M16.707 5.293a1 1 0 00-1.414 0L8 12.586 4.707 9.293a1 1 0 00-1.414 1.414l4 4a1 1 0 001.414 0l8-8a1 1 0 000-1.414z"
								clipRule="evenodd"
							/>
						</svg>
					) : (
						<span className="block size-4 rounded-full border-2 border-gray-6 border-t-blue-10 animate-spin" />
					)}
				</span>

				{/* Label */}
				<span className="flex-1 truncate text-sm font-medium text-gray-1">
					{label}
				</span>

				{/* Action buttons */}
				<div className="flex items-center gap-2 shrink-0">
					{isUploadPhase && (
						<button
							type="button"
							onClick={cancelCurrent}
							className="rounded-md px-2 py-1 text-xs font-medium text-gray-5 hover:text-gray-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-10"
						>
							Cancel
						</button>
					)}

					{status === "processing" && (
						<>
							{uploadStatus.capId && (
								<Link
									href={`/s/${uploadStatus.capId}`}
									className="rounded-md px-2 py-1 text-xs font-medium text-blue-10 hover:text-blue-11 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-10"
								>
									View
								</Link>
							)}
							<button
								type="button"
								onClick={dismissProcessing}
								className="rounded-md px-2 py-1 text-xs font-medium text-gray-5 hover:text-gray-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-10"
							>
								Dismiss
							</button>
						</>
					)}
				</div>
			</div>

			{/* Progress bar — only during upload phases with known progress */}
			{isUploadPhase && progressPercent !== null && (
				<div className="w-full h-1.5 rounded-full bg-gray-10 overflow-hidden">
					<div
						className="h-full rounded-full bg-blue-10 transition-all duration-300"
						style={{ width: `${progressPercent}%` }}
					/>
				</div>
			)}

			{/* Phase chips during processing */}
			{status === "processing" && phases && phases.length > 0 && (
				<div className="flex flex-wrap gap-1.5 mt-0.5">
					{phases.map((phase) => (
						<span
							key={phase.key}
							className={[
								"inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
								phase.status === "done"
									? "bg-green-10/20 text-green-500"
									: phase.status === "active"
										? "bg-blue-10/20 text-blue-10"
										: "bg-gray-10/20 text-gray-6",
							].join(" ")}
						>
							{phase.status === "done" ? (
								<span aria-hidden="true">✓</span>
							) : phase.status === "active" ? (
								<span
									aria-hidden="true"
									className="block size-2 rounded-full border border-blue-10 border-t-transparent animate-spin"
								/>
							) : null}
							{phase.label}
						</span>
					))}
				</div>
			)}
		</div>
	);
}

export function GlobalUploadProgressBar() {
	return <UploadProgressContent />;
}
