"use client";

import type { Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getVideoStatus } from "@/actions/videos/get-status";

type Kind = "transcript" | "ai";

interface GenerateSectionProps {
	videoId: string;
	/** "transcript" → POST retry-transcription; "ai" → POST retry-ai (summary/tasks/refined). */
	kind: Kind;
	/** Button label, e.g. "Generate transcript". */
	label: string;
	/** Helper text shown above the button (the section's empty-state message). */
	description?: string;
	/** For kind="ai": whether the transcript is COMPLETE (AI needs it first). */
	transcriptReady?: boolean;
}

// On-demand AI generation. Nothing runs until the user clicks — clicking POSTs the
// trigger endpoint, polls getVideoStatus until the relevant status is terminal, then
// refreshes server data so the freshly generated section renders.
export function GenerateSection({
	videoId,
	kind,
	label,
	description,
	transcriptReady = true,
}: GenerateSectionProps) {
	const router = useRouter();
	const [generating, setGenerating] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (pollRef.current) clearTimeout(pollRef.current);
		},
		[],
	);

	const needsTranscriptFirst = kind === "ai" && !transcriptReady;

	const poll = useCallback(
		(attempt: number) => {
			pollRef.current = setTimeout(async () => {
				try {
					const status = await getVideoStatus(videoId as Video.VideoId);
					if (status && "transcriptionStatus" in status) {
						const terminal =
							kind === "transcript"
								? status.transcriptionStatus === "COMPLETE" ||
									status.transcriptionStatus === "ERROR" ||
									status.transcriptionStatus === "NO_AUDIO" ||
									status.transcriptionStatus === "SKIPPED"
								: status.aiGenerationStatus === "COMPLETE" ||
									status.aiGenerationStatus === "ERROR" ||
									status.aiGenerationStatus === "SKIPPED";

						if (terminal) {
							const failed =
								kind === "transcript"
									? status.transcriptionStatus === "ERROR"
									: status.aiGenerationStatus === "ERROR";
							setGenerating(false);
							if (failed) setError("Generation failed. Please try again.");
							router.refresh();
							return;
						}
					}
				} catch {
					// Ignore transient polling errors and keep waiting.
				}

				if (attempt < 90) {
					poll(attempt + 1);
				} else {
					setGenerating(false);
					setError("Still working — refresh the page in a moment.");
				}
			}, 4000);
		},
		[videoId, kind, router],
	);

	const onGenerate = useCallback(async () => {
		setError(null);
		setGenerating(true);
		try {
			const endpoint =
				kind === "transcript"
					? `/api/videos/${videoId}/retry-transcription`
					: `/api/videos/${videoId}/retry-ai`;
			const res = await fetch(endpoint, { method: "POST" });
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as { error?: string };
				setGenerating(false);
				setError(body?.error ?? "Could not start generation.");
				return;
			}
			poll(0);
		} catch {
			setGenerating(false);
			setError("Could not start generation.");
		}
	}, [kind, videoId, poll]);

	return (
		<div className="flex flex-col items-center gap-3">
			{description && (
				<p className="text-sm text-gray-500 text-center">{description}</p>
			)}
			{needsTranscriptFirst ? (
				<p className="text-xs text-gray-400 text-center">
					Generate the transcript first to enable this.
				</p>
			) : (
				<button
					type="button"
					onClick={onGenerate}
					disabled={generating}
					className="inline-flex items-center gap-2 rounded-lg bg-purple-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-purple-700 disabled:cursor-not-allowed disabled:opacity-60"
				>
					{generating ? (
						<>
							<span className="size-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
							Generating…
						</>
					) : (
						label
					)}
				</button>
			)}
			{error && <p className="text-xs text-red-500 text-center">{error}</p>}
		</div>
	);
}
