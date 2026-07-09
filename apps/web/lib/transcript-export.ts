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
 * Export as plain text: Title · Duration · Date, then the full verbatim
 * transcript (every cue, with timestamps). The refined/summarized version is
 * available via toMarkdownSummary — the default download must be the complete
 * transcript so paste-into-ChatGPT gets all 2.5h, not a 21-chapter summary.
 */
export function toPlainText(input: ExportInput): string {
  const duration = input.durationSec !== null ? formatDuration(input.durationSec) : "Unknown";
  const date = getLocaleDate();

  const lines: string[] = [];
  lines.push(`${input.title} · ${duration} · ${date}`);
  lines.push("");

  // Group consecutive cues by speaker for readability; keep every cue.
  let currentSpeaker = "";
  for (const cue of input.vttCues) {
    const text = (cue.text || "").replace(/<v\s+([^>]+)>/, (_m, who) => {
      if (who !== currentSpeaker) {
        currentSpeaker = who;
        return `\n${who}: `;
      }
      return "";
    }).replace(/<\/v>/g, "").trim();
    if (!text) continue;
    const ts = formatDuration(cue.startSec);
    lines.push(`[${ts}] ${text}`);
  }

  return lines.join("\n");
}

/**
 * Export only the AI-refined summary (much shorter — 1–2 paragraphs per
 * chapter). Returns null if no refined transcript exists yet.
 */
export function toMarkdownSummary(input: ExportInput): string | null {
  if (!input.refinedTranscript?.chapters?.length) return null;
  const lines: string[] = [];
  lines.push(`# ${input.title} — summary`);
  lines.push("");
  if (input.refinedTranscript.intro) {
    const i = input.refinedTranscript.intro;
    if (i.participants?.length) lines.push(`**Participants:** ${i.participants.join(", ")}`);
    if (i.duration) lines.push(`**Duration:** ${i.duration}`);
    if (i.purpose) lines.push(`**Purpose:** ${i.purpose}`);
    lines.push("");
  }
  for (const c of input.refinedTranscript.chapters) {
    lines.push(`## [${formatDuration(c.startSec)}] ${c.title}`);
    lines.push("");
    for (const p of c.paragraphs) lines.push(p);
    lines.push("");
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

  // Full verbatim transcript, grouped under timeline chapter headers when
  // available so it stays navigable. Every cue is included — the .md export
  // must be the COMPLETE transcript, not the AI summary. For the summary
  // version, see toMarkdownSummary().
  const chapters = input.refinedTranscript?.chapters?.length
    ? input.refinedTranscript.chapters
    : input.aiSummary?.chapters?.length
      ? input.aiSummary.chapters.map((c) => ({ startSec: c.startSec, title: c.title }))
      : [];

  const renderCue = (cue: { startSec: number; text: string }) => {
    const text = (cue.text || "")
      .replace(/<v\s+([^>]+)>/, (_m, who) => `**${who}:** `)
      .replace(/<\/v>/g, "")
      .trim();
    return `**[${formatDuration(cue.startSec)}]** ${text}`;
  };

  if (chapters.length > 0) {
    let ci = 0;
    for (const cue of input.vttCues) {
      while (ci < chapters.length && cue.startSec >= chapters[ci]!.startSec) {
        lines.push("");
        lines.push(`## [${formatDuration(chapters[ci]!.startSec)}] ${chapters[ci]!.title}`);
        lines.push("");
        ci++;
      }
      lines.push(renderCue(cue));
      lines.push("");
    }
  } else {
    lines.push("## Transcript");
    lines.push("");
    for (const cue of input.vttCues) {
      lines.push(renderCue(cue));
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
