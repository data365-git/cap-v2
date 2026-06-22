// Extension page — NOT a service worker.
// Handles the full recording pipeline in one context:
//   chooseDesktopMedia → getUserMedia → MediaRecorder → RECORDER_CHUNK → RECORDER_STOPPED
// Stays open after recording ends to show upload progress and the share link.

// ── Types ──────────────────────────────────────────────────────────────────

interface StoredSettings {
	micEnabled?: boolean;
	micDeviceId?: string;
}

interface RecCtx {
	recorder: MediaRecorder;
	displayStream: MediaStream;
	micStream: MediaStream | null;
	audioCtx: AudioContext;
	chunkIndex: number;
}

// ── Module state ──────────────────────────────────────────────────────────

let ctx: RecCtx | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let stoppedSent = false;

// ── Helpers ───────────────────────────────────────────────────────────────

function tell(msg: Record<string, unknown>): void {
	chrome.runtime.sendMessage(msg).catch(() => {});
}

function stopTimer(): void {
	if (timerInterval !== null) {
		clearInterval(timerInterval);
		timerInterval = null;
	}
}

function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

function pickMime(): string {
	const prefs = [
		"video/mp4;codecs=h264",
		"video/mp4",
		"video/webm;codecs=vp9,opus",
		"video/webm;codecs=vp8,opus",
		"video/webm",
	];
	for (const m of prefs) {
		if (MediaRecorder.isTypeSupported(m)) return m;
	}
	return "video/webm";
}

async function readSettings(): Promise<{
	micEnabled: boolean;
	micDeviceId: string;
}> {
	const got = await chrome.storage.local.get("capExtSettings");
	const s = (got.capExtSettings as StoredSettings | undefined) ?? {};
	return {
		micEnabled: s.micEnabled !== false,
		micDeviceId: s.micDeviceId ?? "",
	};
}

function releaseStreams(): void {
	if (!ctx) return;
	for (const t of ctx.displayStream.getTracks()) t.stop();
	if (ctx.micStream) for (const t of ctx.micStream.getTracks()) t.stop();
	ctx.audioCtx.close().catch(() => {});
	ctx = null;
}

async function closeSelf(): Promise<void> {
	try {
		const tab = await chrome.tabs.getCurrent();
		if (tab?.id !== undefined) {
			chrome.tabs.remove(tab.id);
			return;
		}
	} catch {
		// fallthrough
	}
	window.close();
}

// ── UI helpers ────────────────────────────────────────────────────────────

function $root(): HTMLElement {
	return document.getElementById("root")!;
}

function mk<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	cls = "",
	text = "",
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (cls) el.className = cls;
	if (text) el.textContent = text;
	return el;
}

function mkCard(): HTMLDivElement {
	return mk("div", "card");
}

const ns = "http://www.w3.org/2000/svg";
function mkLogo(size = 40): SVGSVGElement {
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", "0 0 40 40");
	svg.setAttribute("fill", "none");
	svg.innerHTML = `
    <rect width="40" height="40" fill="#fff" rx="8"/>
    <path fill="#4785FF" d="M20 36c8.837 0 16-7.163 16-16 0-8.836-7.163-16-16-16-8.836 0-16 7.164-16 16 0 8.837 7.164 16 16 16z"/>
    <path fill="#ADC9FF" d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13z"/>
    <path fill="#fff" d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10z"/>
  `;
	return svg;
}

// ── Phase renderers ───────────────────────────────────────────────────────

function showPicker(): void {
	stopTimer();
	const root = $root();
	root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("p", "phase-title", "Opening screen picker…"));
	card.appendChild(
		mk("p", "phase-sub", "Choose a screen or window to record."),
	);
	root.appendChild(card);
}

function showStarting(): void {
	stopTimer();
	const root = $root();
	root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("div", "spinner"));
	card.appendChild(mk("p", "phase-title", "Starting recording…"));
	root.appendChild(card);
}

function showRecording(startedAt: number): void {
	stopTimer();
	const root = $root();
	root.innerHTML = "";
	const card = mkCard();

	const header = mk("div", "rec-header");
	const dot = mk("span", "rec-dot");
	const label = mk("span", "rec-label", "Recording");
	header.appendChild(dot);
	header.appendChild(label);
	card.appendChild(header);

	const timerEl = mk("div", "rec-timer", formatElapsed(Date.now() - startedAt));
	card.appendChild(timerEl);

	const stopBtn = mk("button", "action-btn action-btn--danger", "Stop recording");
	stopBtn.addEventListener("click", () => {
		stopBtn.disabled = true;
		stopBtn.textContent = "Stopping…";
		if (ctx && ctx.recorder.state !== "inactive") {
			ctx.recorder.stop();
		} else {
			sendStopped();
		}
	});

	card.appendChild(stopBtn);
	root.appendChild(card);

	timerInterval = setInterval(() => {
		timerEl.textContent = formatElapsed(Date.now() - startedAt);
	}, 1000);
}

