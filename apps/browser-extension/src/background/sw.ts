import { isKeepAliveAlarm, startKeepAlive, stopKeepAlive } from "./keepalive";
import type { ExtensionSettings, ExtensionState } from "./state";
import { getSettings, getState, setSettings, setState } from "./state";
import {
	discardUpload,
	finalizeUpload,
	handleChunk,
	initializeUpload,
	retryPendingUploads,
} from "./upload";

// ── Capture tab ───────────────────────────────────────────────────────────
//
// capture.html runs the full pipeline: chooseDesktopMedia → getUserMedia →
// MediaRecorder, all in the same extension-page context so the streamId
// never crosses contexts ("Error starting tab capture" is eliminated).
// The tab sends RECORDER_STARTED/CHUNK/STOPPED to SW just like the old
// offscreen document did.

let captureTabId: number | null = null;
// When true, RECORDER_DISCARDED should go to idle (delete) instead of restarting.
let pendingDeleteAfterDiscard = false;
// Tabs that currently have overlay.js injected — used to re-inject on switch/reload.
const overlayInjectedTabs = new Set<number>();
// Mirrors overlayInjectedTabs for camera-bubble.js — same lifecycle, separate dedup.
const cameraBubbleTabs = new Set<number>();

// Promise chain that serializes RECORDER_CHUNK processing relative to
// RECORDER_STOPPED. Each CHUNK chains handleChunk() onto this tail; STOPPED
// awaits the tail before finalizing. Prevents finalizeUpload() from draining
// the buffer before all chunks have been appended to it.
let chunkTail: Promise<void> = Promise.resolve();

// Inject camera-bubble.js into a tab (only when cameraOverlay is on).
async function injectCameraBubble(tabId: number): Promise<void> {
	if (cameraBubbleTabs.has(tabId)) return;
	try {
		const tab = await chrome.tabs.get(tabId);
		const url = tab.url ?? "";
		if (!url || url.startsWith("chrome://") || url.startsWith("chrome-extension://") ||
			url.startsWith("edge://") || url.startsWith("about:") || url.startsWith("data:")) return;
	} catch { return; }
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: ["camera-bubble.js"] });
		cameraBubbleTabs.add(tabId);
	} catch { /* non-injectable page */ }
}

// Inject overlay.js into a tab if not already there; silently skip non-injectable pages.
async function injectOverlay(tabId: number): Promise<void> {
	if (overlayInjectedTabs.has(tabId)) return;
	try {
		const tab = await chrome.tabs.get(tabId);
		const url = tab.url ?? "";
		if (
			!url ||
			url.startsWith("chrome://") ||
			url.startsWith("chrome-extension://") ||
			url.startsWith("edge://") ||
			url.startsWith("about:") ||
			url.startsWith("data:")
		) return;
	} catch {
		return; // Tab no longer exists
	}
	try {
		await chrome.scripting.executeScript({ target: { tabId }, files: ["overlay.js"] });
		overlayInjectedTabs.add(tabId);
	} catch {
		// Non-injectable page (PDF viewer, extension store, etc.) — ignore
	}
}

// Clear tracking sets when recording ends; scripts self-remove via state→idle.
function clearOverlayTabs(): void {
	overlayInjectedTabs.clear();
	cameraBubbleTabs.clear();
}

// Re-inject overlay (and camera bubble) when user switches to any tab while recording.
chrome.tabs.onActivated.addListener(({ tabId }) => {
	getState().then(async (st) => {
		if (st.kind === "recording" || st.kind === "arming") {
			await injectOverlay(tabId);
			const settings = await getSettings();
			if (settings.cameraOverlay) void injectCameraBubble(tabId);
		}
	});
});

