import { isKeepAliveAlarm, startKeepAlive, stopKeepAlive } from "./keepalive";
import type { ExtensionSettings, ExtensionState } from "./state";
import { getSettings, getState, setSettings, setState } from "./state";
import {
	finalizeUpload,
	handleChunk,
	initializeUpload,
	retryPendingUploads,
} from "./upload";

// ── Capture-page relay ────────────────────────────────────────────────────
//
// chrome.desktopCapture.chooseDesktopMedia CANNOT be called from a service
// worker without a targetTab (Chrome MV3 throws "A target tab is required").
// If a targetTab IS supplied, the resulting streamId is bound to that tab and
// cannot be used in the offscreen document ("Error starting tab capture").
//
// Solution: open a dedicated extension page (capture.html).  Extension pages
// are NOT service workers, so chooseDesktopMedia works there without targetTab,
// and the returned streamId is valid for any extension context including the
// offscreen document.

interface PendingCapture {
	resolve: (streamId: string) => void;
	reject: (err: Error) => void;
	tabId: number | null;
}

let pendingCapture: PendingCapture | null = null;

function openCapturePage(): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		if (pendingCapture) {
			pendingCapture.reject(new Error("superseded"));
			pendingCapture = null;
		}
		pendingCapture = { resolve, reject, tabId: null };
		chrome.tabs.create(
			{ url: chrome.runtime.getURL("capture.html"), active: true },
			(tab) => {
				if (chrome.runtime.lastError) {
					if (pendingCapture) {
						pendingCapture.reject(
							new Error(
								chrome.runtime.lastError.message ?? "could not open capture tab",
							),
						);
						pendingCapture = null;
					}
					return;
				}
				if (pendingCapture) {
					pendingCapture.tabId = tab?.id ?? null;
				}
			},
		);
	});
}

// If the user closes the capture tab before picking, reject the pending promise.
chrome.tabs.onRemoved.addListener((removedTabId: number) => {
	if (pendingCapture && pendingCapture.tabId === removedTabId) {
		pendingCapture.reject(new Error("cancelled"));
		pendingCapture = null;
	}
});

// ── Offscreen document ─────────────────────────────────────────────────────

async function ensureOffscreenDocument(): Promise<void> {
	const existingContexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (existingContexts.length > 0) return;
	await chrome.offscreen.createDocument({
		url: "offscreen.html",
		reasons: [chrome.offscreen.Reason.USER_MEDIA],
		justification: "Recording screen/tab media",
	});
}

async function closeOffscreenDocument(): Promise<void> {
	const existingContexts = await chrome.runtime.getContexts({
		contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
	});
	if (existingContexts.length > 0) {
		await chrome.offscreen.closeDocument();
	}
}

function sendToOffscreen(message: Record<string, unknown>): Promise<unknown> {
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
	meetingId: string | undefined,
	tabId: number | undefined,
	settings: ExtensionSettings,
): Promise<void> {
	// Create the offscreen document BEFORE showing the picker so the streamId
	// is never stale by the time getUserMedia runs inside the offscreen doc.
	await ensureOffscreenDocument();

	let streamId: string;
	try {
		streamId = await openCapturePage();
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		// Close the offscreen doc we just pre-created.
		await closeOffscreenDocument().catch(() => {});
		if (reason === "cancelled" || reason === "superseded") {
			await setState({ kind: "idle" });
			updateBadge({ kind: "idle" });
		} else {
			const errState: ExtensionState = {
				kind: "error",
				reason: `Couldn't start screen capture: ${reason}`,
				recoverable: true,
			};
			await setState(errState);
			updateBadge(errState);
		}
		return;
	}

	await sendToOffscreen({
		type: "START_CAPTURE",
		mode: "desktop",
		streamId,
		meetingId,
		tabId,
		micEnabled: settings.micEnabled,
		...(settings.micEnabled ? { micDeviceId: settings.micDeviceId } : {}),
	});
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
			await sendToOffscreen({ type: "STOP_CAPTURE" });
			return { ok: true };
		}

		// ── Popup: pause ──────────────────────────────────────────────────
		case "PAUSE": {
			await sendToOffscreen({ type: "PAUSE_CAPTURE" });
			return { ok: true };
		}

		// ── Popup: resume ─────────────────────────────────────────────────
		case "RESUME": {
			await sendToOffscreen({ type: "RESUME_CAPTURE" });
			return { ok: true };
		}

		// ── Capture page: relay streamId from capture.html back to SW ────
		case "CAPTURE_RESULT": {
			const streamId = getString(msg, "streamId");
			const captureError = getString(msg, "error");
			if (pendingCapture) {
				if (streamId) {
					pendingCapture.resolve(streamId);
				} else {
					pendingCapture.reject(
						new Error(captureError ?? "cancelled"),
					);
				}
				pendingCapture = null;
			}
			return { ok: true };
		}

		// ── Popup: cancel ─────────────────────────────────────────────────
		case "CANCEL": {
			if (pendingCapture) {
				if (pendingCapture.tabId !== null) {
					chrome.tabs.remove(pendingCapture.tabId);
				}
				pendingCapture.reject(new Error("cancelled"));
				pendingCapture = null;
			}
			await sendToOffscreen({ type: "STOP_CAPTURE" }).catch(() => {});
			await closeOffscreenDocument();
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
				await sendToOffscreen({ type: "STOP_CAPTURE" });
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
				const result = await initializeUpload(mode, meetingId);
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
				await closeOffscreenDocument().catch(() => {});
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
			};
			await setState(nextState);
			startKeepAlive();
			updateBadge(nextState);
			return { ok: true };
		}

		// ── Offscreen: data chunk ─────────────────────────────────────────
		case "RECORDER_CHUNK": {
			const raw = msg.chunk as number[] | undefined;
			const index = getNumber(msg, "index") ?? 0;
			const mime = getString(msg, "mime") ?? "video/webm";
			if (raw && Array.isArray(raw) && raw.length > 0) {
				await handleChunk(new Uint8Array(raw).buffer, index, mime);
			}
			return { ok: true };
		}

		// ── Offscreen: recorder stopped ───────────────────────────────────
		case "RECORDER_STOPPED": {
			const state = await getState();
			const videoId = state.kind === "recording" ? state.videoId : "stub";
			const uploadId = state.kind === "recording" ? state.uploadId : "stub";
			const parts = state.kind === "recording" ? state.parts : [];
			const totalBytes = state.kind === "recording" ? state.totalBytes : 0;
			const uploadedBytes =
				state.kind === "recording" ? state.uploadedBytes : 0;

			const nextState: ExtensionState = {
				kind: "uploading",
				videoId,
				uploadId,
				parts,
				totalBytes,
				uploadedBytes,
			};
			await setState(nextState);
			stopKeepAlive();
			updateBadge(nextState);
			await closeOffscreenDocument();
			await finalizeUpload();
			return { ok: true };
		}

		// ── Offscreen: recorder error ─────────────────────────────────────
		case "RECORDER_ERROR": {
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
			await closeOffscreenDocument().catch(() => {});

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
