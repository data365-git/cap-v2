import type { ExtensionSettings, ExtensionState } from "../background/state";

interface PopupData {
	state: ExtensionState;
	settings: ExtensionSettings;
	isMeetTab: boolean;
	meetingId: string | null;
	activeTabId: number | undefined;
}

let timerInterval: ReturnType<typeof setInterval> | null = null;
let micStream: MediaStream | null = null;
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let meterRaf: number | null = null;

function stopTimer(): void {
	if (timerInterval !== null) {
		clearInterval(timerInterval);
		timerInterval = null;
	}
}

function teardownMic(): void {
	if (meterRaf !== null) {
		cancelAnimationFrame(meterRaf);
		meterRaf = null;
	}
	if (analyser) {
		analyser.disconnect();
		analyser = null;
	}
	if (audioCtx) {
		audioCtx.close().catch(() => {});
		audioCtx = null;
	}
	if (micStream) {
		for (const track of micStream.getTracks()) track.stop();
		micStream = null;
	}
}

function el<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	attrs: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
	...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(attrs)) {
		if (key === "className") {
			node.className = value as string;
		} else {
			(node as unknown as Record<string, unknown>)[key] = value;
		}
	}
	for (const child of children) {
		if (typeof child === "string") {
			node.appendChild(document.createTextNode(child));
		} else {
			node.appendChild(child);
		}
	}
	return node;
}

function formatElapsed(ms: number): string {
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":");
}

function sendMsg(msg: Record<string, unknown>): void {
	chrome.runtime.sendMessage(msg, () => {
		if (chrome.runtime.lastError) {
		}
	});
}

function createToggleEl(id: string, checked: boolean): HTMLElement {
	const label = document.createElement("label");
	label.className = "toggle";
	label.htmlFor = id;
	const input = document.createElement("input");
	input.type = "checkbox";
	input.id = id;
	input.checked = checked;
	const track = document.createElement("span");
	track.className = "toggle__track";
	const knob = document.createElement("span");
	knob.className = "toggle__knob";
	track.appendChild(knob);
	label.appendChild(input);
	label.appendChild(track);
	return label;
}

function svgIcon(path: string, size = 16): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
	svg.setAttribute("fill", "none");
	svg.innerHTML = path;
	return svg;
}

function screenIcon(): SVGSVGElement {
	return svgIcon(
		`<rect x="1.5" y="2" width="13" height="9" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
		<path d="M5.5 13.5h5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
		<path d="M8 11v2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
	);
}

function meetIcon(): SVGSVGElement {
	return svgIcon(
		`<rect x="1" y="4" width="9" height="8" rx="1.5" stroke="currentColor" stroke-width="1.5"/>
		<path d="M10 7l4-2.5v7L10 9V7z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>`,
	);
}

function micIconSvg(size = 14): SVGSVGElement {
	return svgIcon(
		`<rect x="5" y="1" width="4" height="7" rx="2" stroke="currentColor" stroke-width="1.4"/>
		<path d="M2.5 7a5.5 5.5 0 0 0 9 0" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>
		<path d="M7 12v2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>`,
		size,
	);
}

function cameraIconSvg(size = 14): SVGSVGElement {
	return svgIcon(
		`<path d="M1.5 5a1 1 0 0 1 1-1H5L6.5 2h1L9 4h2.5a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V5z" stroke="currentColor" stroke-width="1.3"/>
		<circle cx="6.5" cy="7.5" r="1.8" stroke="currentColor" stroke-width="1.3"/>`,
		size,
	);
}

// ── Mic level meter ────────────────────────────────────────────────────────

function buildMicMeter(): { meterEl: HTMLElement; bars: HTMLElement[] } {
	const meterEl = el("div", { className: "mic-meter" });
	const bars: HTMLElement[] = [];
	for (let i = 0; i < 8; i++) {
		const bar = el("span", { className: "mic-bar" });
		meterEl.appendChild(bar);
		bars.push(bar);
	}
	return { meterEl, bars };
}

