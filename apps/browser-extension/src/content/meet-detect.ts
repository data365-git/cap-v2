// ── Types ──────────────────────────────────────────────────────────────────────

type NudgeState =
	| "default"
	| "countdown"
	| "recording"
	| "finishing"
	| "complete"
	| "error"
	| "hidden";

interface Settings {
	autoRecord: boolean;
	autoRecordCountdownSec: number;
	soundEnabled: boolean;
}

interface StateChangedMessage {
	type: "STATE_CHANGED";
	state: {
		kind: string;
		shareUrl?: string;
		reason?: string;
		recoverable?: boolean;
		uploadedBytes?: number;
		totalBytes?: number;
		paused?: boolean;
		startedAt?: number;
	};
}

type OutboundMessage =
	| { type: "MEET_CALL_STARTED"; meetingId: string }
	| { type: "MEET_CALL_ENDED"; meetingId: string }
	| { type: "MEET_NUDGE_RECORD_NOW"; meetingId: string }
	| { type: "MEET_NUDGE_LATER" }
	| { type: "MEET_NUDGE_DISMISS" }
	| { type: "GET_SETTINGS" }
	| { type: "STOP" }
	| { type: "CANCEL" }
	| { type: "RETRY" };

// ── State ─────────────────────────────────────────────────────────────────────

let meetingId: string | null = null;
let nudgeState: NudgeState = "hidden";
let laterUntil = 0;
let dismissed = false;
let inCall = false;

const settings: Settings = {
	autoRecord: false,
	autoRecordCountdownSec: 5,
	soundEnabled: false,
};

let countdownTimer: ReturnType<typeof setInterval> | null = null;
let countdownRemaining = 0;
let recordingStartTime = 0;
let elapsedTimer: ReturnType<typeof setInterval> | null = null;

let shadowHost: HTMLElement | null = null;
let shadowRoot: ShadowRoot | null = null;

const LATER_MS = 12 * 60 * 1000;

// ── Meet detection ────────────────────────────────────────────────────────────

function isMeetingUrl(): boolean {
	return /^\/[a-z]+-[a-z]+-[a-z]+/.test(location.pathname);
}

/**
 * Detect whether the user is currently in an active Google Meet call.
 *
 * Strategy: try a broad set of aria/data-attribute selectors first (Google
 * occasionally renames these), then fall back to scanning every <button> for
 * the text "leave call" (case-insensitive).  The text scan catches rebrands
 * that change attribute names but keep human-readable button labels.
 */
function isInMeeting(): boolean {
	// Primary: attribute-based selectors (fast, no DOM walk)
	const attrSelectors = [
		'[aria-label="Leave call"]',
		'[aria-label*="Leave call"]',
		'[data-tooltip="Leave call"]',
		'[data-tooltip*="Leave call"]',
		'[aria-label="Leave meeting"]',
		'[aria-label*="Leave meeting"]',
		'[data-tooltip="Leave meeting"]',
		'[data-tooltip*="Leave meeting"]',
	];
	for (const sel of attrSelectors) {
		if (document.querySelector(sel)) return true;
	}

	// Fallback: scan button text content for "leave call" or "leave meeting"
	const leaveRe = /leave\s+(call|meeting)/i;
	const buttons = document.querySelectorAll("button");
	for (const btn of buttons) {
		const label =
			btn.getAttribute("aria-label") ??
			btn.getAttribute("data-tooltip") ??
			btn.textContent ??
			"";
		if (leaveRe.test(label)) return true;
	}

	return false;
}

function currentMeetingId(): string | null {
	const m = location.pathname.match(/^(\/[a-z]+-[a-z]+-[a-z]+)/);
	return m ? m[1] : null;
}

// ── Sound helpers ─────────────────────────────────────────────────────────────

function sineNode(
	ctx: AudioContext,
	freq: number,
	t: number,
	startOffset: number,
	dur: number,
	vol: number,
): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.type = "sine";
	osc.frequency.setValueAtTime(freq, t + startOffset);
	gain.gain.setValueAtTime(0, t + startOffset);
	gain.gain.linearRampToValueAtTime(vol, t + startOffset + 0.008);
	gain.gain.exponentialRampToValueAtTime(0.001, t + startOffset + dur);
	osc.start(t + startOffset);
	osc.stop(t + startOffset + dur);
}

