// Extension page — NOT a service worker.
// Handles the full recording pipeline in one context:
//   chooseDesktopMedia → getUserMedia → 3-2-1 countdown → MediaRecorder
// Stays open after recording ends to show upload progress and the share link.

// ── Types ──────────────────────────────────────────────────────────────────

interface StoredSettings {
	micEnabled?: boolean;
	micDeviceId?: string;
	soundEnabled?: boolean;
	cameraOverlay?: boolean;
	cameraDeviceId?: string;
}

interface RecCtx {
	recorder: MediaRecorder;
	displayStream: MediaStream;
	micStream: MediaStream | null;
	cameraStream: MediaStream | null;
	// Closure that sets a flag checked by the rAF loop; more reliable than
	// storing a stale rAF ID (the ID changes every frame, ctx snapshot goes stale).
	stopComposite: (() => void) | null;
	audioCtx: AudioContext;
	chunkIndex: number;
}

// ── Module state ──────────────────────────────────────────────────────────

let ctx: RecCtx | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let stoppedSent = false;
let countdownCancelled = false;

// Tracks how many ondataavailable → arrayBuffer() calls are still in-flight.
// onstop MUST wait for these to reach zero before sending RECORDER_STOPPED,
// otherwise the last chunk's RECORDER_CHUNK message arrives at the SW AFTER
// RECORDER_STOPPED and gets silently dropped (SW state is already "uploading").
let pendingChunkCount = 0;
let resolveChunksDrained: (() => void) | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────

function tell(msg: Record<string, unknown>): void {
	chrome.runtime.sendMessage(msg).catch(() => {});
}