function showUploading(pct: number): void {
	stopTimer();
	const root = $root();
	root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("div", "spinner"));
	card.appendChild(mk("p", "phase-title", "Uploading…"));
	card.appendChild(
		mk("p", "upload-pct", pct > 0 ? `${pct}%` : ""),
	);
	root.appendChild(card);
}

function showFinishing(): void {
	stopTimer();
	const root = $root();
	root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("div", "spinner"));
	card.appendChild(mk("p", "phase-title", "Finishing up…"));
	root.appendChild(card);
}

function showComplete(shareUrl: string): void {
	stopTimer();
	const root = $root();
	root.innerHTML = "";
	const card = mkCard();

	const icon = mk("div", "complete-icon");
	icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"
	  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
	  <polyline points="20 6 9 17 4 12"/>
	</svg>`;

	card.appendChild(icon);
	card.appendChild(mk("p", "phase-title", "Recording saved!"));

	const urlEl = mk("p", "share-url", shareUrl);
	urlEl.title = "Click to copy";
	urlEl.addEventListener("click", () => {
		navigator.clipboard.writeText(shareUrl).then(() => {
			urlEl.textContent = "Copied!";
			setTimeout(() => (urlEl.textContent = shareUrl), 2000);
		}).catch(() => {});
	});
	card.appendChild(urlEl);

	const copyBtn = mk("button", "action-btn action-btn--primary", "Copy link");
	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(shareUrl).then(() => {
			copyBtn.textContent = "Copied!";
			setTimeout(() => (copyBtn.textContent = "Copy link"), 2000);
		}).catch(() => {});
	});

	const openBtn = mk("button", "action-btn action-btn--secondary", "Open");
	openBtn.addEventListener("click", () => chrome.tabs.create({ url: shareUrl }));

	const row = mk("div", "btn-row");
	row.appendChild(copyBtn);
	row.appendChild(openBtn);
	card.appendChild(row);

	const doneBtn = mk("button", "link-btn", "Done");
	doneBtn.addEventListener("click", () => closeSelf());
	card.appendChild(doneBtn);

	root.appendChild(card);
}

function showError(reason: string): void {
	stopTimer();
	const root = $root();
	root.innerHTML = "";
	const card = mkCard();

	const icon = mk("div", "error-icon");
	icon.innerHTML = `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"
	  stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
	  <circle cx="12" cy="12" r="10"/>
	  <line x1="12" y1="8" x2="12" y2="12"/>
	  <line x1="12" y1="16" x2="12.01" y2="16"/>
	</svg>`;

	card.appendChild(icon);
	card.appendChild(mk("p", "phase-title", "Recording failed"));
	card.appendChild(mk("p", "error-msg", reason));

	const dismissBtn = mk("button", "action-btn action-btn--secondary", "Dismiss");
	dismissBtn.addEventListener("click", () => closeSelf());
	card.appendChild(dismissBtn);

	root.appendChild(card);
}

// ── Recording helpers ─────────────────────────────────────────────────────

function sendStopped(): void {
	if (!stoppedSent) {
		stoppedSent = true;
		tell({ type: "RECORDER_STOPPED" });
	}
}

// ── Main recording flow ───────────────────────────────────────────────────

async function run(): Promise<void> {
	showPicker();

	// Phase 1: native screen/window/tab picker
	const streamId = await new Promise<string | null>((resolve) => {
		chrome.desktopCapture.chooseDesktopMedia(
			["screen", "window", "tab"],
			(id: string) => {
				const err = chrome.runtime.lastError;
				resolve(err || !id ? null : id);
			},
		);
	});

	if (!streamId) {
		tell({ type: "CAPTURE_CANCELLED" });
		await closeSelf();
		return;
	}

	showStarting();

	// Phase 2: display stream — SAME context as picker (avoids cross-context streamId error)
	let displayStream: MediaStream;
	const vidC = {
		mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId },
	} as unknown as MediaTrackConstraints;
	try {
		try {
			displayStream = await navigator.mediaDevices.getUserMedia({
				video: vidC,
				audio: {
					mandatory: {
						chromeMediaSource: "desktop",
						chromeMediaSourceId: streamId,
					},
				} as unknown as MediaTrackConstraints,
			});
		} catch {
			// Screen/window sources have no audio track — retry video-only.
			displayStream = await navigator.mediaDevices.getUserMedia({ video: vidC });
		}
	} catch (err) {
		const reason = `Failed to capture display: ${err instanceof Error ? err.message : String(err)}`;
		tell({ type: "RECORDER_ERROR", error: reason });
		showError(reason);
		return;
	}

	// Phase 3: microphone (if enabled)
	const settings = await readSettings();
	let micStream: MediaStream | null = null;
	if (settings.micEnabled) {
		try {
			const c = settings.micDeviceId
				? { audio: { deviceId: { exact: settings.micDeviceId } } }
				: { audio: true };
			micStream = await navigator.mediaDevices.getUserMedia(c);
		} catch {
			try {
				micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
			} catch {
				// Continue without mic.
			}
		}
	}

	// Phase 4: mix audio
	const audioCtx = new AudioContext({ sampleRate: 48_000 });
	const dest = audioCtx.createMediaStreamDestination();
	if (displayStream.getAudioTracks().length > 0) {
		audioCtx.createMediaStreamSource(displayStream).connect(dest);
	}
	if (micStream && micStream.getAudioTracks().length > 0) {
		audioCtx.createMediaStreamSource(micStream).connect(dest);
	}
	const recordStream = new MediaStream([
		...displayStream.getVideoTracks(),
		...dest.stream.getAudioTracks(),
	]);

	// Phase 5: MediaRecorder
	const mime = pickMime();
	const recorder = new MediaRecorder(recordStream, {
		mimeType: mime,
		videoBitsPerSecond: 1_200_000,
		audioBitsPerSecond: 128_000,
	});

	let chunkIndex = 0;

	recorder.ondataavailable = async (e) => {
		if (e.data.size <= 0) return;
		const buffer = await e.data.arrayBuffer();
		tell({
			type: "RECORDER_CHUNK",
			chunk: Array.from(new Uint8Array(buffer)),
			index: chunkIndex++,
			mime: recorder.mimeType,
			ts: Date.now(),
		});
	};

	recorder.onerror = () => {
		tell({ type: "RECORDER_ERROR", error: "MediaRecorder error" });
		releaseStreams();
		showError("MediaRecorder encountered an error.");
	};

	recorder.onstop = () => {
		releaseStreams();
		sendStopped();
		// Show uploading UI — tab stays open until STATE_CHANGED "complete" arrives.
		showUploading(0);
	};

	// Auto-stop when user clicks "Stop sharing" in the browser bar.
	const vt = displayStream.getVideoTracks();
	if (vt.length > 0) {
		vt[0].onended = () => {
			if (ctx && ctx.recorder.state !== "inactive") ctx.recorder.stop();
		};
	}

	ctx = { recorder, displayStream, micStream, audioCtx, chunkIndex };
	recorder.start(1_000);

	// Transition UI immediately (before SW confirms via STATE_CHANGED).
	const localStartedAt = Date.now();
	showRecording(localStartedAt);

	tell({ type: "RECORDER_STARTED", mime });
}

// ── Message listener (commands from SW + state broadcasts) ────────────────

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
	const msg = raw as { type?: string; state?: Record<string, unknown> };

	switch (msg.type) {
		// Commands from SW
		case "STOP_CAPTURE":
			if (ctx && ctx.recorder.state !== "inactive") {
				ctx.recorder.stop();
			} else {
				sendStopped();
				releaseStreams();
				showUploading(0);
			}
			sendResponse({ ok: true });
			return true;

		case "PAUSE_CAPTURE":
			if (ctx && ctx.recorder.state === "recording") ctx.recorder.pause();
			sendResponse({ ok: true });
			return true;

		case "RESUME_CAPTURE":
			if (ctx && ctx.recorder.state === "paused") ctx.recorder.resume();
			sendResponse({ ok: true });
			return true;

		// State broadcasts from SW — drive the post-recording UI
		case "STATE_CHANGED": {
			const state = msg.state as { kind: string; [k: string]: unknown } | undefined;
			if (!state) break;

			switch (state.kind) {
				case "recording": {
					const startedAt = typeof state.startedAt === "number"
						? state.startedAt
						: Date.now();
					// Only re-render if we're still in the recording phase
					// (don't overwrite uploading/complete UI on delayed broadcasts).
					if (ctx) showRecording(startedAt);
					break;
				}
				case "uploading": {
					const uploaded = typeof state.uploadedBytes === "number"
						? state.uploadedBytes
						: 0;
					const total = typeof state.totalBytes === "number"
						? state.totalBytes
						: 0;
					const pct = total > 0 ? Math.round((uploaded / total) * 100) : 0;
					showUploading(pct);
					break;
				}
				case "finishing":
					showFinishing();
					break;
				case "complete": {
					const shareUrl = typeof state.shareUrl === "string"
						? state.shareUrl
						: "";
					showComplete(shareUrl);
					break;
				}
				case "error": {
					const reason = typeof state.reason === "string"
						? state.reason
						: "An error occurred.";
					showError(reason);
					break;
				}
			}
			break;
		}
	}
});

run().catch((err) => {
	const reason = err instanceof Error ? err.message : "Capture page error";
	tell({ type: "RECORDER_ERROR", error: reason });
	showError(reason);
});