function soundDroplet(ctx: AudioContext, t: number): void {
	const osc = ctx.createOscillator();
	const gain = ctx.createGain();
	osc.connect(gain);
	gain.connect(ctx.destination);
	osc.type = "sine";
	osc.frequency.setValueAtTime(1700, t);
	osc.frequency.exponentialRampToValueAtTime(360, t + 0.11);
	gain.gain.setValueAtTime(0, t);
	gain.gain.linearRampToValueAtTime(0.3, t + 0.005);
	gain.gain.exponentialRampToValueAtTime(0.001, t + 0.36);
	osc.start(t);
	osc.stop(t + 0.38);
}

function soundChime(ctx: AudioContext, t: number): void {
	sineNode(ctx, 880, t, 0, 0.38, 0.22);
	sineNode(ctx, 1318, t, 0.16, 0.5, 0.18);
}

function playAudio(fn: (ctx: AudioContext, t: number) => void): void {
	if (!settings.soundEnabled) return;
	try {
		const ctx = new AudioContext();
		const play = () => {
			fn(ctx, ctx.currentTime);
			setTimeout(() => ctx.close().catch(() => {}), 1500);
		};
		if (ctx.state === "suspended") {
			ctx
				.resume()
				.then(play)
				.catch(() => {});
		} else {
			play();
		}
	} catch (_) {}
}

// ── Shadow DOM + CSS ──────────────────────────────────────────────────────────