// Re-inject overlay (and camera bubble) after a tab navigation wipes content scripts.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
	if (changeInfo.status !== "complete") return;
	const wasOverlayInjected = overlayInjectedTabs.has(tabId);
	overlayInjectedTabs.delete(tabId); // Navigation clears all content scripts
	const wasCamInjected = cameraBubbleTabs.has(tabId);
	cameraBubbleTabs.delete(tabId);

	getState().then(async (st) => {
		if (st.kind !== "recording" && st.kind !== "arming") return;
		const settings = await getSettings();
		if (wasOverlayInjected) {
			await injectOverlay(tabId);
			if (wasCamInjected && settings.cameraOverlay) void injectCameraBubble(tabId);
			return;
		}
		// Also cover the case where the active tab navigates before ever getting the overlay.
		const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
		if (active?.id === tabId) {
			await injectOverlay(tabId);
			if (settings.cameraOverlay) void injectCameraBubble(tabId);
		}
	});
});

// Detect capture tab closed before recording ends.
chrome.tabs.onRemoved.addListener((removedTabId: number) => {
	overlayInjectedTabs.delete(removedTabId);
	cameraBubbleTabs.delete(removedTabId);
	if (captureTabId !== removedTabId) return;
	captureTabId = null;
	getState().then(async (st) => {
		if (st.kind === "arming") {
			// Closed before picking — go idle.
			await setState({ kind: "idle" });
			updateBadge({ kind: "idle" });
		} else if (st.kind === "recording") {
			// Closed mid-recording — finalize with whatever chunks arrived.
			stopKeepAlive();
			await finalizeUpload();
		}
	});
});

// ── Broadcast to capture tab ───────────────────────────────────────────────
// capture.ts listens via chrome.runtime.onMessage; this is a plain broadcast.

function sendToCapturePage(message: Record<string, unknown>): Promise<unknown> {
	return new Promise((resolve, reject) => {
		chrome.runtime.sendMessage(message, (response: unknown) => {
			if (chrome.runtime.lastError) {
				reject(new Error(chrome.runtime.lastError.message));
			} else {
				resolve(response);
			}
		});
	});
}

// ── Badge ─────────────────────────────────────────────────────────────────

function updateBadge(state: ExtensionState): void {
	switch (state.kind) {
		case "recording":
			chrome.action.setBadgeText({ text: "REC" });
			chrome.action.setBadgeBackgroundColor({ color: "#e53e3e" });
			break;
		case "uploading":
		case "finishing":
			chrome.action.setBadgeText({ text: "↑" });
			chrome.action.setBadgeBackgroundColor({ color: "#3182ce" });
			break;
		case "complete":
			chrome.action.setBadgeText({ text: "✓" });
			chrome.action.setBadgeBackgroundColor({ color: "#38a169" });
			break;
		case "error":
			chrome.action.setBadgeText({ text: "!" });
			chrome.action.setBadgeBackgroundColor({ color: "#dd6b20" });
			break;
		default:
			chrome.action.setBadgeText({ text: "" });
			break;
	}
}

// ── Message routing ────────────────────────────────────────────────────────

interface MessageBase {
	type: string;
}

function isMessageBase(v: unknown): v is MessageBase {
	return (
		typeof v === "object" &&
		v !== null &&
		"type" in v &&
		typeof (v as Record<string, unknown>).type === "string"
	);
}

function getString(
	obj: Record<string, unknown>,
	key: string,
): string | undefined {
	const v = obj[key];
	return typeof v === "string" ? v : undefined;
}

function getNumber(
	obj: Record<string, unknown>,
	key: string,
): number | undefined {
	const v = obj[key];
	return typeof v === "number" ? v : undefined;
}

function _getBoolean(
	obj: Record<string, unknown>,
	key: string,
): boolean | undefined {
	const v = obj[key];
	return typeof v === "boolean" ? v : undefined;
}

// ── Shared capture helper (Record Screen + Record Meeting) ────────────────

