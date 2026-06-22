// Extension page — NOT a service worker.
// Calls chooseDesktopMedia, getUserMedia, and MediaRecorder all in this
// context so the streamId never crosses extension contexts.
// ("Error starting tab capture" was caused by cross-context streamId reuse.)

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

let ctx: RecCtx | null = null;

function tell(msg: Record<string, unknown>): void {
	chrome.runtime.sendMessage(msg).catch(() => {});
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

async function run(): Promise<void> {
	// ── Phase 1: native screen/window/tab picker ───────────────────────────
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

	// ── Phase 2: display stream — SAME context as picker (no cross-context issue) ──
	let displayStream: MediaStream;
	const vidC = {
		mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: streamId },
	} as unknown as MediaTrackConstraints;
	try {
		try {
			// Try with desktop audio first (tab sources support it).
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
			// Screen/window sources have no audio — retry video-only.
			displayStream = await navigator.mediaDevices.getUserMedia({ video: vidC });
		}
	} catch (err) {
		tell({
			type: "RECORDER_ERROR",
			error: `Failed to capture display: ${err instanceof Error ? err.message : String(err)}`,
		});
		await closeSelf();
		return;
	}

	// ── Phase 3: microphone (if enabled) ──────────────────────────────────
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
				// Mic unavailable — continue without it.
			}
		}
	}

	// ── Phase 4: mix audio ────────────────────────────────────────────────
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

	// ── Phase 5: MediaRecorder ─────────────────────────────────────────────
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
		closeSelf();
	};

	recorder.onstop = async () => {
		releaseStreams();
		tell({ type: "RECORDER_STOPPED" });
		await closeSelf();
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

	tell({ type: "RECORDER_STARTED", mime });
}

// ── Listen for stop/pause/resume commands from the SW ─────────────────────
chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
	const msg = raw as { type?: string };
	switch (msg.type) {
		case "STOP_CAPTURE":
			if (ctx && ctx.recorder.state !== "inactive") {
				ctx.recorder.stop(); // triggers onstop → RECORDER_STOPPED + closeSelf
			} else {
				tell({ type: "RECORDER_STOPPED" });
				releaseStreams();
				closeSelf();
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
	}
});

run().catch((err) => {
	tell({
		type: "RECORDER_ERROR",
		error: err instanceof Error ? err.message : "Capture page error",
	});
	closeSelf();
});