function startMicMeter(deviceId: string, bars: HTMLElement[]): void {
	teardownMic();
	const constraints: MediaStreamConstraints = deviceId
		? { audio: { deviceId: { exact: deviceId } } }
		: { audio: true };

	navigator.mediaDevices
		.getUserMedia(constraints)
		.then((stream) => {
			micStream = stream;
			audioCtx = new AudioContext();
			analyser = audioCtx.createAnalyser();
			analyser.fftSize = 256;
			audioCtx.createMediaStreamSource(stream).connect(analyser);
			const data = new Uint8Array(analyser.frequencyBinCount);

			function tick(): void {
				if (!analyser) return;
				analyser.getByteFrequencyData(data);
				let sum = 0;
				for (let i = 0; i < data.length; i++) sum += data[i];
				const level = Math.min(1, sum / data.length / 80);
				const lit = Math.round(level * bars.length);
				for (let i = 0; i < bars.length; i++) {
					bars[i].classList.toggle("mic-bar--active", i < lit);
				}
				meterRaf = requestAnimationFrame(tick);
			}

			meterRaf = requestAnimationFrame(tick);
		})
		.catch(() => {
			for (const bar of bars) bar.classList.remove("mic-bar--active");
		});
}

// ── Device select ──────────────────────────────────────────────────────────

async function checkPermission(name: PermissionName): Promise<PermissionState> {
	try {
		const status = await navigator.permissions.query({ name });
		return status.state;
	} catch {
		return "prompt";
	}
}

// Populates a device select without calling getUserMedia.
// Returns "granted" if permission was already granted (devices enumerated),
// "blocked" otherwise. Never shows a permission dialog — that must happen
// in the options page (a persistent tab that doesn't close on focus loss).
async function populateDeviceSelect(
	select: HTMLSelectElement,
	kind: "audioinput" | "videoinput",
	currentDeviceId: string,
): Promise<"granted" | "blocked"> {
	const permName = (
		kind === "audioinput" ? "microphone" : "camera"
	) as PermissionName;
	const permState = await checkPermission(permName);

	if (permState !== "granted") {
		return "blocked";
	}

	// Permission already granted — enumerate devices directly, no getUserMedia.
	const devices = await navigator.mediaDevices.enumerateDevices();
	const filtered = devices.filter((d) => d.kind === kind);

	const defaultOpt = document.createElement("option");
	defaultOpt.value = "";
	defaultOpt.textContent =
		kind === "audioinput" ? "Default microphone" : "Default camera";
	select.appendChild(defaultOpt);

	for (const device of filtered) {
		const label =
			device.label ||
			`${kind === "audioinput" ? "Mic" : "Camera"} ${device.deviceId.slice(0, 6)}`;
		const opt = document.createElement("option");
		opt.value = device.deviceId;
		opt.textContent = label;
		if (device.deviceId === currentDeviceId) opt.selected = true;
		select.appendChild(opt);
	}

	if (!currentDeviceId) select.value = "";
	return "granted";
}

// ── Idle panel ─────────────────────────────────────────────────────────────