async function launchMeetCapture(
	_meetingId: string | undefined,
	_tabId: number | undefined,
	_settings: ExtensionSettings,
): Promise<void> {
	// Reset the chunk serialization tail so prior-recording chain entries
	// don't block the new recording's RECORDER_STOPPED processing.
	chunkTail = Promise.resolve();

	// Pre-inject overlay into the active tab NOW (during arming/countdown) so
	// it is already in the page and appears instantly when recording starts.
	const [activeTab] = await chrome.tabs.query({
		active: true,
		lastFocusedWindow: true,
	});
	if (activeTab?.id != null) {
		void injectOverlay(activeTab.id);
		// Inject camera preview bubble if camera overlay is enabled
		if (_settings.cameraOverlay) void injectCameraBubble(activeTab.id);
	}

	// capture.ts handles picker + getUserMedia + MediaRecorder in one context.
	// It reads mic settings from storage directly, so we only need to open it.
	const tab = await new Promise<chrome.tabs.Tab | null>((resolve) => {
		chrome.tabs.create(
			{ url: chrome.runtime.getURL("capture.html"), active: true },
			(t) => resolve(chrome.runtime.lastError ? null : (t ?? null)),
		);
	});

	if (!tab?.id) {
		const errState: ExtensionState = {
			kind: "error",
			reason: "Couldn't open capture page",
			recoverable: true,
		};
		await setState(errState);
		updateBadge(errState);
		return;
	}

	captureTabId = tab.id;
}