function stopTimer(): void {
	if (timerInterval !== null) { clearInterval(timerInterval); timerInterval = null; }
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
	return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

function pickMime(): string {
	// Prefer WebM. Chrome's MediaRecorder MP4 output muxes Opus audio into an MP4
	// container (and uses fragmented-MP4 with a 0 timescale), which the HTML5
	// <video> element CANNOT play ("Could not load a playable video source").
	// WebM (VP9/VP8 + Opus) plays natively in the browser, so we record WebM and
	// only fall back to MP4 if WebM is somehow unsupported.
	const prefs = [
		"video/webm;codecs=vp9,opus",
		"video/webm;codecs=vp8,opus",
		"video/webm",
		"video/mp4",
	];
	for (const m of prefs) if (MediaRecorder.isTypeSupported(m)) return m;
	return "video/webm";
}

async function readSettings(): Promise<{
	micEnabled: boolean;
	micDeviceId: string;
	soundEnabled: boolean;
	cameraEnabled: boolean;
	cameraDeviceId: string;
}> {
	const got = await chrome.storage.local.get("capExtSettings");
	const s = (got.capExtSettings as StoredSettings | undefined) ?? {};
	return {
		micEnabled: s.micEnabled !== false,
		micDeviceId: s.micDeviceId ?? "",
		soundEnabled: s.soundEnabled !== false,
		cameraEnabled: s.cameraOverlay === true,
		cameraDeviceId: s.cameraDeviceId ?? "",
	};
}

function releaseStreams(): void {
	if (!ctx) return;
	for (const t of ctx.displayStream.getTracks()) t.stop();
	if (ctx.micStream) for (const t of ctx.micStream.getTracks()) t.stop();
	if (ctx.cameraStream) for (const t of ctx.cameraStream.getTracks()) t.stop();
	if (ctx.stopComposite) ctx.stopComposite();
	ctx.audioCtx.close().catch(() => {});
	ctx = null;
}

async function closeSelf(): Promise<void> {
	try {
		const tab = await chrome.tabs.getCurrent();
		if (tab?.id !== undefined) { chrome.tabs.remove(tab.id); return; }
	} catch { /* fallthrough */ }
	window.close();
}

// ── Sound ─────────────────────────────────────────────────────────────────

function _sine(
	ac: AudioContext, freq: number, t: number,
	off: number, dur: number, vol: number,
): void {
	const osc = ac.createOscillator(), g = ac.createGain();
	osc.connect(g); g.connect(ac.destination);
	osc.type = "sine";
	osc.frequency.setValueAtTime(freq, t + off);
	g.gain.setValueAtTime(0, t + off);
	g.gain.linearRampToValueAtTime(vol, t + off + 0.008);
	g.gain.exponentialRampToValueAtTime(0.001, t + off + dur);
	osc.start(t + off); osc.stop(t + off + dur);
}

function playSound(fn: (ac: AudioContext, t: number) => void): void {
	try {
		const ac = new AudioContext();
		const go = () => {
			fn(ac, ac.currentTime);
			setTimeout(() => ac.close().catch(() => {}), 1500);
		};
		if (ac.state === "suspended") ac.resume().then(go).catch(() => {});
		else go();
	} catch (_) { /* no audio ctx */ }
}

function soundTick(ac: AudioContext, t: number): void {
	const osc = ac.createOscillator(), g = ac.createGain();
	osc.connect(g); g.connect(ac.destination);
	osc.type = "sine";
	osc.frequency.setValueAtTime(600, t);
	g.gain.setValueAtTime(0, t);
	g.gain.linearRampToValueAtTime(0.1, t + 0.005);
	g.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
	osc.start(t); osc.stop(t + 0.12);
}

function soundRecordStart(ac: AudioContext, t: number): void {
	// Ascending major arpeggio: C5 → E5 → G5  ("here we go!")
	_sine(ac, 523, t, 0.00, 0.18, 0.22);
	_sine(ac, 659, t, 0.13, 0.18, 0.25);
	_sine(ac, 784, t, 0.26, 0.42, 0.28);
}

function soundRecordStop(ac: AudioContext, t: number): void {
	// Descending resolution: G5 → C5  (conclusive finish)
	_sine(ac, 784, t, 0.00, 0.18, 0.22);
	_sine(ac, 523, t, 0.15, 0.42, 0.20);
}

// ── UI helpers ────────────────────────────────────────────────────────────

function $root(): HTMLElement { return document.getElementById("root")!; }

function mk<K extends keyof HTMLElementTagNameMap>(
	tag: K, cls = "", text = "",
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (cls)  el.className   = cls;
	if (text) el.textContent = text;
	return el;
}

function mkCard(): HTMLDivElement { return mk("div", "card"); }

const SVG_NS = "http://www.w3.org/2000/svg";
function mkLogo(size = 40): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	svg.setAttribute("width",   String(size));
	svg.setAttribute("height",  String(size));
	svg.setAttribute("viewBox", "0 0 40 40");
	svg.setAttribute("fill",    "none");
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
	const root = $root(); root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("p", "phase-title", "Opening screen picker…"));
	card.appendChild(mk("p", "phase-sub",   "Choose a screen or window to record."));
	root.appendChild(card);
}

function showStarting(): void {
	stopTimer();
	const root = $root(); root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("div", "spinner"));
	card.appendChild(mk("p", "phase-title", "Preparing…"));
	root.appendChild(card);
}

function showCountdown(n: number): void {
	stopTimer();
	const root = $root(); root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("div", "countdown-num", String(n)));
	card.appendChild(mk("p",  "phase-sub", "Recording starts in…"));
	root.appendChild(card);
}

function showRecording(startedAt: number): void {
	stopTimer();
	const root = $root(); root.innerHTML = "";
	const card = mkCard();

	const header = mk("div", "rec-header");
	header.appendChild(mk("span", "rec-dot"));
	header.appendChild(mk("span", "rec-label", "Recording"));
	card.appendChild(header);

	const timerEl = mk("div", "rec-timer", formatElapsed(Date.now() - startedAt));
	card.appendChild(timerEl);

	const stopBtn = mk("button", "action-btn action-btn--danger", "Stop recording");
	stopBtn.addEventListener("click", () => {
		stopBtn.disabled = true;
		stopBtn.textContent = "Stopping…";
		if (ctx && ctx.recorder.state !== "inactive") ctx.recorder.stop();
		else sendStopped();
	});
	card.appendChild(stopBtn);
	root.appendChild(card);

	timerInterval = setInterval(() => {
		timerEl.textContent = formatElapsed(Date.now() - startedAt);
	}, 1000);
}

function showUploading(pct: number): void {
	stopTimer();
	const root = $root(); root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("div", "spinner"));
	card.appendChild(mk("p", "phase-title", "Uploading…"));
	if (pct > 0) card.appendChild(mk("p", "upload-pct", `${pct}%`));
	root.appendChild(card);
}