const NUDGE_CSS = `
:host { all: initial; }

.cap-nudge-container {
	position: fixed;
	bottom: 88px;
	right: 16px;
	left: auto;
	top: auto;
	transform: none;
	z-index: 2147483647;
	font-family: system-ui, sans-serif;
	font-size: 14px;
	color: #1a1a1a;
	pointer-events: all;
	user-select: none;
}

@keyframes cap-nudge-in {
	from { opacity: 0; transform: translateY(8px) scale(0.97); }
	to   { opacity: 1; transform: translateY(0) scale(1); }
}

@keyframes cap-nudge-out {
	from { opacity: 1; transform: translateY(0) scale(1); }
	to   { opacity: 0; transform: translateY(6px) scale(0.97); }
}

@keyframes cap-nudge-pulse {
	0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,.65); }
	55%       { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
}

.cap-nudge-card {
	background: #ffffff;
	border-radius: 14px;
	box-shadow: 0 4px 24px rgba(0,0,0,.12), 0 1px 4px rgba(0,0,0,.06);
	border: 1px solid rgba(0,0,0,.06);
	padding: 14px 16px;
	min-width: 320px;
	max-width: 480px;
	width: auto;
	box-sizing: border-box;
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-card.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-header {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-bottom: 10px;
}

.cap-nudge-icon {
	width: 28px;
	height: 28px;
	border-radius: 6px;
	flex-shrink: 0;
	display: block;
}

.cap-nudge-title {
	font-weight: 700;
	font-size: 14px;
	margin: 0;
	color: #111;
}

.cap-nudge-subtitle {
	font-size: 12px;
	color: #666;
	margin: 0;
}

.cap-nudge-buttons {
	display: flex;
	justify-content: center;
	gap: 16px;
	align-items: center;
}

.cap-nudge-btn-primary {
	background: #675FFF;
	color: #fff;
	border: none;
	border-radius: 10px;
	padding: 9px 14px;
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	transition: filter .15s, transform .1s, outline .1s;
	white-space: nowrap;
	flex-shrink: 0;
}

.cap-nudge-btn-primary:hover { filter: brightness(1.1); }

.cap-nudge-btn-primary:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-primary:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-btn-secondary {
	background: transparent;
	color: #6b7280;
	border: none;
	border-radius: 6px;
	padding: 4px 6px;
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	font-family: inherit;
	transition: color .15s, transform .1s, outline .1s;
	white-space: nowrap;
	text-decoration: none;
}

.cap-nudge-btn-secondary:hover { color: #374151; }

.cap-nudge-btn-secondary:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-secondary:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-btn-dismiss {
	background: transparent;
	border: none;
	color: #6b7280;
	font-size: 12px;
	cursor: pointer;
	font-family: inherit;
	padding: 4px 6px;
	text-decoration: none;
	white-space: nowrap;
	transition: color .15s, opacity .1s;
}

.cap-nudge-btn-dismiss:hover { color: #374151; }

.cap-nudge-btn-dismiss:active { opacity: 0.5; }

.cap-nudge-btn-cancel {
	display: block;
	width: 100%;
	background: #f3f4f6;
	color: #374151;
	border: none;
	border-radius: 10px;
	padding: 9px 0;
	font-size: 13px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	margin-bottom: 8px;
	transition: background .15s;
}

.cap-nudge-btn-cancel:hover { background: #e5e7eb; }

.cap-nudge-no-auto {
	display: block;
	text-align: center;
	background: transparent;
	border: none;
	color: #9ca3af;
	font-size: 11px;
	cursor: pointer;
	font-family: inherit;
	text-decoration: underline;
}

.cap-nudge-no-auto:hover { color: #6b7280; }

.cap-nudge-pill {
	background: #111827;
	border-radius: 999px;
	padding: 8px 14px;
	display: inline-flex;
	align-items: center;
	gap: 10px;
	box-shadow: 0 4px 12px rgba(0,0,0,0.2);
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-pill.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: #ef4444;
	flex-shrink: 0;
	animation: cap-nudge-pulse 1.9s ease-out infinite;
}

.cap-nudge-elapsed {
	font-size: 13px;
	font-weight: 600;
	color: #f9fafb;
	font-variant-numeric: tabular-nums;
	min-width: 52px;
}

.cap-nudge-paused-label {
	font-size: 11px;
	color: #9ca3af;
}

.cap-nudge-btn-stop {
	background: #ef4444;
	color: #fff;
	border: none;
	border-radius: 6px;
	padding: 4px 10px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	transition: filter .15s, transform .1s, outline .1s;
}

.cap-nudge-btn-stop:hover { filter: brightness(1.1); }

.cap-nudge-btn-stop:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-stop:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-progress {
	font-size: 11px;
	color: #9ca3af;
	margin-left: 4px;
}

.cap-nudge-complete-card {
	background: #ffffff;
	border-radius: 14px;
	box-shadow: 0 4px 24px rgba(0,0,0,.12), 0 1px 4px rgba(0,0,0,.06);
	border: 1px solid rgba(0,0,0,.06);
	padding: 16px;
	width: 288px;
	box-sizing: border-box;
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-complete-card.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-complete-check {
	font-size: 22px;
	color: #16a34a;
	margin: 0;
	line-height: 1;
}

.cap-nudge-share-url {
	font-size: 11px;
	color: #6b7280;
	word-break: break-all;
	margin: 4px 0 12px 0;
}

.cap-nudge-btn-copy {
	background: #675FFF;
	color: #fff;
	border: none;
	border-radius: 8px;
	padding: 7px 14px;
	font-size: 12px;
	font-weight: 600;
	cursor: pointer;
	font-family: inherit;
	transition: filter .15s, transform .1s, outline .1s;
	white-space: nowrap;
}

.cap-nudge-btn-copy:hover { filter: brightness(1.1); }

.cap-nudge-btn-copy:active {
	transform: scale(0.97);
	opacity: 0.85;
}

.cap-nudge-btn-copy:focus-visible {
	outline: 2px solid #6366f1;
	outline-offset: 2px;
}

.cap-nudge-btn-open {
	background: #f3f4f6;
	color: #374151;
	border: none;
	border-radius: 8px;
	padding: 7px 14px;
	font-size: 12px;
	font-weight: 500;
	cursor: pointer;
	font-family: inherit;
	transition: background .15s;
	white-space: nowrap;
}

.cap-nudge-btn-open:hover { background: #e5e7eb; }

.cap-nudge-error-card {
	background: #ffffff;
	border-radius: 14px;
	box-shadow: 0 4px 24px rgba(0,0,0,.12), 0 1px 4px rgba(0,0,0,.06);
	border: 1px solid rgba(0,0,0,.06);
	padding: 16px;
	width: 288px;
	box-sizing: border-box;
	animation: cap-nudge-in .25s cubic-bezier(.2,.8,.4,1) both;
}

.cap-nudge-error-card.cap-nudge-leaving { animation: cap-nudge-out .2s ease-in both; }

.cap-nudge-error-msg {
	font-size: 12px;
	color: #dc2626;
	margin: 4px 0 12px 0;
}

.cap-nudge-main-row {
	display: flex;
	align-items: center;
	gap: 10px;
}

.cap-nudge-text {
	flex: 1;
	min-width: 0;
}

.cap-nudge-footer {
	display: flex;
	align-items: center;
	justify-content: space-between;
	margin-top: 10px;
	gap: 8px;
}

.cap-nudge-consent {
	font-size: 10px;
	color: #9ca3af;
	line-height: 1.4;
	flex: 1;
}

.cap-nudge-btn-x {
	flex-shrink: 0;
	background: transparent;
	border: none;
	color: #9ca3af;
	font-size: 14px;
	cursor: pointer;
	font-family: inherit;
	padding: 2px 5px;
	line-height: 1;
	border-radius: 4px;
	transition: color .15s, opacity .1s;
}

.cap-nudge-btn-x:hover { color: #374151; }
.cap-nudge-btn-x:active { opacity: 0.5; }

.cap-nudge-btn-later {
	flex-shrink: 0;
	background: transparent;
	border: none;
	color: #9ca3af;
	font-size: 10px;
	cursor: pointer;
	font-family: inherit;
	padding: 0;
	white-space: nowrap;
	text-decoration: underline;
	text-underline-offset: 2px;
	transition: color .15s;
}

.cap-nudge-btn-later:hover { color: #6b7280; }

@media (prefers-color-scheme: dark) {
	.cap-nudge-card,
	.cap-nudge-complete-card,
	.cap-nudge-error-card {
		background: #1f2937;
		border-color: rgba(255,255,255,.08);
	}

	.cap-nudge-title { color: #f9fafb; }

	.cap-nudge-subtitle,
	.cap-nudge-elapsed,
	.cap-nudge-share-url,
	.cap-nudge-paused-label,
	.cap-nudge-progress {
		color: #9ca3af;
	}

	.cap-nudge-btn-secondary,
	.cap-nudge-btn-dismiss {
		color: #6b7280;
	}

	.cap-nudge-btn-secondary:hover,
	.cap-nudge-btn-dismiss:hover {
		color: #9ca3af;
	}

	.cap-nudge-btn-cancel {
		background: #374151;
		color: #f9fafb;
	}

	.cap-nudge-btn-cancel:hover { background: #4b5563; }

	.cap-nudge-btn-open {
		background: #374151;
		color: #f9fafb;
	}

	.cap-nudge-btn-open:hover { background: #4b5563; }

	.cap-nudge-pill { background: #111827; }

	.cap-nudge-no-auto { color: #6b7280; }
	.cap-nudge-no-auto:hover { color: #9ca3af; }

	.cap-nudge-consent { color: #6b7280; }

	.cap-nudge-btn-x { color: #6b7280; }
	.cap-nudge-btn-x:hover { color: #9ca3af; }

	.cap-nudge-btn-later { color: #6b7280; }
	.cap-nudge-btn-later:hover { color: #9ca3af; }
}
`;

