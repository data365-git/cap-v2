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

// Transcript terminal states
const TRANSCRIPT_COMPLETE = "COMPLETE";
const TRANSCRIPT_ERROR_STATES = new Set(["ERROR", "NO_AUDIO", "SKIPPED"]);

// AI terminal states
const AI_COMPLETE = "COMPLETE";
const AI_ERROR_STATES = new Set(["ERROR", "SKIPPED"]);

type StripPhase = "hidden" | "regen-link" | "idle" | "running" | "done" | "error-empty" | "error";

// Phase weights for overall progress
const PHASE_WEIGHTS: Record<string, number> = {
  audio: 0.08,
  transcribe: 0.60,
  index: 0.12,
  analyze: 0.20,
};

// ETA constants (seconds)
const DEFAULT_CHUNK_SEC = 45;
const ANALYZE_SEC = 25;
const INDEX_SEC = 15;
const AUDIO_SEC = 20;

// Max upward nudge when re-anchoring ETA (10% of current)
const ETA_UP_CAP_RATIO = 0.10;

interface PipelinePhase {
  key: "audio" | "transcribe" | "analyze" | "index";
  label: string;
  status: "queued" | "active" | "done" | "error";
  done: number;
  total: number;
  startedAt?: string;
  completedAt?: string;
  unitTimesMs?: number[];
}

interface PipelineProgress {
  currentPhase: "audio" | "transcribe" | "analyze" | "index";
  phases: PipelinePhase[];
  startedAt: string;
  updatedAt: string;
}

function deriveInitialPhase(
  transcriptionStatus: string | undefined,
  aiGenerationStatus: string | undefined,
  hasAiContent: boolean,
): StripPhase {
  if (
    transcriptionStatus === TRANSCRIPT_COMPLETE &&
    aiGenerationStatus === AI_COMPLETE &&
    hasAiContent
  ) {
    return "regen-link";
  }
  if (aiGenerationStatus === AI_COMPLETE && !hasAiContent) {
    return "error-empty";
  }
  if (
    (aiGenerationStatus && AI_ERROR_STATES.has(aiGenerationStatus)) ||
    (transcriptionStatus && TRANSCRIPT_ERROR_STATES.has(transcriptionStatus))
  ) {
    return "error";
  }
  const IN_PROGRESS = new Set(["PROCESSING", "QUEUED"]);
  if (
    (transcriptionStatus && IN_PROGRESS.has(transcriptionStatus)) ||
    (aiGenerationStatus && IN_PROGRESS.has(aiGenerationStatus))
  ) {
    return "running";
  }
  return "idle";
}