async function handleMessage(
	message: unknown,
	_sender: chrome.runtime.MessageSender,
): Promise<unknown> {
	if (!isMessageBase(message)) return { ok: false, error: "invalid message" };

	const msg = message as Record<string, unknown>;
	const type = msg.type as string;

	switch (type) {
		// ── Popup: start instruction (screen) recording ──────────────────
		case "START_INSTRUCTION": {
			const state = await getState();
			if (state.kind !== "idle" && state.kind !== "error") {
				return { ok: false, error: "already active" };
			}
			const settings = await getSettings();
			await setState({ kind: "arming", mode: "instruction" });
			// Reuse the same desktop-capture path as START_MEET so they cannot drift.
			await launchMeetCapture(undefined, undefined, settings);
			return { ok: true };
		}

		// ── Popup: start meeting recording ────────────────────────────────
		case "START_MEET": {
			const meetingId = getString(msg, "meetingId");
			const tabId = getNumber(msg, "tabId");
			const state = await getState();
			if (state.kind !== "idle" && state.kind !== "error") {
				return { ok: false, error: "already active" };
			}
			const settings = await getSettings();
			await setState({ kind: "arming", mode: "meeting", meetingId, tabId });
			await launchMeetCapture(meetingId, tabId, settings);
			return { ok: true };
		}

		// ── Popup: stop ───────────────────────────────────────────────────
		case "STOP": {
			await sendToCapturePage({ type: "STOP_CAPTURE" }).catch(() => {});
			return { ok: true };
		}

		// ── Popup: pause ──────────────────────────────────────────────────
		case "PAUSE": {
			const pauseSt = await getState();
			if (pauseSt.kind === "recording" && !pauseSt.paused) {
				const next = { ...pauseSt, paused: true, pauseStartedAt: Date.now() };
				await setState(next);
				updateBadge(next);
			}
			await sendToCapturePage({ type: "PAUSE_CAPTURE" }).catch(() => {});
			return { ok: true };
		}

		// ── Popup: resume ─────────────────────────────────────────────────
		case "RESUME": {
			const resumeSt = await getState();
			if (resumeSt.kind === "recording" && resumeSt.paused) {
				const additionalPause = resumeSt.pauseStartedAt
					? Date.now() - resumeSt.pauseStartedAt
					: 0;
				const next = {
					...resumeSt,
					paused: false,
					pauseStartedAt: undefined,
					totalPausedMs: resumeSt.totalPausedMs + additionalPause,
				};
				await setState(next);
				updateBadge(next);
			}
			await sendToCapturePage({ type: "RESUME_CAPTURE" }).catch(() => {});
			return { ok: true };
		}

		// ── Overlay: delete (discard + cancel, no upload, no restart) ───────
		case "DELETE_RECORDING": {
			pendingDeleteAfterDiscard = true;
			await sendToCapturePage({ type: "DISCARD_RECORDING" }).catch(() => {});
			return { ok: true };
		}

		// ── Overlay: restart (discard + fresh take) ───────────────────────
		case "RESTART": {
			pendingDeleteAfterDiscard = false;
			await sendToCapturePage({ type: "DISCARD_RECORDING" }).catch(() => {});
			return { ok: true };
		}

		// ── Capture page: user cancelled picker ───────────────────────────
		case "CAPTURE_CANCELLED": {
			captureTabId = null;
			const cancelState = await getState();
			if (cancelState.kind === "arming") {
				await setState({ kind: "idle" });
				updateBadge({ kind: "idle" });
			}
			return { ok: true };
		}

		// ── Popup: cancel ─────────────────────────────────────────────────
		case "CANCEL": {
			if (captureTabId !== null) {
				chrome.tabs.remove(captureTabId).catch(() => {});
				captureTabId = null;
			}
			clearOverlayTabs(); // Overlay self-removes via state→idle
			await sendToCapturePage({ type: "STOP_CAPTURE" }).catch(() => {});
			await setState({ kind: "idle" });
			updateBadge({ kind: "idle" });
			return { ok: true };
		}

		// ── Popup / content: get state ────────────────────────────────────
		case "GET_STATE": {
			return await getState();
		}

		// ── Content: Meet call started ────────────────────────────────────
		case "MEET_CALL_STARTED": {
			const settings = await getSettings();
			if (settings.autoRecordOnMeet) {
				return {
					autoRecord: true,
					countdownSec: settings.autoRecordCountdownSec,
				};
			}
			return { autoRecord: false };
		}

		// ── Content: Meet call ended ──────────────────────────────────────
		case "MEET_CALL_ENDED": {
			const meetingId = getString(msg, "meetingId");
			const state = await getState();
			if (
				state.kind === "recording" &&
				state.mode === "meeting" &&
				state.meetingId === meetingId
			) {
				await sendToCapturePage({ type: "STOP_CAPTURE" }).catch(() => {});
			}
			return { ok: true };
		}

		// ── Content: user clicked "Record now" nudge ──────────────────────
		case "MEET_NUDGE_RECORD_NOW": {
			const meetingId = getString(msg, "meetingId");
			const tabId = _sender.tab?.id;
			const state = await getState();
			if (state.kind !== "idle" && state.kind !== "error") {
				return { ok: false, error: "already active" };
			}
			const settings = await getSettings();
			await setState({ kind: "arming", mode: "meeting", meetingId, tabId });
			await launchMeetCapture(meetingId, tabId, settings);
			return { ok: true };
		}

		case "MEET_NUDGE_LATER":
		case "MEET_NUDGE_DISMISS":
			return { ok: true };

		// ── Content: settings query ───────────────────────────────────────
		case "GET_SETTINGS": {
			const settings = await getSettings();
			return {
				autoRecordOnMeet: settings.autoRecordOnMeet,
				autoRecordCountdownSec: settings.autoRecordCountdownSec,
				soundEnabled: settings.soundEnabled,
			};
		}

		// ── Offscreen: recorder started ───────────────────────────────────
		case "RECORDER_STARTED": {
			const mime = getString(msg, "mime") ?? "video/webm";
			const state = await getState();
			const mode = state.kind === "arming" ? state.mode : "instruction";
			const meetingId = state.kind === "arming" ? state.meetingId : undefined;
			const tabId = state.kind === "arming" ? state.tabId : undefined;

			let videoId: string;
			let uploadId: string;
			try {
				const result = await initializeUpload(mode, meetingId, mime);
				videoId = result.videoId;
				uploadId = result.uploadId;
			} catch (err) {
				console.error("[sw] initializeUpload failed:", err);
				const errState: ExtensionState = {
					kind: "error",
					reason: `Failed to initialize upload: ${err instanceof Error ? err.message : String(err)}`,
					recoverable: true,
				};
				await setState(errState);
				updateBadge(errState);
				return { ok: false, error: "initializeUpload failed" };
			}

			const nextState: ExtensionState = {
				kind: "recording",
				mode,
				videoId,
				uploadId,
				startedAt: Date.now(),
				parts: [],
				nextPartNumber: 1,
				totalBytes: 0,
				uploadedBytes: 0,
				meetingId,
				tabId,
				mime,
				paused: false,
				totalPausedMs: 0,
			};
			await setState(nextState);
			startKeepAlive();
			updateBadge(nextState);
			// Overlay is already pre-injected (launchMeetCapture) and listening to
			// chrome.storage.onChanged — it will show the recording pill automatically.

			return { ok: true };
		}

		// ── Offscreen: data chunk ─────────────────────────────────────────
		case "RECORDER_CHUNK": {
			const raw = msg.chunk as number[] | undefined;
			const index = getNumber(msg, "index") ?? 0;
			const mime = getString(msg, "mime") ?? "video/webm";
			if (raw && Array.isArray(raw) && raw.length > 0) {
				const ab = new Uint8Array(raw).buffer;
				// Chain onto chunkTail: RECORDER_STOPPED awaits this tail, so
				// finalizeUpload() cannot drain the buffer until every chunk appends.
				chunkTail = chunkTail.then(() => handleChunk(ab, index, mime)).catch(() => {});
				await chunkTail;
			}
			return { ok: true };
		}

		// ── Capture page: recorder stopped ───────────────────────────────
		case "RECORDER_STOPPED": {
			// Wait for every RECORDER_CHUNK that arrived before this message to
			// finish appending to inMemoryBuffer before finalizeUpload drains it.
			await chunkTail;
			captureTabId = null;
			clearOverlayTabs(); // Overlay self-removes via state→uploading/complete
			const state = await getState();
			// If CANCEL already moved us to idle, do not attempt to upload.
			if (state.kind !== "recording") return { ok: true };

			// Compute the true media duration (wall-clock minus paused intervals).
			// If currently paused when stop fires, add the current pause segment too.
			const now = Date.now();
			const extraPause = state.paused && state.pauseStartedAt
				? now - state.pauseStartedAt
				: 0;
			const durationMs = now - state.startedAt - state.totalPausedMs - extraPause;

			const nextState: ExtensionState = {
				kind: "uploading",
				videoId: state.videoId,
				uploadId: state.uploadId,
				parts: state.parts,
				totalBytes: state.totalBytes,
				uploadedBytes: state.uploadedBytes,
			};
			await setState(nextState);
			stopKeepAlive();
			updateBadge(nextState);
			await finalizeUpload(durationMs);
			return { ok: true };
		}

		// ── Capture page: recording discarded (restart OR delete path) ──────
		case "RECORDER_DISCARDED": {
			const discardSt = await getState();
			captureTabId = null;
			clearOverlayTabs();
			discardUpload();
			stopKeepAlive();
			await setState({ kind: "idle" });
			updateBadge({ kind: "idle" });

			if (pendingDeleteAfterDiscard) {
				// DELETE path — just go idle, no restart.
				pendingDeleteAfterDiscard = false;
				return { ok: true };
			}

			// RESTART path — launch a fresh recording.
			const restartMode = discardSt.kind === "recording" ? discardSt.mode : "instruction";
			const restartMeetingId = discardSt.kind === "recording" ? discardSt.meetingId : undefined;
			const restartTabId = discardSt.kind === "recording" ? discardSt.tabId : undefined;
			const restartSettings = await getSettings();
			await setState({ kind: "arming", mode: restartMode, meetingId: restartMeetingId, tabId: restartTabId });
			await launchMeetCapture(restartMeetingId, restartTabId, restartSettings);
			return { ok: true };
		}

		// ── Capture page: recorder error ─────────────────────────────────
		case "RECORDER_ERROR": {
			captureTabId = null;
			clearOverlayTabs();
			const error = getString(msg, "error") ?? "Unknown recorder error";
			const state = await getState();
			const previousVideoId =
				state.kind === "recording" ? state.videoId : undefined;

			const nextState: ExtensionState = {
				kind: "error",
				reason: error,
				recoverable: true,
				previousVideoId,
			};
			await setState(nextState);
			stopKeepAlive();
			updateBadge(nextState);

			chrome.notifications.create("recorder-error", {
				type: "basic",
				iconUrl: "icons/icon-128.png",
				title: "Recording error",
				message: error,
			});
			return { ok: true };
		}

		// ── Popup: retry after error ──────────────────────────────────────
		case "RETRY": {
			const state = await getState();
			if (state.kind !== "error")
				return { ok: false, error: "not in error state" };
			await setState({ kind: "idle" });
			updateBadge({ kind: "idle" });
			return { ok: true };
		}

		// ── Options: save settings ────────────────────────────────────────
		case "SAVE_SETTINGS": {
			const settings = msg.settings as Partial<ExtensionSettings> | undefined;
			if (settings) {
				await setSettings(settings);
			}
			return { ok: true };
		}

		// ── Options: get all settings ─────────────────────────────────────
		case "GET_ALL_SETTINGS": {
			const s = await getSettings();
			console.log("[sw] GET_ALL_SETTINGS — apiKey set:", s.apiKey.length > 0);
			return s;
		}

		// ── Sign-in-with-Cap token from options page ──────────────────────
		case "CAP_EXTENSION_TOKEN": {
			const token = getString(msg, "token");
			const apiBaseUrl = getString(msg, "apiBaseUrl");
			if (token) {
				await setSettings({
					apiKey: token,
					...(apiBaseUrl ? { apiBaseUrl } : {}),
				});
			}
			return { ok: true };
		}

		default:
			return { ok: false, error: `unknown message type: ${type}` };
	}
}