function ensureShadowRoot(): ShadowRoot {
	if (shadowRoot) return shadowRoot;

	shadowHost = document.createElement("div");
	shadowHost.id = "cap-nudge-host";
	document.body.appendChild(shadowHost);

	shadowRoot = shadowHost.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = NUDGE_CSS;
	shadowRoot.appendChild(style);

	const container = document.createElement("div");
	container.className = "cap-nudge-container";
	container.id = "cap-nudge-container";
	shadowRoot.appendChild(container);

	return shadowRoot;
}

function getNudgeContainer(): HTMLElement | null {
	if (!shadowRoot) return null;
	return shadowRoot.getElementById("cap-nudge-container");
}

function clearNudge(onRemoved?: () => void): void {
	const container = getNudgeContainer();
	if (!container || !container.firstChild) {
		onRemoved?.();
		return;
	}
	const child = container.firstChild as HTMLElement;
	child.classList.add("cap-nudge-leaving");
	setTimeout(() => {
		child.remove();
		onRemoved?.();
	}, 190);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

function makeEl<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	className?: string,
	text?: string,
): HTMLElementTagNameMap[K] {
	const el = document.createElement(tag);
	if (className) el.className = className;
	if (text) el.textContent = text;
	return el;
}

function makeBtn(className: string, text: string): HTMLButtonElement {
	const btn = document.createElement("button");
	btn.className = className;
	btn.textContent = text;
	return btn;
}

