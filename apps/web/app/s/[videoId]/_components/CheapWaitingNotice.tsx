"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Owner-only notice shown when a video is parked in cheap (aiSpeedMode) mode
 * waiting on the free/Batch tier (`metadata.aiQuotaWaiting`). Offers a
 * "Transcribe now (paid)" action that forces it onto the paid synchronous tier
 * via the continue-paid route.
 */
export function CheapWaitingNotice({ videoId }: { videoId: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const onContinue = async () => {
		setBusy(true);
		setError(null);
		try {
			const res = await fetch(`/api/videos/${videoId}/continue-paid`, {
				method: "POST",
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => ({}))) as {
					error?: string;
				};
				setError(body?.error ?? "Could not continue on the paid tier.");
				return;
			}
			router.refresh();
		} catch {
			setError("Could not continue on the paid tier.");
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-2 p-4 rounded-xl border bg-amber-2 border-amber-6 sm:flex-row sm:items-center sm:justify-between">
			<div className="flex flex-col gap-1">
				<p className="text-sm font-medium text-amber-12">
					Cheap mode — waiting on the free tier
				</p>
				<p className="text-xs text-amber-11">
					This transcript is queued on the cheaper free/batch tier and may take
					a while (up to several hours). You can finish it immediately on the
					paid tier.
				</p>
				{error && <p className="text-xs text-red-500">{error}</p>}
			</div>
			<button
				type="button"
				onClick={onContinue}
				disabled={busy}
				className="whitespace-nowrap rounded-lg bg-blue-11 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-blue-10 disabled:opacity-50"
			>
				{busy ? "Starting…" : "Transcribe now (paid)"}
			</button>
		</div>
	);
}