function medianOf(values: number[]): number {
  if (values.length === 0) return DEFAULT_CHUNK_SEC * 1000;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function formatPhaseEta(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  if (m > 0) return `~${m}m ${s}s`;
  return `~${s}s`;
}

function computeRemainingConstants(phases: PipelinePhase[], excludeKey?: string): number {
  let extra = 0;
  for (const p of phases) {
    if (p.key === excludeKey) continue;
    if (p.status === "done") continue;
    if (p.key === "analyze") extra += ANALYZE_SEC;
    else if (p.key === "index") extra += INDEX_SEC;
    else if (p.key === "audio") extra += AUDIO_SEC;
  }
  return extra;
}

export function GenerateStrip({
  videoId,
  transcriptionStatus: initialTranscriptionStatus,
  aiGenerationStatus: initialAiGenerationStatus,
  hasAiContent,
}: GenerateStripProps) {
  const router = useRouter();
  const refreshedRef = useRef(false);
  const didResumeRef = useRef(false);
  // When the strip is resuming an in-flight generation (page refresh /
  // navigation), transcript completion during polling must NOT POST /retry-ai
  // — that would fire a second paid Gemini generation on top of the one
  // already running server-side. This flag tells pollTranscript's COMPLETE
  // branch to call pollAi(0) directly instead of startAiPhase().
  const resumeAiWithoutKickoffRef = useRef(false);

  const [phase, setPhase] = useState<StripPhase>(() =>
    deriveInitialPhase(
      initialTranscriptionStatus,
      initialAiGenerationStatus,
      hasAiContent,
    ),
  );

  const [errorMsg, setErrorMsg] = useState<string | null>(() => {
    if (initialAiGenerationStatus === AI_COMPLETE && !hasAiContent) {
      return "Kontent yaratilmadi — qayta urinib ko'ring.";
    }
    return null;
  });

  // Phase chips from pipelineProgress
  const [pipelinePhases, setPipelinePhases] = useState<PipelinePhase[]>([]);
  const [currentPhaseKey, setCurrentPhaseKey] = useState<string>("");
  const [activeLabel, setActiveLabel] = useState("Xulosa, vazifalar va tahrirlangan transkript yarating");

  // Subtitle text keyed to the active pipeline phase
  const [phaseSubtitle, setPhaseSubtitle] = useState("Xulosa, vazifalar va tahrirlangan transkript yarating");

  // Overall progress bar
  const [progressPct, setProgressPct] = useState(0);
  const maxPctRef = useRef(0);

  // ETA state
  const [etaDisplay, setEtaDisplay] = useState<string>("Hisoblanmoqda…");
  // ETA internals — use refs so the countdown interval can read/write them
  const remainingSecRef = useRef<number | null>(null);
  const lastTickAtRef = useRef<number>(Date.now());
  const etaAnchoredRef = useRef(false); // has initial anchor been set?
  // When re-anchor wants to go UP, we store a range [lo, hi]
  const etaRangeHiRef = useRef<number | null>(null);
  // Previous transcribe done count to detect chunk completion
  const prevTranscribeDoneRef = useRef(0);
  // Previous unitTimesMs length
  const prevUnitTimesMsLenRef = useRef(0);

  const countdownIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- ETA countdown tick (called every 1s) ---
  const tickEta = useCallback(() => {
    if (remainingSecRef.current === null) return;
    const now = Date.now();
    const elapsed = (now - lastTickAtRef.current) / 1000;
    lastTickAtRef.current = now;

    const newVal = Math.max(0, remainingSecRef.current - elapsed);
    remainingSecRef.current = newVal;

    // Narrow range hi on each tick too
    if (etaRangeHiRef.current !== null) {
      etaRangeHiRef.current = Math.max(newVal, etaRangeHiRef.current - elapsed);
      // Collapse range when hi ≈ lo
      if (etaRangeHiRef.current - newVal < 5) {
        etaRangeHiRef.current = null;
      }
    }

    // Format for display
    if (newVal === 0) {
      setEtaDisplay("deyarli tayyor…");
    } else if (etaRangeHiRef.current !== null) {
      const loMin = Math.ceil(newVal / 60);
      const hiMin = Math.ceil(etaRangeHiRef.current / 60);
      if (loMin === hiMin) {
        setEtaDisplay(`≈ ${formatCountdown(newVal)} qoldi`);
      } else {
        setEtaDisplay(`≈ ${loMin}–${hiMin} daqiqa`);
      }
    } else {
      setEtaDisplay(`≈ ${formatCountdown(newVal)} qoldi`);
    }
  }, []);

  const startCountdown = useCallback(() => {
    if (countdownIntervalRef.current) return;
    lastTickAtRef.current = Date.now();
    countdownIntervalRef.current = setInterval(tickEta, 1000);
  }, [tickEta]);

  const stopCountdown = useCallback(() => {
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);

  // --- Re-anchor ETA from real data ---
  const reanchorEta = useCallback((phases: PipelinePhase[]) => {
    const transcribe = phases.find((p) => p.key === "transcribe");
    if (!transcribe || transcribe.total === 0) return;

    const unitMs = transcribe.unitTimesMs ?? [];
    const medianMs = medianOf(unitMs.length > 0 ? unitMs : [DEFAULT_CHUNK_SEC * 1000]);
    const medianSec = medianMs / 1000;
    const remainingChunks = Math.max(0, transcribe.total - transcribe.done);
    const constants = computeRemainingConstants(phases, "transcribe");
    const newRemaining = remainingChunks * medianSec + constants;

    const current = remainingSecRef.current;

    if (current === null) {
      // First anchor
      remainingSecRef.current = newRemaining;
      etaAnchoredRef.current = true;
      lastTickAtRef.current = Date.now();
      startCountdown();
    } else if (newRemaining < current) {
      // New estimate is lower — adopt freely (let it drop)
      remainingSecRef.current = newRemaining;
      etaRangeHiRef.current = null;
    } else {
      // New estimate is higher — don't jump up; nudge by at most 10%, store range
      const cap = current * ETA_UP_CAP_RATIO;
      const nudged = current + Math.min(newRemaining - current, cap);
      remainingSecRef.current = nudged;
      // Store original hi for range display
      etaRangeHiRef.current = newRemaining;
    }
  }, [startCountdown]);

  // --- Initial anchor before any chunks complete (just has total) ---
  const initialAnchorEta = useCallback((phases: PipelinePhase[]) => {
    if (etaAnchoredRef.current) return;
    const transcribe = phases.find((p) => p.key === "transcribe");
    if (!transcribe || transcribe.total === 0) return;

    const constants = computeRemainingConstants(phases, "transcribe");
    const initial = transcribe.total * DEFAULT_CHUNK_SEC + constants;
    remainingSecRef.current = initial;
    etaAnchoredRef.current = true;
    lastTickAtRef.current = Date.now();
    startCountdown();
    setEtaDisplay(`≈ ${formatCountdown(initial)} qoldi`);
  }, [startCountdown]);

  // --- Compute overall % from phases ---
  const computeOverallPct = useCallback((phases: PipelinePhase[]): number => {
    let sum = 0;
    for (const p of phases) {
      const weight = PHASE_WEIGHTS[p.key] ?? 0;
      let prog: number;
      if (p.status === "done") {
        prog = 1;
      } else if (p.status === "queued") {
        prog = 0;
      } else if (p.key === "analyze" || p.total === 0) {
        // atomic or unknown — use 0.5 while active
        prog = p.status === "active" ? 0.5 : 0;
      } else {
        prog = Math.min(1, Math.max(0, p.done / p.total));
      }
      sum += weight * prog;
    }
    return Math.min(1, Math.max(0, sum));
  }, []);

  // --- Apply incoming pipelineProgress ---
  const applyPipelineProgress = useCallback(
    (pp: PipelineProgress) => {
      const phases = pp.phases;
      setPipelinePhases(phases);
      setCurrentPhaseKey(pp.currentPhase);

      // Active label + phase subtitle (FIX 1: bind subtitle to live currentPhase)
      const activePhase = phases.find((p) => p.status === "active");
      if (activePhase) {
        setActiveLabel(`${activePhase.label} bajarilmoqda…`);
        const subtitleMap: Record<string, string> = {
          audio: "Audio tayyorlash bajarilmoqda…",
          transcribe: "Transkripsiya bajarilmoqda…",
          index: "AI indekslash bajarilmoqda…",
          analyze: "AI tahlil: Xulosa, vazifalar va tahrirlangan transkript tayyorlanmoqda…",
        };
        setPhaseSubtitle(subtitleMap[activePhase.key] ?? `${activePhase.label} bajarilmoqda…`);
      }

      // Overall pct (monotonic)
      const rawPct = computeOverallPct(phases);
      const mono = Math.max(rawPct, maxPctRef.current);
      maxPctRef.current = mono;
      setProgressPct(mono);

      // ETA logic
      const transcribe = phases.find((p) => p.key === "transcribe");
      if (transcribe && transcribe.total > 0) {
        const unitLen = (transcribe.unitTimesMs ?? []).length;
        const doneIncreased = transcribe.done > prevTranscribeDoneRef.current;
        const unitsIncreased = unitLen > prevUnitTimesMsLenRef.current;

        if (!etaAnchoredRef.current) {
          initialAnchorEta(phases);
        } else if (doneIncreased || unitsIncreased) {
          reanchorEta(phases);
        }

        prevTranscribeDoneRef.current = transcribe.done;
        prevUnitTimesMsLenRef.current = unitLen;
      } else if (!etaAnchoredRef.current) {
        // No transcribe total yet — just show computing
        setEtaDisplay("Hisoblanmoqda…");
      }
    },
    [computeOverallPct, initialAnchorEta, reanchorEta],
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      stopCountdown();
    };
  }, [stopCountdown]);

  const resetRunState = useCallback(() => {
    maxPctRef.current = 0;
    remainingSecRef.current = null;
    etaAnchoredRef.current = false;
    etaRangeHiRef.current = null;
    prevTranscribeDoneRef.current = 0;
    prevUnitTimesMsLenRef.current = 0;
    setProgressPct(0);
    setEtaDisplay("Hisoblanmoqda…");
    setPipelinePhases([]);
    setCurrentPhaseKey("");
    setActiveLabel("Xulosa, vazifalar va tahrirlangan transkript yarating");
    setPhaseSubtitle("Xulosa, vazifalar va tahrirlangan transkript yarating");
    stopCountdown();
  }, [stopCountdown]);

  // Poll AI generation status
  const pollAi = useCallback(
    (attempt: number) => {
      pollRef.current = setTimeout(async () => {
        try {
          const status = await getVideoStatus(videoId as Video.VideoId);
          if (status && "aiGenerationStatus" in status) {
            const aiStatus = status.aiGenerationStatus;
            const pp = (status as Record<string, unknown>).pipelineProgress as PipelineProgress | undefined;

            if (pp) applyPipelineProgress(pp);

            if (aiStatus === AI_COMPLETE) {
              stopCountdown();
              setProgressPct(1);
              maxPctRef.current = 1;
              setEtaDisplay("");
              setActiveLabel("Hammasi tayyor");
              setPhase("done");
              if (!refreshedRef.current) {
                refreshedRef.current = true;
                router.refresh();
              }
              return;
            }

            if (aiStatus && AI_ERROR_STATES.has(aiStatus)) {
              stopCountdown();
              const transcriptionError = (status as Record<string, unknown>).transcriptionError as string | undefined;
              const aiDetail = ((status as Record<string, unknown>).aiGenerationError as string | undefined) ?? "";
              if (transcriptionError) {
                setErrorMsg(transcriptionError);
              } else if (/429|rate.limit|cost.cap/i.test(aiDetail)) {
                setErrorMsg("Lavozimga yetdik. Boshqa generatsiya keyinroq.");
              } else if (/truncat|too long|too large/i.test(aiDetail)) {
                setErrorMsg("Transkripsiya yarim qoldi. Qayta urinish.");
              } else {
                setErrorMsg("AI tahlil bajarilmadi. Qayta urining.");
              }
              setPhase("error");
              return;
            }
          }
        } catch {
          // Ignore transient errors
        }

        // 225 × 4s = 15 min — covers a long video's AI phase end-to-end without
        // false-failing while the workflow is still progressing server-side.
        if (attempt < 225) {
          pollAi(attempt + 1);
        } else {
          stopCountdown();
          setPhase("error");
          setErrorMsg("Hali jarayonda — sahifani yangilab ko'ring.");
        }
      }, 4000);
    },
    [videoId, applyPipelineProgress, stopCountdown, router],
  );

  const startAiPhase = useCallback(async () => {
    try {
      const res = await fetch(`/api/videos/${videoId}/retry-ai`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        stopCountdown();
        if (res.status === 429 || /rate.limit|cost.cap/i.test(body?.error ?? "")) {
          setErrorMsg("Lavozimga yetdik. Boshqa generatsiya keyinroq.");
        } else {
          setErrorMsg(body?.error ?? "AI tahlil bajarilmadi.");
        }
        setPhase("error");
        return;
      }
      pollAi(0);
    } catch {
      stopCountdown();
      setErrorMsg("AI tahlilni boshlab bo'lmadi.");
      setPhase("error");
    }
  }, [videoId, stopCountdown, pollAi]);

  // Poll transcription status
  const pollTranscript = useCallback(
    (attempt: number) => {
      pollRef.current = setTimeout(async () => {
        try {
          const status = await getVideoStatus(videoId as Video.VideoId);
          if (status && "transcriptionStatus" in status) {
            const ts = status.transcriptionStatus;
            const pp = (status as Record<string, unknown>).pipelineProgress as PipelineProgress | undefined;

            if (pp) applyPipelineProgress(pp);

            if (ts === TRANSCRIPT_COMPLETE) {
              // Resume path: a generation was already in flight when the page
              // loaded. Don't POST /retry-ai (would duplicate the paid call) —
              // just attach to AI polling. Disarm the flag so the next user-
              // initiated run takes the normal startAiPhase POST path again.
              if (resumeAiWithoutKickoffRef.current) {
                resumeAiWithoutKickoffRef.current = false;
                pollAi(0);
                return;
              }
              await startAiPhase();
              return;
            }

            if (ts && TRANSCRIPT_ERROR_STATES.has(ts)) {
              stopCountdown();
              const transcriptionError = (status as Record<string, unknown>).transcriptionError as string | undefined;
              if (transcriptionError) {
                setErrorMsg(transcriptionError);
              } else if (ts === "NO_AUDIO") {
                setErrorMsg("Transkripsiya yarim qoldi. Qayta urinish.");
              } else {
                setErrorMsg("Transkripsiya bajarilmadi. Qayta urining.");
              }
              setPhase("error");
              return;
            }
          }
        } catch {
          // Ignore transient errors
        }

        // 225 × 4s = 15 min — covers a chunked long video's transcription end-to-
        // end without false-failing while chunks are still being processed.
        if (attempt < 225) {
          pollTranscript(attempt + 1);
        } else {
          stopCountdown();
          setPhase("error");
          setErrorMsg("Hali jarayonda — sahifani yangilab ko'ring.");
        }
      }, 4000);
    },
    [videoId, applyPipelineProgress, stopCountdown, startAiPhase],
  );

  // Mount-resume: if a generation was already in flight on the server when this
  // page loaded, attach to it via polling only. We must NOT POST to retry-* here,
  // because that would fire a duplicate paid Gemini generation.
  // pipelineProgress is persisted server-side and rehydrates on the next poll tick.
  useEffect(() => {
    if (didResumeRef.current) return;
    if (phase !== "running") return;
    didResumeRef.current = true;
    startCountdown();
    if (initialTranscriptionStatus !== TRANSCRIPT_COMPLETE) {
      // Arm the no-POST handoff: when transcribe finishes mid-poll, we must
      // pick up AI status by polling — NOT POST /retry-ai (a generation is
      // already in flight server-side).
      resumeAiWithoutKickoffRef.current = true;
      pollTranscript(0);
    } else {
      pollAi(0);
    }
  }, [phase, initialTranscriptionStatus, pollTranscript, pollAi, startCountdown]);

  // Kick off the pipeline
  const kickOffPipeline = useCallback(async (skipTranscript: boolean) => {
    setErrorMsg(null);
    refreshedRef.current = false;
    setPhase("running");
    resetRunState();

    if (skipTranscript) {
      await startAiPhase();
      return;
    }

    try {
      const res = await fetch(`/api/videos/${videoId}/retry-transcription`, { method: "POST" });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setErrorMsg(body?.error ?? "Transkripsiyani boshlab bo'lmadi.");
        setPhase("error");
        return;
      }
      pollTranscript(0);
    } catch {
      setErrorMsg("Generatsiyani boshlab bo'lmadi.");
      setPhase("error");
    }
  }, [videoId, pollTranscript, startAiPhase, resetRunState]);

  const onGenerate = useCallback(async () => {
    if (phase === "running") return;
    await kickOffPipeline(initialTranscriptionStatus === TRANSCRIPT_COMPLETE);
  }, [phase, initialTranscriptionStatus, kickOffPipeline]);

  const onRetry = useCallback(async () => {
    await kickOffPipeline(false);
  }, [kickOffPipeline]);

  const onRegenerate = useCallback(async () => {
    await kickOffPipeline(false);
  }, [kickOffPipeline]);

  // --- Phase chip detail line ---
  const renderPhaseDetail = (p: PipelinePhase): string | null => {
    if (p.status !== "active") return null;
    if (p.key === "transcribe" || p.key === "index") {
      if (p.total > 0) {
        // Compute per-phase ETA from unitTimesMs
        const unitMs = p.unitTimesMs ?? [];
        const medianMs = medianOf(unitMs.length > 0 ? unitMs : [DEFAULT_CHUNK_SEC * 1000]);
        const remaining = Math.max(0, p.total - p.done);
        const phaseSec = (remaining * medianMs) / 1000;
        const etaStr = formatPhaseEta(phaseSec);
        return `${p.label} — ${p.done}/${p.total} qism · ${etaStr}`;
      }
    }
    if (p.key === "audio") {
      if (p.total === 100) return `${p.label} — ${p.done}%`;
      return null; // spinner shown via CSS, no %
    }
    if (p.key === "analyze") {
      return null; // shimmer shown via CSS
    }
    return null;
  };

  // --- Quiet regen link ---
  if (phase === "regen-link") {
    return (
      <button type="button" className="cap-regen-link" onClick={onRegenerate}>
        Qayta generatsiya
      </button>
    );
  }

  const isRunning = phase === "running";
  const isDone = phase === "done";
  const isError = phase === "error" || phase === "error-empty";
  const pctInt = Math.round(progressPct * 100);

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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            </svg>
          )}
        </div>

        {/* Title + live action label */}
        <div className="gen-text">
          <div className="gen-title">
            {isError ? "Xato yuz berdi" : "AI insights tayyorlash"}
          </div>
          <div className="gen-sub">
            {isError
              ? (errorMsg ?? "Qayta urinib ko'ring.")
              : isRunning
                ? phaseSubtitle
                : activeLabel}
          </div>
        </div>

        {/* Primary / Retry button */}
        {isError ? (
          <button type="button" className="gen-btn gen-btn--retry" onClick={onRetry} aria-label="Retry generation">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="animate-spin" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

      {/* Determinate progress bar — shown while running */}
      {isRunning && (
        <div className="gen-progress-wrap" aria-label={`Jarayon: ${pctInt}%`}>
          <div className="gen-progress-bar">
            <div className="gen-progress-fill" style={{ width: `${pctInt}%` }} />
          </div>
          <div className="gen-progress-meta">
            <span className="gen-progress-pct">{pctInt}%</span>
            {etaDisplay && <span className="gen-progress-eta">{etaDisplay}</span>}
          </div>
        </div>
      )}

      {/* Phase chips — rendered from pipelineProgress.phases in array order */}
      {(isRunning || isDone) && pipelinePhases.length > 0 && (
        <div className="gen-chips">
          {pipelinePhases.map((p) => {
            const detail = renderPhaseDetail(p);
            const isAnalyzeActive = p.key === "analyze" && p.status === "active";
            const isAnalyzeDone = p.key === "analyze" && p.status === "done";
            const isAudioSpinner = p.key === "audio" && p.status === "active" && p.total === 0;
            const isIndexChip = p.key === "index";
            return (
              <div
                key={p.key}
                title={isIndexChip ? "AI suhbat uchun (chat-da javob berish uchun ma'lumotlar tayyorlanmoqda)" : undefined}
                className={[
                  "gen-chip",
                  p.status,
                  p.status === "active" ? "expanded" : "",
                ].filter(Boolean).join(" ")}
              >
                <div className="gen-chip-header">
                  <span className="gen-chip-state" aria-hidden="true" />
                  <span className="gen-chip-label">{p.label}</span>
                  {isAudioSpinner && <span className="gen-chip-spinner" aria-hidden="true" />}
                </div>
                {p.status === "active" && (
                  <div className="gen-chip-detail">
                    {isAnalyzeActive ? (
                      <>
                        <span className="gen-chip-shimmer-text">taxminan ~{ANALYZE_SEC}s</span>
                        <ul className="gen-chip-sublist">
                          {(["Xulosa", "Vazifalar", "Tahrirlangan transkript", "Bo'limlar"] as const).map((item) => (
                            <li key={item} className="gen-chip-subitem">
                              <span className="gen-chip-subitem-pulse" aria-hidden="true" />
                              {item}
                            </li>
                          ))}
                        </ul>
                      </>
                    ) : detail ? (
                      detail
                    ) : isAudioSpinner ? (
                      <span className="gen-chip-spinner-inline" aria-hidden="true" />
                    ) : null}
                  </div>
                )}
                {/* Sub-checklist shown when analyze is done — all ✓ together */}
                {isAnalyzeDone && (
                  <ul className="gen-chip-sublist">
                    {(["Xulosa", "Vazifalar", "Tahrirlangan transkript", "Bo'limlar"] as const).map((item) => (
                      <li key={item} className="gen-chip-subitem gen-chip-subitem--done">
                        <span className="gen-chip-subitem-check" aria-hidden="true" />
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Error message (only if running state has a transient error) */}
      {errorMsg && phase === "running" && <p className="gen-error">{errorMsg}</p>}
    </div>
  );
}
