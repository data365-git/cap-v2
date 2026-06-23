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

// ── Design-system icons ────────────────────────────────────────────────────

// LogoBadge SVG — exact replica of packages/ui/src/components/icons/LogoBadge.tsx
function logoBadgeSVG(size = 24): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg";
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

// Lucide icons — stroke-based, fill="none", stroke-width="2", linecap/linejoin="round"
function lucideSVG(
	paths: string,
	size = 18,
	viewBox = "0 0 24 24",
): SVGSVGElement {
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("width", String(size));
	svg.setAttribute("height", String(size));
	svg.setAttribute("viewBox", viewBox);
	svg.setAttribute("fill", "none");
	svg.setAttribute("stroke", "currentColor");
	svg.setAttribute("stroke-width", "2");
	svg.setAttribute("stroke-linecap", "round");
	svg.setAttribute("stroke-linejoin", "round");
	svg.innerHTML = paths;
	return svg;
}

// lucide Home
function iconHome(size = 18): SVGSVGElement {
	return lucideSVG(
		`<path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
    <polyline points="9 22 9 12 15 12 15 22"/>`,
		size,
	);
}

// lucide Settings (gear)
function iconSettings(size = 18): SVGSVGElement {
	return lucideSVG(
		`<path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
    <circle cx="12" cy="12" r="3"/>`,
		size,
	);
}

// lucide Monitor (screen)
function iconMonitor(size = 16): SVGSVGElement {
	return lucideSVG(
		`<rect width="20" height="14" x="2" y="3" rx="2"/>
    <path d="M8 21h8"/>
    <path d="M12 17v4"/>`,
		size,
	);
}

// lucide Video (camera/meeting)
function iconVideo(size = 16): SVGSVGElement {
	return lucideSVG(
		`<path d="m22 8-6 4 6 4V8z"/>
    <rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>`,
		size,
	);
}

// lucide Mic
function iconMic(size = 14): SVGSVGElement {
	return lucideSVG(
		`<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
    <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
    <line x1="12" x2="12" y1="19" y2="22"/>`,
		size,
	);
}