// ── Format helpers ────────────────────────────────────────────────────────────

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	const pad = (n: number) => String(n).padStart(2, "0");
	return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ── Nudge rendering ───────────────────────────────────────────────────────────

function renderDefaultNudge(): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	const card = makeEl("div", "cap-nudge-card");

	// ── Main row: icon | text | Record | ✕ ──────────────────────────────
	const mainRow = makeEl("div", "cap-nudge-main-row");

	const icon = document.createElement("img");
	icon.src = chrome.runtime.getURL("icons/icon-48.png");
	icon.className = "cap-nudge-icon";
	icon.alt = "Cap";

	const textBlock = makeEl("div", "cap-nudge-text");
	const title = makeEl("div", "cap-nudge-title", "Record this meeting?");
	const subtitle = makeEl(
		"div",
		"cap-nudge-subtitle",
		"Make sure participants have agreed.",
	);
	textBlock.append(title, subtitle);

	const btnRecord = makeBtn("cap-nudge-btn-primary", "Record");
	const btnX = makeBtn("cap-nudge-btn-x", "✕");

	mainRow.append(icon, textBlock, btnRecord, btnX);

	// ── Footer: consent text | Later link ────────────────────────────────
	const footer = makeEl("div", "cap-nudge-footer");
	const consent = makeEl(
		"span",
		"cap-nudge-consent",
		"By recording you confirm all participants have consented.",
	);
	const btnLater = makeBtn("cap-nudge-btn-later", "Later");
	footer.append(consent, btnLater);

	card.append(mainRow, footer);
	container.appendChild(card);
	nudgeState = "default";

	btnRecord.addEventListener("click", () => {
		sendToBackground({
			type: "MEET_NUDGE_RECORD_NOW",
			meetingId: meetingId ?? "",
		});
		clearNudge();
		nudgeState = "hidden";
	});

	btnX.addEventListener("click", () => {
		sendToBackground({ type: "MEET_NUDGE_DISMISS" });
		dismissed = true;
		clearNudge();
		nudgeState = "hidden";
	});

	btnLater.addEventListener("click", () => {
		sendToBackground({ type: "MEET_NUDGE_LATER" });
		laterUntil = Date.now() + LATER_MS;
		clearNudge();
		nudgeState = "hidden";
	});
}

function renderCountdownNudge(): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	countdownRemaining = settings.autoRecordCountdownSec;

	const card = makeEl("div", "cap-nudge-card");

	const titleEl = makeEl("div", "cap-nudge-title");
	const titleText = document.createTextNode("Starting recording in ");
	const numSpan = makeEl("span", undefined, String(countdownRemaining));
	const titleSuffix = document.createTextNode("s");
	titleEl.append(titleText, numSpan, titleSuffix);

	const btnCancel = makeBtn("cap-nudge-btn-cancel", "Cancel");
	const btnNoAuto = makeBtn(
		"cap-nudge-no-auto",
		"Don't auto-record this meeting",
	);

	card.append(titleEl, btnCancel, btnNoAuto);
	container.appendChild(card);
	nudgeState = "countdown";

	const onCancel = () => {
		stopCountdown();
		sendToBackground({ type: "MEET_NUDGE_DISMISS" });
		dismissed = true;
		clearNudge();
		nudgeState = "hidden";
	};

	btnCancel.addEventListener("click", onCancel);
	btnNoAuto.addEventListener("click", onCancel);

	countdownTimer = setInterval(() => {
		countdownRemaining -= 1;
		numSpan.textContent = String(countdownRemaining);
		if (countdownRemaining <= 0) {
			stopCountdown();
			playAudio(soundChime);
			sendToBackground({
				type: "MEET_NUDGE_RECORD_NOW",
				meetingId: meetingId ?? "",
			});
			clearNudge();
			nudgeState = "hidden";
		}
	}, 1000);
}

function stopCountdown(): void {
	if (countdownTimer !== null) {
		clearInterval(countdownTimer);
		countdownTimer = null;
	}
}

