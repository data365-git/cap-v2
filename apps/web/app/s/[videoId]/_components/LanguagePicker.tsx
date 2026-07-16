"use client";

import type { VideoTranslation } from "@cap/database/types";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@cap/ui";
import { type LanguageCode, SUPPORTED_LANGUAGES } from "@cap/web-domain";
import { Check, Globe, Loader2, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

export type SelectedLanguage = "base" | LanguageCode;

/**
 * Curated shortlist of languages offered in the "translate to…" section, so the
 * owner isn't shown all 25 supported codes at once. Any language that already
 * has a translation is always shown regardless of this list.
 */
const OFFERED_LANGUAGES: LanguageCode[] = [
	"en",
	"es",
	"fr",
	"de",
	"pt",
	"ru",
	"tr",
	"zh",
	"ja",
	"ar",
	"hi",
];

interface LanguagePickerProps {
	videoId: string;
	isOwner: boolean;
	/** metadata.translations map from the server-rendered video row. */
	translations?: Partial<Record<LanguageCode, VideoTranslation>>;
	selected: SelectedLanguage;
	onSelect: (value: SelectedLanguage) => void;
}

function label(code: LanguageCode): string {
	return SUPPORTED_LANGUAGES[code];
}

export function LanguagePicker({
	videoId,
	isOwner,
	translations,
	selected,
	onSelect,
}: LanguagePickerProps) {
	const router = useRouter();
	const [generating, setGenerating] = useState<LanguageCode | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(() => {
		return () => {
			if (pollRef.current) clearInterval(pollRef.current);
		};
	}, []);

	// Languages with a usable (COMPLETE) translation cached in metadata.
	const completed = (Object.keys(translations ?? {}) as LanguageCode[]).filter(
		(code) => translations?.[code]?.status === "COMPLETE",
	);

	const inFlight = (Object.keys(translations ?? {}) as LanguageCode[]).filter(
		(code) => translations?.[code]?.status === "PROCESSING",
	);

	const startTranslation = useCallback(
		async (language: LanguageCode) => {
			setGenerating(language);
			try {
				const res = await fetch(`/api/videos/${videoId}/translate`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ language }),
				});
				if (!res.ok) {
					setGenerating(null);
					return;
				}
				const data = (await res.json()) as { status?: string };
				if (data.status === "COMPLETE") {
					setGenerating(null);
					router.refresh();
					onSelect(language);
					return;
				}

				// Poll until the background translation settles.
				if (pollRef.current) clearInterval(pollRef.current);
				pollRef.current = setInterval(async () => {
					try {
						const poll = await fetch(
							`/api/videos/${videoId}/translate?language=${language}`,
						);
						if (!poll.ok) return;
						const pd = (await poll.json()) as {
							status?: string;
							hasContent?: boolean;
						};
						if (pd.status === "COMPLETE" && pd.hasContent) {
							if (pollRef.current) clearInterval(pollRef.current);
							pollRef.current = null;
							setGenerating(null);
							router.refresh();
							onSelect(language);
						} else if (pd.status === "ERROR") {
							if (pollRef.current) clearInterval(pollRef.current);
							pollRef.current = null;
							setGenerating(null);
						}
					} catch {
						/* transient — keep polling */
					}
				}, 4000);
			} catch {
				setGenerating(null);
			}
		},
		[videoId, router, onSelect],
	);

	const currentLabel =
		selected === "base" ? "Original" : label(selected as LanguageCode);

	const offered = OFFERED_LANGUAGES.filter(
		(code) => !completed.includes(code) && !inFlight.includes(code),
	);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					aria-label="Change language"
					className="inline-flex items-center gap-1.5 rounded-md border border-gray-4 bg-gray-1 px-2.5 py-1 text-xs font-medium text-gray-12 transition-colors hover:bg-gray-3"
				>
					<Globe className="size-3.5" />
					<span>{currentLabel}</span>
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-44">
				<DropdownMenuItem onClick={() => onSelect("base")}>
					{selected === "base" && <Check className="mr-2 size-3.5" />}
					<span className={selected === "base" ? "" : "ml-[22px]"}>
						Original
					</span>
				</DropdownMenuItem>

				{completed.map((code) => (
					<DropdownMenuItem key={code} onClick={() => onSelect(code)}>
						{selected === code && <Check className="mr-2 size-3.5" />}
						<span className={selected === code ? "" : "ml-[22px]"}>
							{label(code)}
						</span>
					</DropdownMenuItem>
				))}

				{inFlight.map((code) => (
					<DropdownMenuItem key={code} disabled>
						<Loader2 className="mr-2 size-3.5 animate-spin" />
						{label(code)}
					</DropdownMenuItem>
				))}

				{isOwner && offered.length > 0 && (
					<>
						<DropdownMenuSeparator />
						<DropdownMenuLabel className="text-[11px] text-gray-9">
							Translate to
						</DropdownMenuLabel>
						{offered.map((code) => {
							const isGenerating = generating === code;
							return (
								<DropdownMenuItem
									key={code}
									disabled={isGenerating || generating !== null}
									onSelect={(e) => {
										e.preventDefault();
										void startTranslation(code);
									}}
								>
									{isGenerating ? (
										<Loader2 className="mr-2 size-3.5 animate-spin" />
									) : (
										<Plus className="mr-2 size-3.5 text-gray-9" />
									)}
									{label(code)}
								</DropdownMenuItem>
							);
						})}
					</>
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