// ── External message handler (sign-in-with-Cap callback page) ─────────────

chrome.runtime.onMessageExternal.addListener(
	(message: unknown, _sender, sendResponse) => {
		if (!isMessageBase(message)) {
			sendResponse({ ok: false });
			return false;
		}
		const msg = message as Record<string, unknown>;
		if (msg.type === "CAP_EXTENSION_TOKEN") {
			const token = getString(msg, "token");
			const apiBaseUrl = getString(msg, "apiBaseUrl");
			console.log(
				"[sw:ext] CAP_EXTENSION_TOKEN — apiBaseUrl:",
				apiBaseUrl,
				"tokenLen:",
				token?.length ?? 0,
			);
			setSettings({
				apiKey: token ?? "",
				...(apiBaseUrl ? { apiBaseUrl } : {}),
			})
				.then(() => {
					console.log("[sw:ext] CAP_EXTENSION_TOKEN — written to storage ✓");
					sendResponse({ ok: true });
				})
				.catch((err: unknown) => {
					console.error("[sw:ext] CAP_EXTENSION_TOKEN — write failed:", err);
					sendResponse({ ok: false });
				});
			return true;
		}
		sendResponse({ ok: false });
		return false;
	},
);

// ── Internal message router ────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
	(message: unknown, sender: chrome.runtime.MessageSender, sendResponse) => {
		handleMessage(message, sender)
			.then(sendResponse)
			.catch((err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				sendResponse({ ok: false, error: msg });
			});
		return true;
	},
);

// ── Alarms ────────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener((alarm) => {
	if (isKeepAliveAlarm(alarm.name)) {
		chrome.storage.local.get("capExtState");
	}
});

// ── SW startup recovery ────────────────────────────────────────────────────

chrome.runtime.onStartup.addListener(async () => {
	const state = await getState();

	if (state.kind === "recording") {
		chrome.notifications.create("recording-interrupted", {
			type: "basic",
			iconUrl: "icons/icon-128.png",
			title: "Recording interrupted",
			message:
				"The browser restarted during recording. Uploading what was captured...",
		});
		const nextState: ExtensionState = {
			kind: "uploading",
			videoId: state.videoId,
			uploadId: state.uploadId,
			parts: state.parts,
			totalBytes: state.totalBytes,
			uploadedBytes: state.uploadedBytes,
		};
		await setState(nextState);
		updateBadge(nextState);
	}

	if (state.kind === "recording" || state.kind === "uploading") {
		startKeepAlive();
	}

	await retryPendingUploads();
});

// ── Install hook: hydrate badge from persisted state ──────────────────────

chrome.runtime.onInstalled.addListener(async () => {
	const state = await getState();
	updateBadge(state);
});