function renderIdlePanel(
	root: HTMLElement,
	settings: ExtensionSettings,
	isMeetTab: boolean,
	meetingId: string | null,
	activeTabId: number | undefined,
): void {
	// ── Header ──
	const header = el("div", { className: "hdr" });
	const logoRow = el("div", { className: "hdr-logo" });
	const logoDot = el("span", { className: "hdr-dot" });
	const logoText = el("span", { className: "hdr-text" }, "Cap");
	logoRow.appendChild(logoDot);
	logoRow.appendChild(logoText);

	const gearBtn = el("button", { className: "hdr-gear" }, "⚙");
	gearBtn.title = "Settings";
	gearBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

	header.appendChild(logoRow);
	header.appendChild(gearBtn);
	root.appendChild(header);

	// ── Actions ──
	const actions = el("div", { className: "actions" });

	// Primary: Record Screen
	const screenBtn = el("button", { className: "action-btn action-btn--primary" });
	screenBtn.appendChild(screenIcon());
	screenBtn.appendChild(el("span", {}, "Record Screen"));
	screenBtn.addEventListener("click", () => {
		sendMsg({ type: "START_INSTRUCTION" });
		window.close();
	});
	actions.appendChild(screenBtn);

	// Secondary: Record Meeting
	const meetBtn = el("button", {
		className: `action-btn action-btn--secondary${isMeetTab && meetingId ? "" : " action-btn--off"}`,
	});
	meetBtn.appendChild(meetIcon());
	meetBtn.appendChild(
		el(
			"span",
			{},
			isMeetTab && meetingId
				? `Record Meeting · ${meetingId}`
				: "Record Meeting",
		),
	);
	if (isMeetTab && meetingId) {
		meetBtn.addEventListener("click", () => {
			const msg: Record<string, unknown> = { type: "START_MEET", meetingId };
			if (activeTabId !== undefined) msg.tabId = activeTabId;
			sendMsg(msg);
			window.close();
		});
	} else {
		meetBtn.disabled = true;
	}
	actions.appendChild(meetBtn);

	if (!isMeetTab || !meetingId) {
		const hint = el(
			"p",
			{ className: "meet-hint" },
			"Open a Google Meet to record a meeting",
		);
		actions.appendChild(hint);
	}

	root.appendChild(actions);
	root.appendChild(el("hr", { className: "popup-divider" }));

	// ── Devices ──
	const devicesSection = el("div", { className: "devices" });

	// ── Mic ──
	let micEnabled = settings.micEnabled !== false;
	let micDeviceId = settings.micDeviceId ?? "";

	const { meterEl, bars } = buildMicMeter();

	const micToggleId = "mic-toggle-" + Math.random().toString(36).slice(2);
	const micToggleWrap = createToggleEl(micToggleId, micEnabled);
	const micToggleInput = micToggleWrap.querySelector(
		"input",
	) as HTMLInputElement;

	const micSelect = document.createElement("select");
	micSelect.className = "device-select";
	micSelect.disabled = !micEnabled;

	const micGrantBtn = el("button", { className: "grant-btn" }, "Grant access");
	micGrantBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

	const micRow = el("div", { className: "device-row" });
	const micLabelRow = el("div", { className: "device-label-row" });
	micLabelRow.appendChild(micIconSvg());
	micLabelRow.appendChild(el("span", { className: "device-label" }, "Microphone"));
	micLabelRow.appendChild(micToggleWrap);

	const micControls = el("div", { className: "device-controls" });
	micControls.appendChild(micSelect);
	micControls.appendChild(micGrantBtn);
	micControls.appendChild(meterEl);

	micRow.appendChild(micLabelRow);
	micRow.appendChild(micControls);
	devicesSection.appendChild(micRow);

	function updateMicUI(granted: boolean): void {
		if (!granted) {
			micSelect.style.display = "none";
			meterEl.style.display = "none";
			micToggleWrap.style.display = "none";
			micGrantBtn.style.display = "";
			return;
		}
		micGrantBtn.style.display = "none";
		micSelect.style.display = "";
		meterEl.style.display = "";
		micSelect.disabled = !micEnabled;
		if (micEnabled) {
			meterEl.classList.remove("mic-meter--off");
			startMicMeter(micDeviceId, bars);
		} else {
			meterEl.classList.add("mic-meter--off");
			teardownMic();
			for (const bar of bars) bar.classList.remove("mic-bar--active");
		}
	}

	micToggleInput.addEventListener("change", () => {
		micEnabled = micToggleInput.checked;
		sendMsg({ type: "SAVE_SETTINGS", settings: { micEnabled } });
		updateMicUI(true);
	});

	micSelect.addEventListener("change", () => {
		micDeviceId = micSelect.value;
		sendMsg({ type: "SAVE_SETTINGS", settings: { micDeviceId } });
		if (micEnabled) startMicMeter(micDeviceId, bars);
	});

	populateDeviceSelect(micSelect, "audioinput", micDeviceId)
		.then((result) => updateMicUI(result === "granted"))
		.catch(() => updateMicUI(false));

	// ── Camera ──
	let cameraEnabled = settings.cameraOverlay;
	let cameraDeviceId = settings.cameraDeviceId ?? "";

	const camToggleId = "cam-toggle-" + Math.random().toString(36).slice(2);
	const camToggleWrap = createToggleEl(camToggleId, cameraEnabled);
	const camToggleInput = camToggleWrap.querySelector(
		"input",
	) as HTMLInputElement;

	const camSelect = document.createElement("select");
	camSelect.className = "device-select";
	camSelect.disabled = !cameraEnabled;

	const camGrantBtn = el("button", { className: "grant-btn" }, "Grant access");
	camGrantBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

	const camRow = el("div", { className: "device-row" });
	const camLabelRow = el("div", { className: "device-label-row" });
	camLabelRow.appendChild(cameraIconSvg());
	camLabelRow.appendChild(el("span", { className: "device-label" }, "Camera"));
	camLabelRow.appendChild(camToggleWrap);

	const camControls = el("div", { className: "device-controls" });
	camControls.appendChild(camSelect);
	camControls.appendChild(camGrantBtn);

	camRow.appendChild(camLabelRow);
	camRow.appendChild(camControls);
	devicesSection.appendChild(camRow);

	function updateCamUI(granted: boolean): void {
		if (!granted) {
			camSelect.style.display = "none";
			camToggleWrap.style.display = "none";
			camGrantBtn.style.display = "";
			return;
		}
		camGrantBtn.style.display = "none";
		camSelect.style.display = "";
		camSelect.disabled = !cameraEnabled;
	}

	camToggleInput.addEventListener("change", () => {
		cameraEnabled = camToggleInput.checked;
		camSelect.disabled = !cameraEnabled;
		sendMsg({
			type: "SAVE_SETTINGS",
			settings: { cameraOverlay: cameraEnabled },
		});
	});

	camSelect.addEventListener("change", () => {
		cameraDeviceId = camSelect.value;
		sendMsg({ type: "SAVE_SETTINGS", settings: { cameraDeviceId } });
	});

	populateDeviceSelect(camSelect, "videoinput", cameraDeviceId)
		.then((result) => updateCamUI(result === "granted"))
		.catch(() => updateCamUI(false));

	root.appendChild(devicesSection);
}