function showFinishing(): void {
	stopTimer();
	const root = $root(); root.innerHTML = "";
	const card = mkCard();
	card.appendChild(mkLogo());
	card.appendChild(mk("div", "spinner"));
	card.appendChild(mk("p", "phase-title", "Finishing up…"));
	root.appendChild(card);
}

function showComplete(shareUrl: string): void {
	stopTimer();
	const root = $root(); root.innerHTML = "";
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
			setTimeout(() => { urlEl.textContent = shareUrl; }, 2000);
		}).catch(() => {});
	});
	card.appendChild(urlEl);

	const copyBtn = mk("button", "action-btn action-btn--primary", "Copy link");
	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(shareUrl).then(() => {
			copyBtn.textContent = "Copied!";
			setTimeout(() => { copyBtn.textContent = "Copy link"; }, 2000);
		}).catch(() => {});
	});

	const openBtn = mk("button", "action-btn action-btn--secondary", "Open");
	openBtn.addEventListener("click", () => chrome.tabs.create({ url: shareUrl }));

	const row = mk("div", "btn-row");
	row.appendChild(copyBtn); row.appendChild(openBtn);
	card.appendChild(row);

	const doneBtn = mk("button", "link-btn", "Done");
	doneBtn.addEventListener("click", () => closeSelf());
	card.appendChild(doneBtn);
	root.appendChild(card);
}

function showError(reason: string): void {
	stopTimer();
	const root = $root(); root.innerHTML = "";
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
	card.appendChild(mk("p", "error-msg",   reason));

	const dismissBtn = mk("button", "action-btn action-btn--secondary", "Dismiss");
	dismissBtn.addEventListener("click", () => closeSelf());
	card.appendChild(dismissBtn);
	root.appendChild(card);
}

// ── Recording helpers ─────────────────────────────────────────────────────

function sendStopped(): void {
	if (!stoppedSent) { stoppedSent = true; tell({ type: "RECORDER_STOPPED" }); }
}

// ── Main recording flow ───────────────────────────────────────────────────