// lucide Camera
function iconCamera(size = 14): SVGSVGElement {
	return lucideSVG(
		`<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/>
    <circle cx="12" cy="13" r="3"/>`,
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

// Populates a device <select> without calling getUserMedia.
// Only uses permissions.query + enumerateDevices (no permission dialog in popup).
// Returns "granted" if permission was already granted, "blocked" otherwise.
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

// Opens the dedicated grant-permission tab so Chrome's prompt runs in a
// persistent page (not the popup, which closes when focus leaves).
function openGrantTab(type: "mic" | "camera"): void {
	const url = chrome.runtime.getURL(`grant-permission.html?type=${type}`);
	chrome.tabs.create({ url });
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
	logoRow.appendChild(logoBadgeSVG(22));
	logoRow.appendChild(el("span", { className: "hdr-text" }, "Cap"));

	const hdrRight = el("div", { className: "hdr-right" });

	const homeBtn = el("button", { className: "hdr-gear" });
	homeBtn.title = "Open dashboard";
	homeBtn.appendChild(iconHome(18));
	homeBtn.addEventListener("click", () => {
		chrome.tabs.create({ url: `${settings.apiBaseUrl}/dashboard` });
		window.close();
	});

	const gearBtn = el("button", { className: "hdr-gear" });
	gearBtn.title = "Settings";
	gearBtn.appendChild(iconSettings(18));
	gearBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

	hdrRight.appendChild(homeBtn);
	hdrRight.appendChild(gearBtn);
	header.appendChild(logoRow);
	header.appendChild(hdrRight);
	root.appendChild(header);

	// ── Actions ──
	const actions = el("div", { className: "actions" });

	const screenBtn = el("button", { className: "action-btn action-btn--primary" });
	screenBtn.appendChild(iconMonitor(16));
	screenBtn.appendChild(el("span", {}, "Record Screen"));
	screenBtn.addEventListener("click", () => {
		sendMsg({ type: "START_INSTRUCTION" });
		window.close();
	});
	actions.appendChild(screenBtn);

	const meetBtn = el("button", {
		className: `action-btn action-btn--secondary${isMeetTab && meetingId ? "" : " action-btn--off"}`,
	});
	meetBtn.appendChild(iconVideo(16));
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
		actions.appendChild(
			el(
				"p",
				{ className: "meet-hint" },
				"Open a Google Meet to record a meeting",
			),
		);
	}

	root.appendChild(actions);
	root.appendChild(el("hr", { className: "popup-divider" }));

	// ── Devices ──
	const devicesSection = el("div", { className: "devices" });

	// ── Mic ──
	let micEnabled = settings.micEnabled !== false;
	let micDeviceId = settings.micDeviceId ?? "";

	const { meterEl, bars } = buildMicMeter();

	const micToggleId = "mic-t-" + Math.random().toString(36).slice(2);
	const micToggleWrap = createToggleEl(micToggleId, micEnabled);
	const micToggleInput = micToggleWrap.querySelector("input") as HTMLInputElement;

	const micSelect = document.createElement("select");
	micSelect.className = "device-select";
	micSelect.disabled = !micEnabled;

	const micGrantBtn = el("button", { className: "grant-btn" }, "Grant access");
	micGrantBtn.addEventListener("click", () => openGrantTab("mic"));

	const micRow = el("div", { className: "device-row" });
	const micLabelRow = el("div", { className: "device-label-row" });
	micLabelRow.appendChild(iconMic(14));
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
		micToggleWrap.style.display = "";
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
		.then((r) => updateMicUI(r === "granted"))
		.catch(() => updateMicUI(false));

	// ── Camera ──
	let cameraEnabled = settings.cameraOverlay;
	let cameraDeviceId = settings.cameraDeviceId ?? "";

	const camToggleId = "cam-t-" + Math.random().toString(36).slice(2);
	const camToggleWrap = createToggleEl(camToggleId, cameraEnabled);
	const camToggleInput = camToggleWrap.querySelector("input") as HTMLInputElement;

	const camSelect = document.createElement("select");
	camSelect.className = "device-select";
	camSelect.disabled = !cameraEnabled;

	const camGrantBtn = el("button", { className: "grant-btn" }, "Grant access");
	camGrantBtn.addEventListener("click", () => openGrantTab("camera"));

	const camRow = el("div", { className: "device-row" });
	const camLabelRow = el("div", { className: "device-label-row" });
	camLabelRow.appendChild(iconCamera(14));
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
		camToggleWrap.style.display = "";
		camSelect.style.display = "";
		camSelect.disabled = !cameraEnabled;
	}

	camToggleInput.addEventListener("change", () => {
		cameraEnabled = camToggleInput.checked;
		camSelect.disabled = !cameraEnabled;
		sendMsg({ type: "SAVE_SETTINGS", settings: { cameraOverlay: cameraEnabled } });
	});

	camSelect.addEventListener("change", () => {
		cameraDeviceId = camSelect.value;
		sendMsg({ type: "SAVE_SETTINGS", settings: { cameraDeviceId } });
	});

	populateDeviceSelect(camSelect, "videoinput", cameraDeviceId)
		.then((r) => updateCamUI(r === "granted"))
		.catch(() => updateCamUI(false));

	root.appendChild(devicesSection);
}

// ── Not signed-in ──────────────────────────────────────────────────────────

function renderNotSignedIn(
	root: HTMLElement,
	settings: ExtensionSettings,
): void {
	const wrap = el("div", { className: "auth-wrap" });

	const logoWrap = el("div", { className: "auth-logo" });
	logoWrap.appendChild(logoBadgeSVG(48));

	const heading = el("h1", { className: "auth-heading" }, "Cap Recorder");
	const sub = el("p", { className: "auth-sub" }, "Sign in to start recording");

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

	wrap.appendChild(logoWrap);
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
	header.appendChild(el("span", { className: "rec-dot" }));
	header.appendChild(el("span", { className: "rec-label" }, "Recording"));

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
		setTimeout(() => (pauseBtn.disabled = false), 200);
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

	const btnRow = el("div", { className: "btn-row" }, pauseBtn, stopBtn);

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
	const urlEl = el("p", { className: "share-url" }, state.shareUrl);

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

	const btnRow = el("div", { className: "btn-row" }, copyBtn, openBtn);

	wrap.appendChild(check);
	wrap.appendChild(title);
	wrap.appendChild(urlEl);
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
	wrap.appendChild(el("div", { className: "error-icon" }, "⚠"));
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

	const logoWrap = el("div", { className: "onboarding-logo" });
	logoWrap.appendChild(logoBadgeSVG(40));

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

	wrap.appendChild(logoWrap);
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
	return { ...DEFAULT_SETTINGS, ...stored };
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

	let currentData: PopupData = {
		state,
		settings,
		isMeetTab: meetingId !== null,
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
			currentData = {
				...currentData,
				state: changes.capExtState.newValue as ExtensionState,
			};
			render(currentData);
		}
		if (changes.capExtSettings?.newValue) {
			currentData = {
				...currentData,
				settings: changes.capExtSettings.newValue as ExtensionSettings,
			};
			render(currentData);
		}
	});
}

window.addEventListener("beforeunload", () => {
	stopTimer();
	teardownMic();
});

init().catch(() => {});