// ── Not signed-in ──────────────────────────────────────────────────────────

function renderNotSignedIn(
	root: HTMLElement,
	settings: ExtensionSettings,
): void {
	const wrap = el("div", { className: "auth-wrap" });

	const logoMark = el("div", { className: "auth-logo" });
	const dot = el("span", { className: "auth-dot" });
	logoMark.appendChild(dot);

	const heading = el("h1", { className: "auth-heading" }, "Cap Recorder");
	const sub = el(
		"p",
		{ className: "auth-sub" },
		"Sign in to start recording",
	);

	const signInBtn = el(
		"button",
		{ className: "action-btn action-btn--primary" },
		"Sign in to Cap",
	);
	signInBtn.addEventListener("click", () => {
		const url = `${settings.apiBaseUrl}/extension/callback?extensionId=${chrome.runtime.id}`;
		chrome.tabs.create({ url });
		window.close();
	});

	wrap.appendChild(logoMark);
	wrap.appendChild(heading);
	wrap.appendChild(sub);
	wrap.appendChild(signInBtn);
	root.appendChild(wrap);
}

// ── Recording ──────────────────────────────────────────────────────────────

function renderRecording(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "recording" }>,
): void {
	stopTimer();

	const header = el("div", { className: "rec-header" });
	const dot = el("span", { className: "rec-dot" });
	const label = el("span", { className: "rec-label" }, "Recording");
	header.appendChild(dot);
	header.appendChild(label);

	const timerEl = el(
		"div",
		{ className: "rec-timer" },
		formatElapsed(Date.now() - state.startedAt),
	);

	const modeEl = el(
		"p",
		{ className: "rec-mode" },
		state.mode === "meeting" ? "Meeting" : "Screen",
	);

	const pauseBtn = el(
		"button",
		{ className: "action-btn action-btn--secondary" },
		state.paused ? "Resume" : "Pause",
	);
	pauseBtn.addEventListener("click", () => {
		pauseBtn.disabled = true;
		sendMsg({ type: state.paused ? "RESUME" : "PAUSE" });
		setTimeout(() => {
			pauseBtn.disabled = false;
		}, 200);
	});

	const stopBtn = el(
		"button",
		{ className: "action-btn action-btn--danger" },
		"Stop",
	);
	stopBtn.addEventListener("click", () => {
		stopBtn.disabled = true;
		stopBtn.textContent = "Finishing…";
		pauseBtn.disabled = true;
		sendMsg({ type: "STOP" });
	});

	const btnRow = el("div", { className: "btn-row" });
	btnRow.appendChild(pauseBtn);
	btnRow.appendChild(stopBtn);

	root.appendChild(header);
	root.appendChild(timerEl);
	root.appendChild(modeEl);
	root.appendChild(btnRow);

	const startedAt = state.startedAt;
	timerInterval = setInterval(() => {
		timerEl.textContent = formatElapsed(Date.now() - startedAt);
	}, 1000);
}

// ── Uploading ──────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderUploading(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "uploading" }>,
): void {
	const wrap = el("div", { className: "status-wrap" });
	const pct =
		state.totalBytes > 0
			? Math.round((state.uploadedBytes / state.totalBytes) * 100)
			: 0;
	wrap.appendChild(el("div", { className: "spinner" }));
	wrap.appendChild(el("p", { className: "status-title" }, "Uploading…"));
	wrap.appendChild(
		el(
			"p",
			{ className: "status-sub" },
			`${formatBytes(state.uploadedBytes)} · ${pct}%`,
		),
	);
	const cancelBtn = el("button", { className: "link-btn" }, "Cancel");
	cancelBtn.addEventListener("click", () => sendMsg({ type: "CANCEL" }));
	wrap.appendChild(cancelBtn);
	root.appendChild(wrap);
}