async function run(): Promise<void> {
	showPicker();

	// Phase 1: native screen/window/tab picker
	const streamId = await new Promise<string | null>((resolve) => {
		// "screen"/"window"/"tab" → record whole screen, any app window, or a tab.
		// "audio" → shows the "Share system audio" checkbox in the picker; when
		// checked, the desktop-audio track is delivered via the audio getUserMedia
		// constraint below and mixed with the mic in Phase 4.
		chrome.desktopCapture.chooseDesktopMedia(
			["screen", "window", "tab", "audio"],
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
					mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId },
				} as unknown as MediaTrackConstraints,
			});
		} catch {
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
			try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
			catch { /* no mic */ }
		}
	}

	// Phase 4: mix audio
	const audioCtx = new AudioContext({ sampleRate: 48_000 });
	const dest = audioCtx.createMediaStreamDestination();
	if (displayStream.getAudioTracks().length > 0)
		audioCtx.createMediaStreamSource(displayStream).connect(dest);
	if (micStream && micStream.getAudioTracks().length > 0)
		audioCtx.createMediaStreamSource(micStream).connect(dest);

	// Phase 4b: camera compositing (if enabled) ─────────────────────────
	// Gets the camera stream here in the extension page context (same origin
	// as the mic permission, no cross-origin issues). Composites onto a canvas
	// so the camera bubble appears baked into the final video at bottom-left.
	let cameraStream: MediaStream | null = null;
	let stopComposite: (() => void) | null = null;

	if (settings.cameraEnabled) {
		try {
			const camC: MediaStreamConstraints = settings.cameraDeviceId
				? { video: { deviceId: { exact: settings.cameraDeviceId }, width: { ideal: 640 }, height: { ideal: 480 } } }
				: { video: { width: { ideal: 640 }, height: { ideal: 480 } } };
			cameraStream = await navigator.mediaDevices.getUserMedia(camC);
		} catch {
			cameraStream = null; // Camera unavailable — continue without it
		}
	}

	let recordStream: MediaStream;

	if (cameraStream) {
		// Set up canvas compositor
		const canvas = document.createElement("canvas");
		const dispVid = document.createElement("video");
		dispVid.srcObject = displayStream;
		dispVid.muted = true;
		await new Promise<void>((r) => { dispVid.onloadedmetadata = () => r(); });
		await dispVid.play();

		const camVid = document.createElement("video");
		camVid.srcObject = cameraStream;
		camVid.muted = true;
		await new Promise<void>((r) => { camVid.onloadedmetadata = () => r(); });
		await camVid.play();

		canvas.width  = dispVid.videoWidth  || 1920;
		canvas.height = dispVid.videoHeight || 1080;

		const ctx2d = canvas.getContext("2d")!;
		const bubbleSize = Math.round(canvas.height * 0.22);
		const pad = 20;
		// Bottom-LEFT: matches the on-page camera-bubble preview position.
		const bx = pad;
		const by = canvas.height - pad - bubbleSize;
		const cx = bx + bubbleSize / 2;
		const cy = by + bubbleSize / 2;
		const r  = bubbleSize / 2;

		// Flag-based stop: the closure captures `running` by reference so it
		// remains current no matter how many rAF callbacks fire after ctx is set.
		let running = true;
		function drawFrame() {
			if (!running) return;
			ctx2d.drawImage(dispVid, 0, 0, canvas.width, canvas.height);
			// Circle clip for camera
			ctx2d.save();
			ctx2d.beginPath();
			ctx2d.arc(cx, cy, r, 0, Math.PI * 2);
			ctx2d.clip();
			// Mirror the camera horizontally
			ctx2d.translate(cx, cy);
			ctx2d.scale(-1, 1);
			ctx2d.drawImage(camVid, -r, -r, bubbleSize, bubbleSize);
			ctx2d.restore();
			// White ring
			ctx2d.beginPath();
			ctx2d.arc(cx, cy, r + 2, 0, Math.PI * 2);
			ctx2d.strokeStyle = "rgba(255,255,255,0.85)";
			ctx2d.lineWidth = 3;
			ctx2d.stroke();
			requestAnimationFrame(drawFrame);
		}
		drawFrame();
		stopComposite = () => { running = false; };

		const canvasStream = canvas.captureStream(30);
		recordStream = new MediaStream([
			...canvasStream.getVideoTracks(),
			...dest.stream.getAudioTracks(),
		]);
	} else {
		recordStream = new MediaStream([
			...displayStream.getVideoTracks(),
			...dest.stream.getAudioTracks(),
		]);
	}

	// Wire up "Stop sharing" bar early so countdown cancels cleanly.
	const vt = displayStream.getVideoTracks();
	if (vt.length > 0) {
		vt[0].onended = () => {
			countdownCancelled = true;
			if (ctx && ctx.recorder.state !== "inactive") {
				ctx.recorder.stop();
			} else {
				// Sharing ended during countdown — stop streams and report.
				for (const t of displayStream.getTracks()) t.stop();
				if (micStream) for (const t of micStream.getTracks()) t.stop();
				audioCtx.close().catch(() => {});
				sendStopped();
				showUploading(0);
			}
		};
	}

	// Phase 5: 3-2-1 countdown
	const COUNTDOWN = 3;
	for (let i = COUNTDOWN; i >= 1; i--) {
		if (countdownCancelled) {
			for (const t of displayStream.getTracks()) t.stop();
			if (micStream) for (const t of micStream.getTracks()) t.stop();
			audioCtx.close().catch(() => {});
			tell({ type: "CAPTURE_CANCELLED" });
			await closeSelf();
			return;
		}
		showCountdown(i);
		if (settings.soundEnabled) playSound(soundTick);
		await sleep(1000);
	}
	if (countdownCancelled) {
		for (const t of displayStream.getTracks()) t.stop();
		if (micStream) for (const t of micStream.getTracks()) t.stop();
		audioCtx.close().catch(() => {});
		tell({ type: "CAPTURE_CANCELLED" });
		await closeSelf();
		return;
	}

	// Phase 6: MediaRecorder
	const mime = pickMime();
	const recorder = new MediaRecorder(recordStream, {
		mimeType: mime,
		videoBitsPerSecond: 1_200_000,
		audioBitsPerSecond: 128_000,
	});

	let chunkIndex = 0;

	recorder.ondataavailable = async (e) => {
		if (e.data.size <= 0) return;
		// Increment BEFORE the async read so onstop sees the in-flight count.
		pendingChunkCount++;
		try {
			const buffer = await e.data.arrayBuffer();
			tell({
				type: "RECORDER_CHUNK",
				chunk: Array.from(new Uint8Array(buffer)),
				index: chunkIndex++,
				mime: recorder.mimeType,
				ts: Date.now(),
			});
		} finally {
			pendingChunkCount--;
			if (pendingChunkCount === 0 && resolveChunksDrained) {
				const cb = resolveChunksDrained;
				resolveChunksDrained = null;
				cb();
			}
		}
	};

	recorder.onerror = () => {
		tell({ type: "RECORDER_ERROR", error: "MediaRecorder error" });
		releaseStreams();
		showError("MediaRecorder encountered an error.");
	};

	// Async onstop: wait for every in-flight arrayBuffer()+tell() to complete
	// before sending RECORDER_STOPPED. Without this gate, onstop fires (sync)
	// while the last ondataavailable is still awaiting arrayBuffer(), so
	// RECORDER_STOPPED reaches the SW before the final RECORDER_CHUNK.
	recorder.onstop = async () => {
		if (pendingChunkCount > 0) {
			await new Promise<void>((resolve) => { resolveChunksDrained = resolve; });
		}
		releaseStreams();
		if (settings.soundEnabled) playSound(soundRecordStop);
		sendStopped();
		showUploading(0);
	};

	ctx = { recorder, displayStream, micStream, cameraStream, stopComposite, audioCtx, chunkIndex };

	// Update onended now that ctx exists (previous assignment above handled pre-ctx case).
	if (vt.length > 0) {
		vt[0].onended = () => {
			if (ctx && ctx.recorder.state !== "inactive") ctx.recorder.stop();
		};
	}

	recorder.start(1_000);
	const localStartedAt = Date.now();

	// Play start chime and show recording UI.
	if (settings.soundEnabled) playSound(soundRecordStart);
	showRecording(localStartedAt);
	tell({ type: "RECORDER_STARTED", mime });
}

