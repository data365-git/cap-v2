/**
 * Pure formatter functions for exporting transcripts.
 * No I/O, no dependencies — string templating only.
 */

export interface ExportInput {
  videoId: string;
  title: string;
  durationSec: number | null;
  vttCues: { startSec: number; endSec: number; text: string }[];
  refinedTranscript?: {
    intro?: { participants: string[]; duration: string; purpose: string };
    chapters: { startSec: number; title: string; paragraphs: string[] }[];
  } | null;
  aiSummary?: {
    overview: string;
    topics: { title: string; body: string }[];
    nextSteps: string[];
    tasks: { title: string; assignee: string; priority: string; deadline: string; done: boolean }[];
    chapters: { startSec: number; title: string; body: string }[];
  } | null;
}

/**
 * Format seconds as mm:ss or h:mm:ss
 */
function formatDuration(sec: number): string {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Format seconds as VTT timestamp (hh:mm:ss.mmm)
 */
function formatVttTime(sec: number): string {
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = Math.floor(sec % 60);
  const millis = Math.floor((sec % 1) * 1000);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}

/**
 * Get today's date in locale format
 */
function getLocaleDate(): string {
  return new Date().toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Export as plain text: Title · Duration · Date, then chapters with paragraphs.
 */
export function toPlainText(input: ExportInput): string {
  const duration = input.durationSec !== null ? formatDuration(input.durationSec) : "Unknown";
  const date = getLocaleDate();

  const lines: string[] = [];
  lines.push(`${input.title} · ${duration} · ${date}`);
  lines.push("");

  if (input.refinedTranscript?.chapters && input.refinedTranscript.chapters.length > 0) {
    for (const chapter of input.refinedTranscript.chapters) {
      lines.push(chapter.title.toUpperCase());
      lines.push("");
      for (const paragraph of chapter.paragraphs) {
        lines.push(paragraph);
      }
      lines.push("");
    }
  } else {
    // Fallback: one paragraph per VTT cue
    for (const cue of input.vttCues) {
      lines.push(cue.text);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Export as Markdown: # Title, intro block, then chapters with timestamps.
 */
export function toMarkdown(input: ExportInput): string {
  const lines: string[] = [];

  lines.push(`# ${input.title}`);
  lines.push("");

  // Intro block (if refined transcript with intro exists)
  if (input.refinedTranscript?.intro) {
    const intro = input.refinedTranscript.intro;
    lines.push("| Attribute | Value |");
    lines.push("|-----------|-------|");
    if (intro.participants && intro.participants.length > 0) {
      lines.push(`| Participants | ${intro.participants.join(", ")} |`);
    }
    if (intro.duration) {
      lines.push(`| Duration | ${intro.duration} |`);
    }
    if (intro.purpose) {
      lines.push(`| Purpose | ${intro.purpose} |`);
    }
    lines.push("");
  }

  // Chapters
  if (input.refinedTranscript?.chapters && input.refinedTranscript.chapters.length > 0) {
    for (const chapter of input.refinedTranscript.chapters) {
      const timestamp = formatDuration(chapter.startSec);
      lines.push(`## [${timestamp}] ${chapter.title}`);
      lines.push("");
      for (const paragraph of chapter.paragraphs) {
        lines.push(paragraph);
      }
      lines.push("");
    }
  } else {
    // Fallback: single transcript section with cue texts
    lines.push("## Transcript");
    lines.push("");
    for (const cue of input.vttCues) {
      lines.push(cue.text);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Export as WebVTT: standard VTT format with cues.
 */
export function toVtt(input: ExportInput): string {
  const lines: string[] = [];
  lines.push("WEBVTT");
  lines.push("");

  for (const cue of input.vttCues) {
    lines.push(`${input.vttCues.indexOf(cue) + 1}`);
    lines.push(`${formatVttTime(cue.startSec)} --> ${formatVttTime(cue.endSec)}`);
    lines.push(cue.text);
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Export as JSON: video metadata + transcript + refined + summary.
 */
export function toJson(input: ExportInput): string {
  const output = {
    video: {
      id: input.videoId,
      title: input.title,
      durationSec: input.durationSec,
    },
    transcript: input.vttCues,
    refinedTranscript: input.refinedTranscript ?? undefined,
    aiSummary: input.aiSummary ?? undefined,
  };

  return JSON.stringify(output, null, 2);
}

/**
 * Sanitize filename: replace unsafe chars with dashes, collapse, trim, cap base to 80 chars.
 * Returns: ${base}-${videoId}.${ext}
 */
export function sanitizeFilename(title: string, videoId: string, ext: string): string {
  // Replace unsafe characters with dash
  let base = title.replace(/[^a-zA-Z0-9\-_]/g, "-");

  // Collapse repeated dashes
  base = base.replace(/-+/g, "-");

  // Trim leading/trailing dashes
  base = base.replace(/^-|-$/g, "");

  // Cap base to 80 chars
  if (base.length > 80) {
    base = base.substring(0, 80).replace(/-+$/, "");
  }

  return `${base}-${videoId}.${ext}`;
}

/**
 * Trigger browser download: creates blob, object URL, synthetic link, clicks, cleans up.
 * Guards with typeof window !== "undefined" (safe for SSR).
 */
export function triggerBrowserDownload(content: string, filename: string, mimeType: string): void {
  if (typeof window === "undefined") {
    return;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);

  URL.revokeObjectURL(url);
}