function renderFinishing(root: HTMLElement): void {
	const wrap = el("div", { className: "status-wrap" });
	wrap.appendChild(el("div", { className: "spinner" }));
	wrap.appendChild(el("p", { className: "status-title" }, "Finishing up…"));
	root.appendChild(wrap);
}

// ── Complete ───────────────────────────────────────────────────────────────

function renderComplete(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "complete" }>,
): void {
	const wrap = el("div", { className: "complete-wrap" });

	const check = el("div", { className: "complete-icon" }, "✓");
	const title = el("p", { className: "status-title" }, "Recording saved!");
	const url = el("p", { className: "share-url" }, state.shareUrl);

	const copyBtn = el(
		"button",
		{ className: "action-btn action-btn--primary" },
		"Copy link",
	);
	copyBtn.addEventListener("click", () => {
		navigator.clipboard.writeText(state.shareUrl).then(() => {
			copyBtn.textContent = "Copied!";
			setTimeout(() => (copyBtn.textContent = "Copy link"), 2000);
		});
	});

	const openBtn = el(
		"button",
		{ className: "action-btn action-btn--secondary" },
		"Open",
	);
	openBtn.addEventListener("click", () =>
		chrome.tabs.create({ url: state.shareUrl }),
	);

	const doneBtn = el("button", { className: "link-btn" }, "Done");
	doneBtn.addEventListener("click", () => sendMsg({ type: "CANCEL" }));

	const btnRow = el("div", { className: "btn-row" });
	btnRow.appendChild(copyBtn);
	btnRow.appendChild(openBtn);

	wrap.appendChild(check);
	wrap.appendChild(title);
	wrap.appendChild(url);
	wrap.appendChild(btnRow);
	wrap.appendChild(doneBtn);
	root.appendChild(wrap);
}

// ── Error ──────────────────────────────────────────────────────────────────

function renderError(
	root: HTMLElement,
	state: Extract<ExtensionState, { kind: "error" }>,
): void {
	const wrap = el("div", { className: "error-wrap" });
	wrap.appendChild(el("div", { className: "error-icon" }, "⚠️"));
	wrap.appendChild(el("p", { className: "error-msg" }, state.reason));

	if (state.recoverable) {
		const retryBtn = el(
			"button",
			{ className: "action-btn action-btn--primary" },
			"Retry",
		);
		retryBtn.addEventListener("click", () => sendMsg({ type: "RETRY" }));
		wrap.appendChild(retryBtn);
	}

	const dismissBtn = el(
		"button",
		{ className: "action-btn action-btn--secondary" },
		"Dismiss",
	);
	dismissBtn.addEventListener("click", () => sendMsg({ type: "CANCEL" }));
	wrap.appendChild(dismissBtn);
	root.appendChild(wrap);
}

function renderArming(root: HTMLElement): void {
	const wrap = el("div", { className: "status-wrap" });
	wrap.appendChild(el("div", { className: "spinner" }));
	wrap.appendChild(el("p", { className: "status-title" }, "Starting…"));
	root.appendChild(wrap);
}

// ── Onboarding ─────────────────────────────────────────────────────────────

function renderOnboarding(root: HTMLElement, onDone: () => void): void {
	const wrap = el("div", { className: "onboarding" });

	const dot = el("span", { className: "onboarding-dot" });
	const heading = el("h1", { className: "onboarding-heading" }, "Welcome to Cap");
	const list = el(
		"ul",
		{ className: "onboarding-list" },
		el("li", {}, "Records screen, window, or tab — your choice"),
		el("li", {}, "Visible countdown before every recording starts"),
		el("li", {}, "Google Meet auto-record is off by default"),
	);

	const gotItBtn = el(
		"button",
		{ className: "action-btn action-btn--primary" },
		"Got it",
	);
	gotItBtn.addEventListener("click", () => {
		chrome.storage.local.set({ capExtFirstRun: false }, onDone);
	});

	wrap.appendChild(dot);
	wrap.appendChild(heading);
	wrap.appendChild(list);
	wrap.appendChild(gotItBtn);
	root.appendChild(wrap);
}

// ── Render ─────────────────────────────────────────────────────────────────