function renderRecordingPill(paused = false): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (recordingStartTime === 0) recordingStartTime = Date.now();

	const pill = makeEl("div", "cap-nudge-pill");
	const dot = makeEl("span", "cap-nudge-dot");
	const elapsed = makeEl(
		"span",
		"cap-nudge-elapsed",
		formatElapsed(Date.now() - recordingStartTime),
	);
	elapsed.id = "cap-elapsed";
	const btnStop = makeBtn("cap-nudge-btn-stop", "Stop");

	if (paused) {
		const pausedLabel = makeEl("span", "cap-nudge-paused-label", "Paused");
		pill.append(dot, elapsed, pausedLabel, btnStop);
	} else {
		pill.append(dot, elapsed, btnStop);
	}

	container.appendChild(pill);
	nudgeState = "recording";

	if (elapsedTimer !== null) clearInterval(elapsedTimer);
	if (!paused) {
		elapsedTimer = setInterval(() => {
			const el = container.querySelector("#cap-elapsed");
			if (el) el.textContent = formatElapsed(Date.now() - recordingStartTime);
		}, 1000);
	}

	btnStop.addEventListener("click", () => {
		sendToBackground({ type: "STOP" });
	});
}

function renderFinishingPill(): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (elapsedTimer !== null) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}

	const pill = makeEl("div", "cap-nudge-pill");
	const dot = makeEl("span", "cap-nudge-dot");
	dot.style.background = "#3182ce";
	dot.style.animation = "none";
	const label = makeEl("span", "cap-nudge-elapsed", "Finishing up...");
	pill.append(dot, label);
	container.appendChild(pill);
	nudgeState = "finishing";
}

function renderCompletePill(shareUrl: string): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (elapsedTimer !== null) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}
	recordingStartTime = 0;

	const card = makeEl("div", "cap-nudge-complete-card");

	// Header: check icon + title
	const header = makeEl("div", "cap-nudge-header");
	const check = makeEl("div", "cap-nudge-complete-check", "✓");
	const title = makeEl("div", "cap-nudge-title", "Recording saved!");
	header.append(check, title);

	const urlEl = makeEl("div", "cap-nudge-share-url", shareUrl);

	const buttons = makeEl("div", "cap-nudge-buttons");
	const copyBtn = makeBtn("cap-nudge-btn-copy", "Copy link");
	const openBtn = makeBtn("cap-nudge-btn-open", "Open");

	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(shareUrl).then(() => {
			copyBtn.textContent = "Copied!";
			setTimeout(() => {
				copyBtn.textContent = "Copy link";
			}, 2000);
		});
	});

	openBtn.addEventListener("click", () => {
		window.open(shareUrl, "_blank");
	});

	const dismissBtn = makeBtn("cap-nudge-btn-dismiss", "Dismiss");
	dismissBtn.addEventListener("click", () => {
		sendToBackground({ type: "CANCEL" } as OutboundMessage);
		clearNudge();
		nudgeState = "hidden";
	});

	buttons.append(copyBtn, openBtn);
	card.append(header, urlEl, buttons, dismissBtn);
	container.appendChild(card);
	nudgeState = "complete";
}

function renderErrorCard(reason: string, recoverable: boolean): void {
	const root = ensureShadowRoot();
	const container = root.getElementById("cap-nudge-container");
	if (!container) return;

	container.textContent = "";
	if (elapsedTimer !== null) {
		clearInterval(elapsedTimer);
		elapsedTimer = null;
	}
	recordingStartTime = 0;

	const card = makeEl("div", "cap-nudge-error-card");
	const title = makeEl("div", "cap-nudge-title", "Upload failed");
	const msg = makeEl("div", "cap-nudge-error-msg", reason);

	const buttons = makeEl("div", "cap-nudge-buttons");

	if (recoverable) {
		const retryBtn = makeBtn("cap-nudge-btn-primary", "Retry");
		retryBtn.addEventListener("click", () => {
			sendToBackground({ type: "RETRY" } as OutboundMessage);
		});
		buttons.appendChild(retryBtn);
	}

	const dismissBtn = makeBtn("cap-nudge-btn-secondary", "Dismiss");
	dismissBtn.addEventListener("click", () => {
		sendToBackground({ type: "CANCEL" } as OutboundMessage);
		clearNudge();
		nudgeState = "hidden";
	});

	buttons.appendChild(dismissBtn);
	card.append(title, msg, buttons);
	container.appendChild(card);
	nudgeState = "error";
}

// ── Message protocol ──────────────────────────────────────────────────────────

function sendToBackground(msg: OutboundMessage): void {
	chrome.runtime.sendMessage(msg).catch(() => {});
}

// ── Main gate ─────────────────────────────────────────────────────────────────

