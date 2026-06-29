"use client";

import type { ExportInput } from "@/lib/transcript-export";
import {
  sanitizeFilename,
  toJson,
  toMarkdown,
  toPlainText,
  toVtt,
  triggerBrowserDownload,
} from "@/lib/transcript-export";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cap/ui";
import { Download } from "lucide-react";

interface DownloadTranscriptButtonProps extends ExportInput {
  transcriptionStatus?: string;
  variant?: "button" | "menuitem";
}

const FORMATS = [
  {
    label: "TXT (oddiy matn)",
    ext: "txt",
    mime: "text/plain",
    formatter: toPlainText,
  },
  {
    label: "Markdown (boblar bilan)",
    ext: "md",
    mime: "text/markdown",
    formatter: toMarkdown,
  },
  {
    label: "VTT (vaqt belgilari bilan)",
    ext: "vtt",
    mime: "text/vtt",
    formatter: toVtt,
  },
  {
    label: "JSON (to'liq AI ma'lumotlari)",
    ext: "json",
    mime: "application/json",
    formatter: toJson,
  },
] as const;

export function DownloadTranscriptButton({
  transcriptionStatus,
  variant = "button",
  ...exportInput
}: DownloadTranscriptButtonProps) {
  // Hide entirely when transcript errored or skipped
  if (
    transcriptionStatus === "ERROR" ||
    transcriptionStatus === "SKIPPED"
  ) {
    return null;
  }

  const isDisabled =
    exportInput.vttCues.length === 0 ||
    transcriptionStatus === "PROCESSING";

  const disabledTitle = "Transkripsiya tugagandan keyin mavjud";

  const handleDownload = (format: (typeof FORMATS)[number]) => {
    if (isDisabled) return;
    const content = format.formatter(exportInput);
    const filename = sanitizeFilename(
      exportInput.title,
      exportInput.videoId,
      format.ext,
    );
    triggerBrowserDownload(content, filename, format.mime);
  };

  if (variant === "menuitem") {
    // Render as a sub-menu item group for CapCard usage
    return (
      <>
        {FORMATS.map((format) => (
          <DropdownMenuItem
            key={format.ext}
            onClick={(e) => {
              e.stopPropagation();
              handleDownload(format);
            }}
            disabled={isDisabled}
            title={isDisabled ? disabledTitle : undefined}
            className="flex gap-2 items-center rounded-lg pl-6"
          >
            <p className="text-sm text-gray-12">{format.label}</p>
          </DropdownMenuItem>
        ))}
      </>
    );
  }

  // Default: standalone button with dropdown
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild disabled={isDisabled}>
        <button
          type="button"
          title={isDisabled ? disabledTitle : "Transkriptni yuklab olish"}
          disabled={isDisabled}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium text-gray-12 bg-gray-2 border border-gray-5 hover:bg-gray-3 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <Download className="size-4" />
          <span>Transkriptni yuklab olish</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" sideOffset={4}>
        {FORMATS.map((format) => (
          <DropdownMenuItem
            key={format.ext}
            onClick={() => handleDownload(format)}
            className="flex gap-2 items-center rounded-lg"
          >
            <p className="text-sm text-gray-12">{format.label}</p>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
