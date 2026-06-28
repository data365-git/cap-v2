"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getVideoStatus } from "@/actions/videos/get-status";
import type { Video } from "@cap/web-domain";

export interface PipelinePhase {
	key: "audio" | "transcribe" | "analyze" | "index";
	label: string;
	status: "queued" | "active" | "done" | "error";
	done: number;
	total: number;
}

interface UsePipelineProgressResult {
	phases: PipelinePhase[] | null;
	currentPhase: string | null;
	isComplete: boolean;
}

const POLL_INTERVAL_MS = 3000;

export function usePipelineProgress(videoId: string | null): UsePipelineProgressResult {
	const [phases, setPhases] = useState<PipelinePhase[] | null>(null);
	const [currentPhase, setCurrentPhase] = useState<string | null>(null);
	const [isComplete, setIsComplete] = useState(false);
	const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const activeVideoIdRef = useRef<string | null>(null);

	const stopPolling = useCallback(() => {
		if (pollRef.current) {
			clearTimeout(pollRef.current);
			pollRef.current = null;
		}
	}, []);

	const scheduleNextPoll = useCallback(
		(id: string) => {
			pollRef.current = setTimeout(async () => {
				// If videoId changed while we waited, bail
				if (activeVideoIdRef.current !== id) return;

				try {
					const status = await getVideoStatus(id as Video.VideoId);
					if (!status || "success" in status) return;

					const pp = (status as unknown as Record<string, unknown>).pipelineProgress as
						| { currentPhase: string; phases: PipelinePhase[] }
						| undefined;

					if (pp) {
						setPhases(pp.phases);
						setCurrentPhase(pp.currentPhase);
					}

					const aiStatus = status.aiGenerationStatus;
					if (aiStatus === "COMPLETE") {
						setIsComplete(true);
						return; // stop polling
					}

					// Continue polling if not terminal
					if (activeVideoIdRef.current === id) {
						scheduleNextPoll(id);
					}
				} catch {
					// Ignore transient errors, keep polling
					if (activeVideoIdRef.current === id) {
						scheduleNextPoll(id);
					}
				}
			}, POLL_INTERVAL_MS);
		},
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[],
	);

	useEffect(() => {
		stopPolling();
		activeVideoIdRef.current = videoId;

		if (!videoId) {
			setPhases(null);
			setCurrentPhase(null);
			setIsComplete(false);
			return;
		}

		setPhases(null);
		setCurrentPhase(null);
		setIsComplete(false);
		scheduleNextPoll(videoId);

		return () => {
			stopPolling();
		};
	}, [videoId, stopPolling, scheduleNextPoll]);

	return { phases, currentPhase, isComplete };
}