function render(data: PopupData): void {
	stopTimer();
	teardownMic();

	const root = document.getElementById("root");
	if (!root) return;
	root.innerHTML = "";

	const popup = el("div", {
		className: "popup popup-content popup-content--entering",
	});

	const { state, settings, isMeetTab, meetingId, activeTabId } = data;
	const signedIn = settings.apiKey.length > 0;

	if (!signedIn) {
		renderNotSignedIn(popup, settings);
	} else if (state.kind === "recording") {
		renderRecording(popup, state);
	} else if (state.kind === "uploading") {
		renderUploading(popup, state);
	} else if (state.kind === "finishing") {
		renderFinishing(popup);
	} else if (state.kind === "complete") {
		renderComplete(popup, state);
	} else if (state.kind === "error") {
		renderError(popup, state);
	} else if (state.kind === "arming") {
		renderArming(popup);
	} else {
		renderIdlePanel(popup, settings, isMeetTab, meetingId, activeTabId);
	}

	root.appendChild(popup);
	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			popup.classList.remove("popup-content--entering");
		});
	});
}

// ── Helpers ────────────────────────────────────────────────────────────────

function getMeetingId(url: string): string | null {
	try {
		const parsed = new URL(url);
		if (!parsed.hostname.endsWith("meet.google.com")) return null;
		const match = /^\/([a-z]+-[a-z]+-[a-z]+)$/i.exec(parsed.pathname);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

const DEFAULT_SETTINGS: ExtensionSettings = {
	apiBaseUrl: "https://web-production-e6fe4.up.railway.app",
	apiKey: "",
	autoRecordOnMeet: false,
	autoRecordCountdownSec: 5,
	micDeviceId: "",
	micEnabled: true,
	captureMode: "picker",
	soundEnabled: true,
	cameraOverlay: false,
	cameraDeviceId: "",
};

async function getSettingsFromStorage(): Promise<ExtensionSettings> {
	const result = await chrome.storage.local.get("capExtSettings");
	const stored =
		(result["capExtSettings"] as Partial<ExtensionSettings> | undefined) ?? {};
	const merged = { ...DEFAULT_SETTINGS, ...stored };
	console.log(
		"[popup] settings — apiKey set:",
		merged.apiKey.length > 0,
		"apiBaseUrl:",
		merged.apiBaseUrl,
	);
	return merged;
}

async function getStateFromSW(): Promise<ExtensionState> {
	return new Promise((resolve) => {
		chrome.runtime.sendMessage({ type: "GET_STATE" }, (response: unknown) => {
			if (
				chrome.runtime.lastError ||
				!response ||
				typeof response !== "object"
			) {
				resolve({ kind: "idle" });
				return;
			}
			resolve(response as ExtensionState);
		});
	});
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
	const [tabs, state, settings] = await Promise.all([
		chrome.tabs.query({ active: true, currentWindow: true }),
		getStateFromSW(),
		getSettingsFromStorage(),
	]);

	const activeTab = tabs[0];
	const tabUrl = activeTab?.url ?? "";
	const meetingId = getMeetingId(tabUrl);
	const isMeetTab = meetingId !== null;

	let currentData: PopupData = {
		state,
		settings,
		isMeetTab,
		meetingId,
		activeTabId: activeTab?.id,
	};

	const root = document.getElementById("root");
	if (!root) return;

	const firstRunResult = await chrome.storage.local.get("capExtFirstRun");
	if (firstRunResult.capExtFirstRun !== false) {
		renderOnboarding(root, () => {
			while (root.firstChild) root.removeChild(root.firstChild);
			render(currentData);
		});
	} else {
		render(currentData);
	}

	chrome.runtime.onMessage.addListener((message: unknown) => {
		if (
			typeof message === "object" &&
			message !== null &&
			(message as Record<string, unknown>).type === "STATE_CHANGED"
		) {
			const newState = (message as Record<string, unknown>)
				.state as ExtensionState;
			currentData = { ...currentData, state: newState };
			render(currentData);
		}
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		if (changes.capExtState?.newValue) {
			const newState = changes.capExtState.newValue as ExtensionState;
			currentData = { ...currentData, state: newState };
			render(currentData);
		}
		if (changes.capExtSettings?.newValue) {
			const newSettings = changes.capExtSettings.newValue as ExtensionSettings;
			currentData = { ...currentData, settings: newSettings };
			render(currentData);
		}
	});
}

window.addEventListener("beforeunload", () => {
	stopTimer();
	teardownMic();
});

init().catch(() => {});