function maybeShow(): void {
	if (!isMeetingUrl() || !isInMeeting()) {
		if (inCall) {
			inCall = false;
			const id = meetingId;
			if (id) sendToBackground({ type: "MEET_CALL_ENDED", meetingId: id });
			stopCountdown();
			if (elapsedTimer !== null) {
				clearInterval(elapsedTimer);
				elapsedTimer = null;
			}
			clearNudge();
			nudgeState = "hidden";
		}
		return;
	}

	const id = currentMeetingId();
	if (id !== meetingId) {
		meetingId = id;
		dismissed = false;
		laterUntil = 0;
		inCall = false;
		stopCountdown();
		if (elapsedTimer !== null) {
			clearInterval(elapsedTimer);
			elapsedTimer = null;
		}
		recordingStartTime = 0;
		clearNudge();
		nudgeState = "hidden";
	}

	if (!inCall) {
		inCall = true;
		if (meetingId) sendToBackground({ type: "MEET_CALL_STARTED", meetingId });
		playAudio(soundDroplet);
	}

	if (
		nudgeState === "recording" ||
		nudgeState === "countdown" ||
		nudgeState === "finishing" ||
		nudgeState === "complete" ||
		nudgeState === "error"
	)
		return;
	if (dismissed || nudgeState === "default" || Date.now() < laterUntil) return;

	if (settings.autoRecord) {
		renderCountdownNudge();
	} else {
		renderDefaultNudge();
	}
}

// ── State change listener ─────────────────────────────────────────────────────

function handleStateChange(state: StateChangedMessage["state"]): void {
	switch (state.kind) {
		case "recording":
			stopCountdown();
			if (recordingStartTime === 0) {
				recordingStartTime = state.startedAt ?? Date.now();
			}
			clearNudge(() => renderRecordingPill(state.paused ?? false));
			break;
		case "uploading":
		case "finishing":
			clearNudge(() => renderFinishingPill());
			break;
		case "complete":
			if (state.shareUrl) {
				clearNudge(() => renderCompletePill(state.shareUrl as string));
			}
			break;
		case "error":
			clearNudge(() =>
				renderErrorCard(
					state.reason ?? "Unknown error",
					state.recoverable ?? false,
				),
			);
			break;
		case "idle":
			if (elapsedTimer !== null) {
				clearInterval(elapsedTimer);
				elapsedTimer = null;
			}
			recordingStartTime = 0;
			clearNudge();
			nudgeState = "hidden";
			if (isInMeeting()) {
				dismissed = false;
				setTimeout(maybeShow, 800);
			}
			break;
	}
}

chrome.runtime.onMessage.addListener((msg: unknown) => {
	if (!msg || typeof msg !== "object") return;
	const message = msg as Record<string, unknown>;
	if (message.type === "STATE_CHANGED" && message.state) {
		handleStateChange(message.state as StateChangedMessage["state"]);
	}
});

chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "local" && changes.capExtState?.newValue) {
		handleStateChange(
			changes.capExtState.newValue as StateChangedMessage["state"],
		);
	}
});

// ── Init: fetch settings then start ──────────────────────────────────────────

chrome.runtime
	.sendMessage({ type: "GET_SETTINGS" })
	.then((resp: unknown) => {
		if (resp && typeof resp === "object") {
			const r = resp as Record<string, unknown>;
			if (typeof r.autoRecord === "boolean") settings.autoRecord = r.autoRecord;
			if (typeof r.autoRecordCountdownSec === "number")
				settings.autoRecordCountdownSec = r.autoRecordCountdownSec;
			if (typeof r.soundEnabled === "boolean")
				settings.soundEnabled = r.soundEnabled;
		}
		maybeShow();
	})
	.catch(() => {
		maybeShow();
	});

// ── SPA navigation detection ──────────────────────────────────────────────────

let lastHref = location.href;
setInterval(() => {
	if (location.href !== lastHref) {
		lastHref = location.href;
		maybeShow();
	}
}, 1000);

window.addEventListener("popstate", maybeShow);
window.addEventListener("hashchange", maybeShow);

let mutationDebounce: ReturnType<typeof setTimeout> | null = null;
const observer = new MutationObserver(() => {
	if (mutationDebounce !== null) clearTimeout(mutationDebounce);
	mutationDebounce = setTimeout(maybeShow, 500);
});
observer.observe(document.body, { childList: true, subtree: true });
