// Draggable shadow-DOM recording overlay injected into the active tab.
// Uses chrome.storage.onChanged so it follows state without explicit messages.

const HOST_ID = "cap-overlay-host";
if (!document.getElementById(HOST_ID)) {
	// ── Shadow DOM ──────────────────────────────────────────────────────────
	const host = document.createElement("div");
	host.id = HOST_ID;
	document.body.appendChild(host);
	const shadow = host.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = `
:host { all: initial; }

.cap-ov {
  position: fixed;
  bottom: 16px;
  left: 16px;
  z-index: 2147483647;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  pointer-events: all;
  user-select: none;
  cursor: grab;
}
.cap-ov:active { cursor: grabbing; }

@keyframes ov-in {
  from { opacity:0; transform:translateY(8px); }
  to   { opacity:1; transform:translateY(0); }
}
.cap-ov-anim { animation: ov-in .28s cubic-bezier(.2,.8,.4,1) both; }

@keyframes ov-pulse {
  0%,100% { opacity: 1; }
  50%     { opacity: 0.25; }
}
@keyframes ov-spin {
  to { transform: rotate(360deg); }
}

/* pill */
.cap-ov-pill {
  background: rgba(14,18,27,0.96);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 999px;
  padding: 10px 10px 10px 18px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  box-shadow: 0 8px 32px rgba(0,0,0,.5), 0 2px 8px rgba(0,0,0,.3);
}

.cap-ov-left {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-right: 10px;
}

.cap-ov-dot {
  width: 10px; height: 10px;
  border-radius: 50%;
  background: #ef4444;
  flex-shrink: 0;
  animation: ov-pulse 1.5s ease-in-out infinite;
}
.cap-ov-dot--paused { background: #6b7280; animation: none; }
.cap-ov-dot--blue   { background: #3b82f6; animation: none; }

/* spinner for arming state */
.cap-ov-spinner {
  width: 10px; height: 10px;
  border-radius: 50%;
  border: 1.5px solid rgba(249,250,251,0.25);
  border-top-color: #f9fafb;
  flex-shrink: 0;
  animation: ov-spin .75s linear infinite;
}

.cap-ov-elapsed {
  font-size: 16px; font-weight: 600;
  color: #f9fafb;
  font-variant-numeric: tabular-nums;
  letter-spacing: -0.01em;
  min-width: 54px;
}

.cap-ov-divider {
  width: 1px; height: 26px;
  background: rgba(255,255,255,0.12);
  flex-shrink: 0;
  margin: 0 4px;
}

.cap-ov-actions {
  display: flex;
  align-items: center;
  gap: 2px;
}

/* icon ghost button */
.cap-ov-icon-btn {
  width: 38px; height: 38px;
  border-radius: 10px;
  border: none;
  background: transparent;
  color: rgba(249,250,251,0.65);
  display: flex; align-items: center; justify-content: center;
  cursor: pointer;
  transition: background .12s, color .12s;
  flex-shrink: 0;
}
.cap-ov-icon-btn:hover  { background: rgba(255,255,255,0.1); color: #f9fafb; }
.cap-ov-icon-btn:active { background: rgba(255,255,255,0.16); }
.cap-ov-icon-btn:disabled { opacity: .3; cursor: not-allowed; }

/* stop button */
.cap-ov-btn-stop {
  background: #ef4444; color: #fff;
  border: none; border-radius: 10px;
  padding: 7px 15px;
  font-size: 13px; font-weight: 600;
  cursor: pointer; font-family: inherit;
  transition: filter .15s;
  white-space: nowrap;
  display: flex; align-items: center; gap: 6px;
  margin-left: 4px;
}
.cap-ov-btn-stop:hover    { filter: brightness(1.1); }
.cap-ov-btn-stop:disabled { opacity: .4; cursor: not-allowed; }

/* card (complete / error) */
.cap-ov-card {
  background: #fff;
  border-radius: 16px;
  box-shadow: 0 12px 40px rgba(0,0,0,.28);
  padding: 20px;
  width: 300px;
  box-sizing: border-box;
  display: flex; flex-direction: column; gap: 10px;
}
.cap-ov-check { font-size: 26px; color: #16a34a; }
.cap-ov-card-title { font-weight: 700; font-size: 15px; color: #111; }
.cap-ov-url {
  font-size: 11px; color: #555;
  word-break: break-all;
  background: #f3f4f6;
  border-radius: 6px;
  padding: 6px 10px;
  line-height: 1.5;
}
.cap-ov-row { display: flex; gap: 8px; }
.cap-ov-btn-primary {
  flex: 1;
  background: #111827; color: #fff;
  border: none; border-radius: 8px;
  padding: 9px 14px; font-size: 13px; font-weight: 600;
  cursor: pointer; font-family: inherit; transition: filter .15s;
}
.cap-ov-btn-primary:hover { filter: brightness(1.2); }
.cap-ov-btn-secondary {
  flex: 1;
  background: #f3f4f6; color: #374151;
  border: none; border-radius: 8px;
  padding: 9px 14px; font-size: 13px; font-weight: 500;
  cursor: pointer; font-family: inherit; transition: background .15s;
}
.cap-ov-btn-secondary:hover { background: #e5e7eb; }
.cap-ov-btn-dismiss {
  background: none; border: none;
  color: #9ca3af; font-size: 12px;
  cursor: pointer; font-family: inherit;
  text-align: center; text-decoration: underline;
  transition: color .15s;
}
.cap-ov-btn-dismiss:hover { color: #6b7280; }
`;
	shadow.appendChild(style);

	const container = document.createElement("div");
	container.className = "cap-ov cap-ov-anim";
	shadow.appendChild(container);

	// ── Drag ───────────────────────────────────────────────────────────────
	let dragging = false;
	let startX = 0, startY = 0, startLeft = 0, startTop = 0;

	container.addEventListener("mousedown", (e) => {
		if ((e.target as Element).closest("button")) return;
		e.preventDefault();
		const rect = container.getBoundingClientRect();
		startX = e.clientX; startY = e.clientY;
		startLeft = rect.left; startTop = rect.top;
		container.style.bottom = "auto";
		container.style.right  = "auto";
		container.style.left = rect.left + "px";
		container.style.top  = rect.top  + "px";
		dragging = true;
	});
	document.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		container.style.left = (startLeft + e.clientX - startX) + "px";
		container.style.top  = (startTop  + e.clientY - startY) + "px";
	});
	document.addEventListener("mouseup", () => { dragging = false; });

	// ── Timer state (module-level so interval closure always reads current values) ──
	let elapsedIv: ReturnType<typeof setInterval> | null = null;
	let recStart = 0;
	let lastStartedAt = 0;
	let pauseBtnEl: HTMLButtonElement | null = null;

	// Mutable pause tracking — NOT closure-captured, so the interval always reads live values.
	let currentPaused = false;
	let pausedAt = 0;       // wall-clock ms when the current pause began
	let totalPausedMs = 0;  // cumulative paused duration to subtract from elapsed

	function clearElapsed() {
		if (elapsedIv !== null) { clearInterval(elapsedIv); elapsedIv = null; }
	}

	function fmt(ms: number): string {
		const s = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(s / 60), h = Math.floor(m / 60);
		const p = (n: number) => String(n).padStart(2, "0");
		return h > 0 ? `${p(h)}:${p(m % 60)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
	}

	function liveElapsed(): number {
		// Elapsed time the recorder was actually running (excludes paused duration).
		const pauseOffset = currentPaused ? (Date.now() - pausedAt) : 0;
		return Date.now() - recStart - totalPausedMs - pauseOffset;
	}

	function mk(tag: string, cls?: string, text?: string): HTMLElement {
		const el = document.createElement(tag);
		if (cls)  el.className   = cls;
		if (text) el.textContent = text;
		return el;
	}

	function reAnimate() {
		container.classList.remove("cap-ov-anim");
		void (container as HTMLElement).offsetWidth; // force reflow
		container.classList.add("cap-ov-anim");
	}

	// SVG icon strings (Lucide-style, 18×18 viewport)
	const IC = {
		pause:   `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1.5"/><rect x="14" y="4" width="4" height="16" rx="1.5"/></svg>`,
		play:    `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21"/></svg>`,
		restart: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><polyline points="3 3 3 8 8 8"/></svg>`,
		stop:    `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`,
	};

	function setPauseIcon(btn: HTMLButtonElement, paused: boolean) {
		btn.innerHTML = paused ? IC.play : IC.pause;
		btn.title = paused ? "Resume recording" : "Pause recording";
	}

	// ── Phase renderers ────────────────────────────────────────────────────

	function showArming() {
		clearElapsed();
		lastStartedAt = 0;
		pauseBtnEl = null;
		container.innerHTML = "";
		reAnimate();
		const pill = mk("div", "cap-ov-pill");
		const left = mk("div", "cap-ov-left");
		left.append(mk("span", "cap-ov-spinner"), mk("span", "cap-ov-elapsed", "Starting…"));
		pill.appendChild(left);
		container.appendChild(pill);
	}

	function showRecording(startedAt: number, paused: boolean) {
		// ── Update path: same recording, only pause state changed ──────────
		if (lastStartedAt === startedAt && pauseBtnEl) {
			const wasAlreadyPaused = currentPaused;

			if (!wasAlreadyPaused && paused) {
				// Transition → paused: record when the pause started.
				pausedAt = Date.now();
				currentPaused = true;
			} else if (wasAlreadyPaused && !paused) {
				// Transition → resumed: accumulate paused duration.
				if (pausedAt > 0) totalPausedMs += Date.now() - pausedAt;
				pausedAt = 0;
				currentPaused = false;
			}

			setPauseIcon(pauseBtnEl, paused);
			const dot = shadow.querySelector<HTMLElement>(".cap-ov-dot");
			if (dot) dot.className = "cap-ov-dot" + (paused ? " cap-ov-dot--paused" : "");
			return;
		}

		// ── Full render: new recording (or returning to this tab) ──────────
		lastStartedAt = startedAt;
		pauseBtnEl = null;
		currentPaused = paused;
		pausedAt = paused ? Date.now() : 0; // if we join while already paused
		totalPausedMs = 0;
		clearElapsed();
		recStart = startedAt;
		container.innerHTML = "";
		reAnimate();

		const pill = mk("div", "cap-ov-pill");

		// Left: dot + timer
		const left = mk("div", "cap-ov-left");
		const dot  = mk("span", "cap-ov-dot" + (paused ? " cap-ov-dot--paused" : ""));
		const elapsed = mk("span", "cap-ov-elapsed", fmt(liveElapsed()));
		elapsed.id = "cap-ov-elapsed";
		left.append(dot, elapsed);

		const divider = mk("div", "cap-ov-divider");

		// Actions
		const actions = mk("div", "cap-ov-actions");

		// Pause / Resume
		const pauseBtn = document.createElement("button");
		pauseBtn.className = "cap-ov-icon-btn";
		setPauseIcon(pauseBtn, paused);
		pauseBtn.addEventListener("click", () => {
			// Read currentPaused (live) — not a closure over the initial paused value.
			chrome.runtime.sendMessage({ type: currentPaused ? "RESUME" : "PAUSE" }).catch(() => {});
		});

		// Restart
		const restartBtn = document.createElement("button");
		restartBtn.className = "cap-ov-icon-btn";
		restartBtn.innerHTML = IC.restart;
		restartBtn.title = "Restart recording (discard this take)";
		restartBtn.addEventListener("click", () => {
			restartBtn.disabled = true;
			pauseBtn.disabled = true;
			chrome.runtime.sendMessage({ type: "RESTART" }).catch(() => {});
		});

		// Stop
		const stopBtn = document.createElement("button");
		stopBtn.className = "cap-ov-btn-stop";
		stopBtn.innerHTML = IC.stop + "Stop";
		stopBtn.title = "Stop and upload recording";
		stopBtn.addEventListener("click", () => {
			stopBtn.disabled = true;
			pauseBtn.disabled = true;
			restartBtn.disabled = true;
			chrome.runtime.sendMessage({ type: "STOP" }).catch(() => {});
		});

		pauseBtnEl = pauseBtn;
		actions.append(pauseBtn, restartBtn, stopBtn);
		pill.append(left, divider, actions);
		container.appendChild(pill);

		// Interval reads currentPaused/totalPausedMs from module scope — always live.
		elapsedIv = setInterval(() => {
			if (!currentPaused) {
				const el = shadow.getElementById("cap-ov-elapsed");
				if (el) el.textContent = fmt(liveElapsed());
			}
		}, 500);
	}

	function showFinishing() {
		clearElapsed();
		lastStartedAt = 0;
		pauseBtnEl = null;
		currentPaused = false;
		container.innerHTML = "";
		const pill = mk("div", "cap-ov-pill");
		const left = mk("div", "cap-ov-left");
		left.append(mk("span", "cap-ov-dot cap-ov-dot--blue"), mk("span", "cap-ov-elapsed", "Saving…"));
		pill.appendChild(left);
		container.appendChild(pill);
	}

	function showComplete(shareUrl: string) {
		clearElapsed();
		lastStartedAt = 0;
		pauseBtnEl = null;
		currentPaused = false;
		container.innerHTML = "";
		reAnimate();

		const card = mk("div", "cap-ov-card");
		card.append(
			mk("div", "cap-ov-check", "✓"),
			mk("div", "cap-ov-card-title", "Recording saved!"),
			mk("div", "cap-ov-url", shareUrl),
		);

		const row  = mk("div", "cap-ov-row");
		const copy = document.createElement("button");
		copy.className   = "cap-ov-btn-primary";
		copy.textContent = "Copy link";
		copy.addEventListener("click", () => {
			navigator.clipboard.writeText(shareUrl).then(() => {
				copy.textContent = "Copied!";
				setTimeout(() => { copy.textContent = "Copy link"; }, 2000);
			}).catch(() => {});
		});

		const open = document.createElement("button");
		open.className   = "cap-ov-btn-secondary";
		open.textContent = "Open";
		open.addEventListener("click", () => window.open(shareUrl, "_blank"));

		row.append(copy, open);

		const dismiss = document.createElement("button");
		dismiss.className   = "cap-ov-btn-dismiss";
		dismiss.textContent = "Dismiss";
		dismiss.addEventListener("click", () => {
			host.remove();
			chrome.runtime.sendMessage({ type: "CANCEL" }).catch(() => {});
		});

		card.append(row, dismiss);
		container.appendChild(card);
	}

	function showError(reason: string) {
		clearElapsed();
		lastStartedAt = 0;
		pauseBtnEl = null;
		currentPaused = false;
		container.innerHTML = "";
		reAnimate();

		const card = mk("div", "cap-ov-card");
		const btn  = document.createElement("button");
		btn.className   = "cap-ov-btn-secondary";
		btn.textContent = "Dismiss";
		btn.addEventListener("click", () => host.remove());

		card.append(
			mk("div", "cap-ov-card-title", "Recording error"),
			mk("div", "cap-ov-url", reason),
			btn,
		);
		container.appendChild(card);
	}

	type St = { kind: string; shareUrl?: string; reason?: string; startedAt?: number; paused?: boolean };
	function handleState(state: St) {
		switch (state.kind) {
			case "arming":
				// Visible during picker + 3-2-1 countdown — shows "Starting…" spinner pill.
				showArming();
				break;
			case "recording":
				showRecording(state.startedAt ?? Date.now(), state.paused === true);
				break;
			case "uploading":
			case "finishing":
				showFinishing();
				break;
			case "complete":
				if (state.shareUrl) showComplete(state.shareUrl);
				break;
			case "error":
				showError(state.reason ?? "Unknown error");
				break;
			case "idle":
				clearElapsed();
				lastStartedAt = 0;
				pauseBtnEl = null;
				currentPaused = false;
				host.remove();
				break;
		}
	}

	// ── Bootstrap ────────────────────────────────────────────────────────
	chrome.storage.local.get("capExtState", (result) => {
		const state = (result as Record<string, unknown>).capExtState as St | undefined;
		if (state) handleState(state);
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !changes.capExtState?.newValue) return;
		handleState(changes.capExtState.newValue as St);
	});
}
