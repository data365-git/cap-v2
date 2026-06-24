"use client";

import type { Video } from "@cap/web-domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { getVideoStatus } from "@/actions/videos/get-status";
import "./generate-strip.css";

interface GenerateStripProps {
  videoId: string;
  transcriptionStatus?: string;
  aiGenerationStatus?: string;
  hasAiContent: boolean;
}

type StepState = "idle" | "active" | "done" | "error";

interface Step {
  key: string;
  label: string;
}

const STEPS: Step[] = [
  { key: "transcript", label: "Transkripsiya" },
  { key: "refined", label: "Tahrirlash" },
  { key: "summary", label: "Xulosa" },
  { key: "tasks", label: "Vazifalar" },
  { key: "rag", label: "AI indekslash" },
];

// Transcript terminal states
const TRANSCRIPT_COMPLETE = "COMPLETE";
const TRANSCRIPT_ERROR_STATES = new Set(["ERROR", "NO_AUDIO", "SKIPPED"]);

// AI terminal states
const AI_COMPLETE = "COMPLETE";
const AI_ERROR_STATES = new Set(["ERROR", "SKIPPED"]);

type StripPhase = "hidden" | "regen-link" | "idle" | "running" | "done" | "error-empty" | "error";

function deriveInitialPhase(
  transcriptionStatus: string | undefined,
  aiGenerationStatus: string | undefined,
  hasAiContent: boolean,
): StripPhase {
  // Already done and has real content → show quiet regen link
  if (
    transcriptionStatus === TRANSCRIPT_COMPLETE &&
    aiGenerationStatus === AI_COMPLETE &&
    hasAiContent
  ) {
    return "regen-link";
  }

  // COMPLETE but empty → error-empty state
  if (aiGenerationStatus === AI_COMPLETE && !hasAiContent) {
    return "error-empty";
  }

  // Error/skipped states
  if (
    aiGenerationStatus && AI_ERROR_STATES.has(aiGenerationStatus) ||
    transcriptionStatus && TRANSCRIPT_ERROR_STATES.has(transcriptionStatus)
  ) {
    return "error";
  }

  return "idle";
}