// ── Message listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
	const msg = raw as { type?: string; state?: Record<string, unknown> };

	switch (msg.type) {
		case "STOP_CAPTURE":
			countdownCancelled = true;
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

		case "DISCARD_RECORDING": {
			// Stop recorder without uploading — sends RECORDER_DISCARDED instead of RECORDER_STOPPED.
			countdownCancelled = true;
			stoppedSent = true; // Prevent the normal onstop from sending RECORDER_STOPPED.
			// Drain the pending-chunks gate so no future resolveChunksDrained fires.
			pendingChunkCount = 0;
			resolveChunksDrained = null;
			if (ctx && ctx.recorder.state !== "inactive") {
				ctx.recorder.onstop = () => {
					releaseStreams();
					tell({ type: "RECORDER_DISCARDED" });
					closeSelf().catch(() => {});
				};
				ctx.recorder.stop();
			} else {
				releaseStreams();
				tell({ type: "RECORDER_DISCARDED" });
				closeSelf().catch(() => {});
			}
			sendResponse({ ok: true });
			return true;
		}

		case "STATE_CHANGED": {
			const state = msg.state as { kind: string; [k: string]: unknown } | undefined;
			if (!state) break;
			switch (state.kind) {
				case "recording": {
					const startedAt = typeof state.startedAt === "number" ? state.startedAt : Date.now();
					if (ctx) showRecording(startedAt);
					break;
				}
				case "uploading": {
					const up   = typeof state.uploadedBytes === "number" ? state.uploadedBytes : 0;
					const tot  = typeof state.totalBytes    === "number" ? state.totalBytes    : 0;
					showUploading(tot > 0 ? Math.round((up / tot) * 100) : 0);
					break;
				}
				case "finishing": showFinishing(); break;
				case "complete": {
					const shareUrl = typeof state.shareUrl === "string" ? state.shareUrl : "";
					showComplete(shareUrl);
					break;
				}
				case "error": {
					const reason = typeof state.reason === "string" ? state.reason : "An error occurred.";
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