export function GenerateStrip({
  videoId,
  transcriptionStatus: initialTranscriptionStatus,
  aiGenerationStatus: initialAiGenerationStatus,
  hasAiContent,
}: GenerateStripProps) {
  const router = useRouter();
  const refreshedRef = useRef(false);

  const [phase, setPhase] = useState<StripPhase>(() =>
    deriveInitialPhase(
      initialTranscriptionStatus,
      initialAiGenerationStatus,
      hasAiContent,
    ),
  );

  const [stepStates, setStepStates] = useState<StepState[]>(() =>
    STEPS.map(() => "idle"),
  );
  const [subtitle, setSubtitle] = useState("AI yordamida tahlil qilish");
  const [errorMsg, setErrorMsg] = useState<string | null>(() => {
    if (initialAiGenerationStatus === AI_COMPLETE && !hasAiContent) {
      return "Kontent yaratilmadi — qayta urinib ko'ring.";
    }
    return null;
  });

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Which phase of the pipeline we're in: "transcript" or "ai"
  const pipelinePhaseRef = useRef<"transcript" | "ai">("transcript");
  // Track how many AI sub-steps we've advanced through (0–3 = steps 1-4)
  const aiStepIndexRef = useRef(0);

  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const markStepDone = useCallback((index: number) => {
    setStepStates((prev) => {
      const next = [...prev];
      next[index] = "done";
      return next;
    });
  }, []);

  const markStepActive = useCallback((index: number) => {
    setStepStates((prev) => {
      const next = [...prev];
      next[index] = "active";
      return next;
    });
  }, []);

  const markStepError = useCallback((index: number) => {
    setStepStates((prev) => {
      const next = [...prev];
      next[index] = "error";
      return next;
    });
  }, []);

  const pollAi = useCallback(
    (attempt: number) => {
      pollRef.current = setTimeout(async () => {
        try {
          const status = await getVideoStatus(videoId as Video.VideoId);
          if (status && "aiGenerationStatus" in status) {
            const aiStatus = status.aiGenerationStatus;

            if (aiStatus === AI_COMPLETE) {
              // Mark all remaining AI steps done
              setStepStates(["done", "done", "done", "done", "done"]);
              setSubtitle("Hammasi tayyor");
              setPhase("done");
              // Fire router.refresh() exactly once when we reach success
              if (!refreshedRef.current) {
                refreshedRef.current = true;
                router.refresh();
              }
              return;
            }

            if (aiStatus && AI_ERROR_STATES.has(aiStatus)) {
              const activeAiStep = Math.min(1 + aiStepIndexRef.current, 4);
              markStepError(activeAiStep);
              // Detect specific failure modes and surface targeted messages
              const aiDetail = ((status as Record<string, unknown>).aiGenerationError as string | undefined) ?? "";
              if (/429|rate.limit|cost.cap/i.test(aiDetail)) {
                setErrorMsg("Lavozimga yetdik. Boshqa generatsiya keyinroq.");
              } else if (/truncat|too long|too large/i.test(aiDetail)) {
                setErrorMsg("Transkripsiya yarim qoldi. Qayta urinish.");
              } else {
                setErrorMsg("AI generation failed. Please try again.");
              }
              setPhase("error");
              return;
            }

            // Advance AI sub-steps visually while still PROCESSING/QUEUED
            // Steps 1-4 (indices 1-4) spread over poll attempts
            const currentAiStep = Math.min(
              1 + Math.floor(attempt / 3),
              4,
            );
            if (currentAiStep > aiStepIndexRef.current + 1) {
              const prev = aiStepIndexRef.current + 1;
              for (let i = prev; i < currentAiStep; i++) {
                markStepDone(i);
              }
              markStepActive(currentAiStep);
              aiStepIndexRef.current = currentAiStep - 1;

              const subLabels = [
                "Tahrirlash…",
                "Xulosa tuzilmoqda…",
                "Vazifalar aniqlanmoqda…",
                "AI suhbat uchun indekslanmoqda…",
              ];
              setSubtitle(subLabels[currentAiStep - 1] ?? "Qayta ishlanmoqda…");
            }
          }
        } catch {
          // Ignore transient errors and keep polling
        }

        if (attempt < 90) {
          pollAi(attempt + 1);
        } else {
          setPhase("error");
          setErrorMsg("Still working — refresh the page in a moment.");
        }
      }, 4000);
    },
    [videoId, markStepDone, markStepActive, markStepError, router],
  );

  const startAiPhase = useCallback(async () => {
    pipelinePhaseRef.current = "ai";
    aiStepIndexRef.current = 0;
    // Mark step 1 (Tahrirlash) active
    markStepActive(1);
    setSubtitle("Transkript tahrirlanmoqda…");

    try {
      const res = await fetch(`/api/videos/${videoId}/retry-ai`, {
        method: "POST",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        markStepError(1);
        if (res.status === 429 || /rate.limit|cost.cap/i.test(body?.error ?? "")) {
          setErrorMsg("Lavozimga yetdik. Boshqa generatsiya keyinroq.");
        } else {
          setErrorMsg(body?.error ?? "AI generation failed.");
        }
        setPhase("error");
        return;
      }
      pollAi(0);
    } catch {
      markStepError(1);
      setErrorMsg("Could not start AI generation.");
      setPhase("error");
    }
  }, [videoId, markStepActive, markStepError, pollAi]);

  const pollTranscript = useCallback(
    (attempt: number) => {
      pollRef.current = setTimeout(async () => {
        try {
          const status = await getVideoStatus(videoId as Video.VideoId);
          if (status && "transcriptionStatus" in status) {
            const ts = status.transcriptionStatus;

            if (ts === TRANSCRIPT_COMPLETE) {
              markStepDone(0);
              setSubtitle("Transkript tayyor, AI tahlil boshlanmoqda…");
              await startAiPhase();
              return;
            }

            if (ts && TRANSCRIPT_ERROR_STATES.has(ts)) {
              markStepError(0);
              // "NO_AUDIO" is a specific known truncation-like case
              if (ts === "NO_AUDIO") {
                setErrorMsg("Transkripsiya yarim qoldi. Qayta urinish.");
              } else {
                setErrorMsg("Transcription failed. Please try again.");
              }
              setPhase("error");
              return;
            }
          }
        } catch {
          // Ignore transient errors
        }

        if (attempt < 90) {
          pollTranscript(attempt + 1);
        } else {
          setPhase("error");
          setErrorMsg("Still working — refresh the page in a moment.");
        }
      }, 4000);
    },
    [videoId, markStepDone, markStepError, startAiPhase],
  );

  // Shared pipeline kick-off used by both Generate and Retry buttons
  const kickOffPipeline = useCallback(async (skipTranscript: boolean) => {
    setErrorMsg(null);
    refreshedRef.current = false;
    setPhase("running");
    setStepStates(["active", "idle", "idle", "idle", "idle"]);
    setSubtitle("Audio matnga aylantirilmoqda…");
    pipelinePhaseRef.current = "transcript";
    aiStepIndexRef.current = 0;

    if (skipTranscript) {
      // Transcription already done — jump straight to AI phase
      setStepStates(["done", "active", "idle", "idle", "idle"]);
      setSubtitle("Transkript tayyor, AI tahlil boshlanmoqda…");
      await startAiPhase();
      return;
    }

    try {
      const res = await fetch(
        `/api/videos/${videoId}/retry-transcription`,
        { method: "POST" },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setStepStates(["error", "idle", "idle", "idle", "idle"]);
        setErrorMsg(body?.error ?? "Could not start transcription.");
        setPhase("error");
        return;
      }
      pollTranscript(0);
    } catch {
      setStepStates(["error", "idle", "idle", "idle", "idle"]);
      setErrorMsg("Could not start generation.");
      setPhase("error");
    }
  }, [videoId, pollTranscript, startAiPhase]);

  const onGenerate = useCallback(async () => {
    if (phase === "running") return;
    const transcriptAlreadyDone =
      initialTranscriptionStatus === TRANSCRIPT_COMPLETE;
    await kickOffPipeline(transcriptAlreadyDone);
  }, [phase, initialTranscriptionStatus, kickOffPipeline]);

  const onRetry = useCallback(async () => {
    await kickOffPipeline(false);
  }, [kickOffPipeline]);

  const onRegenerate = useCallback(async () => {
    setPhase("running");
    setStepStates(["active", "idle", "idle", "idle", "idle"]);
    setSubtitle("Audio matnga aylantirilmoqda…");
    setErrorMsg(null);
    refreshedRef.current = false;
    pipelinePhaseRef.current = "transcript";
    aiStepIndexRef.current = 0;
    await kickOffPipeline(false);
  }, [kickOffPipeline]);

  // Quiet regen link — shown when content already exists
  if (phase === "regen-link") {
    return (
      <button
        type="button"
        className="cap-regen-link"
        onClick={onRegenerate}
      >
        Qayta generatsiya
      </button>
    );
  }

  const isRunning = phase === "running";
  const isDone = phase === "done";
  const isError = phase === "error" || phase === "error-empty";
  const showSteps = isRunning || isDone;

  return (
    <div
      className={["gen-strip", isDone ? "is-done" : "", isError ? "is-error" : ""].filter(Boolean).join(" ")}
    >
      {/* Blurred drifting aura */}
      <div className="gen-aura" aria-hidden="true" />

      {/* Main row: orb + text + button */}
      <div className="gen-main">
        {/* Spark orb icon */}
        <div className={["gen-orb", isError ? "error" : ""].filter(Boolean).join(" ")} aria-hidden="true">
          {isError ? (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          ) : (
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            </svg>
          )}
        </div>

        {/* Title + live subtitle */}
        <div className="gen-text">
          <div className="gen-title">
            {isError ? "Xato yuz berdi" : "AI insights tayyorlash"}
          </div>
          <div className="gen-sub">
            {isError
              ? (errorMsg ?? "Qayta urinib ko'ring.")
              : subtitle}
          </div>
        </div>

        {/* Primary / Retry button */}
        {isError ? (
          <button
            type="button"
            className="gen-btn gen-btn--retry"
            onClick={onRetry}
            aria-label="Retry generation"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span className="gen-btn-text">Retry</span>
          </button>
        ) : (
          <button
            type="button"
            className="gen-btn"
            onClick={onGenerate}
            disabled={isRunning || isDone}
            aria-label={isDone ? "Generation complete" : isRunning ? "Generation in progress" : "Generate content"}
          >
            {isRunning ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                className="animate-spin"
                aria-hidden="true"
              >
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
              </svg>
            )}
            <span className="gen-btn-text">
              {isDone ? "Bajarildi" : isRunning ? "Jarayonda…" : "Generatsiya qilish"}
            </span>
            {!isRunning && !isDone && (
              <span className="gen-btn-shimmer" aria-hidden="true" />
            )}
          </button>
        )}
      </div>

      {/* 5-step pipeline row */}
      <div className={["gen-steps", showSteps ? "visible" : ""].filter(Boolean).join(" ")}>
        {STEPS.map((step, i) => (
          <div
            key={step.key}
            className={["gen-step", stepStates[i]].filter(Boolean).join(" ")}
          >
            <span className="gs-ic" aria-hidden="true">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                {i === 0 && (
                  // Mic icon for Transkripsiya
                  <>
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </>
                )}
                {i === 1 && (
                  // Edit icon for Tahrirlash
                  <>
                    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                  </>
                )}
                {i === 2 && (
                  // List icon for Xulosa
                  <>
                    <line x1="8" y1="6" x2="21" y2="6" />
                    <line x1="8" y1="12" x2="21" y2="12" />
                    <line x1="8" y1="18" x2="21" y2="18" />
                    <line x1="3" y1="6" x2="3.01" y2="6" />
                    <line x1="3" y1="12" x2="3.01" y2="12" />
                    <line x1="3" y1="18" x2="3.01" y2="18" />
                  </>
                )}
                {i === 3 && (
                  // Check-square icon for Vazifalar
                  <>
                    <polyline points="9 11 12 14 22 4" />
                    <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
                  </>
                )}
                {i === 4 && (
                  // Spark/AI icon for AI indekslash
                  <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
                )}
              </svg>
            </span>
            <span className="gs-lbl">{step.label}</span>
            <span className="gs-state" aria-hidden="true" />
          </div>
        ))}
      </div>

      {/* Per-step error message — only shown during running, not in error state (subtitle handles it) */}
      {errorMsg && phase === "running" && <p className="gen-error">{errorMsg}</p>}
    </div>
  );
}
