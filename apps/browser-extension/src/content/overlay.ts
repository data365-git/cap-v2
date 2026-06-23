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
  top: 16px;
  right: 16px;
  z-index: 2147483647;
  font-family: system-ui, -apple-system, sans-serif;
  font-size: 14px;
  pointer-events: all;
  user-select: none;
  cursor: grab;
}
.cap-ov:active { cursor: grabbing; }

@keyframes ov-in {
  from { opacity:0; transform:translateY(-8px); }
  to   { opacity:1; transform:translateY(0); }
}
.cap-ov-anim { animation: ov-in .25s cubic-bezier(.2,.8,.4,1) both; }

@keyframes ov-pulse {
  0%,100% { box-shadow: 0 0 0 0 rgba(239,68,68,.65); }
  55%     { box-shadow: 0 0 0 6px rgba(239,68,68,0); }
}

/* pill */
.cap-ov-pill {
  background: #111827;
  border-radius: 999px;
  padding: 8px 14px;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  box-shadow: 0 4px 16px rgba(0,0,0,.35);
}
.cap-ov-dot {
  width: 8px; height: 8px;
  border-radius: 50%;
  background: #ef4444;
  flex-shrink: 0;
  animation: ov-pulse 1.9s ease-out infinite;
}
.cap-ov-dot--blue { background:#3b82f6; animation:none; }
.cap-ov-elapsed {
  font-size: 13px; font-weight: 600;
  color: #f9fafb;
  font-variant-numeric: tabular-nums;
  min-width: 42px;
}
.cap-ov-btn-stop {
  background: #ef4444; color: #fff;
  border: none; border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: inherit;
  transition: filter .15s;
}
.cap-ov-btn-stop:hover { filter: brightness(1.12); }
.cap-ov-btn-stop:disabled { opacity:.5; cursor:not-allowed; }

/* card (complete / error) */
.cap-ov-card {
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 8px 28px rgba(0,0,0,.22);
  padding: 16px;
  width: 280px;
  box-sizing: border-box;
  display: flex; flex-direction: column; gap: 8px;
}
.cap-ov-check { font-size: 22px; color: #16a34a; }
.cap-ov-card-title { font-weight: 700; font-size: 14px; color: #111; }
.cap-ov-url {
  font-size: 11px; color: #555;
  word-break: break-all;
  background: #f3f4f6;
  border-radius: 4px;
  padding: 4px 8px;
}
.cap-ov-row { display: flex; gap: 6px; }
.cap-ov-btn-primary {
  background: #111827; color: #fff;
  border: none; border-radius: 6px;
  padding: 6px 12px; font-size: 12px; font-weight: 600;
  cursor: pointer; font-family: inherit; transition: filter .15s;
}
.cap-ov-btn-primary:hover { filter: brightness(1.2); }
.cap-ov-btn-secondary {
  background: #f3f4f6; color: #374151;
  border: none; border-radius: 6px;
  padding: 6px 12px; font-size: 12px; font-weight: 500;
  cursor: pointer; font-family: inherit; transition: background .15s;
}
.cap-ov-btn-secondary:hover { background: #e5e7eb; }
.cap-ov-btn-dismiss {
  background: none; border: none;
  color: #9ca3af; font-size: 11px;
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
		container.style.right = "auto";
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

	// ── Helpers ─────────────────────────────────────────────────────────────
	let elapsedIv: ReturnType<typeof setInterval> | null = null;
	let recStart = 0;

	function clearElapsed() {
		if (elapsedIv !== null) { clearInterval(elapsedIv); elapsedIv = null; }
	}

	function fmt(ms: number): string {
		const s = Math.max(0, Math.floor(ms / 1000));
		const m = Math.floor(s / 60), h = Math.floor(m / 60);
		const p = (n: number) => String(n).padStart(2, "0");
		return h > 0 ? `${p(h)}:${p(m % 60)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
	}

	function mk(tag: string, cls?: string, text?: string): HTMLElement {
		const el = document.createElement(tag);
		if (cls)  el.className   = cls;
		if (text) el.textContent = text;
		return el;
	}

	// ── Phase renderers ──────────────────────────────────────────────────────

	function showRecording(startedAt: number) {
		clearElapsed();
		recStart = startedAt;
		container.innerHTML = "";
		container.classList.add("cap-ov-anim");

		const pill = mk("div", "cap-ov-pill");
		const dot  = mk("span", "cap-ov-dot");
		const elapsed = mk("span", "cap-ov-elapsed", fmt(Date.now() - startedAt));
		elapsed.id = "cap-ov-elapsed";
		const stop = document.createElement("button");
		stop.className = "cap-ov-btn-stop";
		stop.textContent = "Stop";
		stop.addEventListener("click", () => {
			stop.disabled = true;
			chrome.runtime.sendMessage({ type: "STOP" }).catch(() => {});
		});

		pill.append(dot, elapsed, stop);
		container.appendChild(pill);

		elapsedIv = setInterval(() => {
			const el = shadow.getElementById("cap-ov-elapsed");
			if (el) el.textContent = fmt(Date.now() - recStart);
		}, 1000);
	}

	function showFinishing() {
		clearElapsed();
		container.innerHTML = "";
		const pill = mk("div", "cap-ov-pill");
		const dot  = mk("span", "cap-ov-dot cap-ov-dot--blue");
		const lbl  = mk("span", "cap-ov-elapsed", "Saving…");
		pill.append(dot, lbl);
		container.appendChild(pill);
	}

	function showComplete(shareUrl: string) {
		clearElapsed();
		container.innerHTML = "";
		container.classList.add("cap-ov-anim");

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
		container.innerHTML = "";
		container.classList.add("cap-ov-anim");

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

	type St = { kind: string; shareUrl?: string; reason?: string; startedAt?: number };
	function handleState(state: St) {
		switch (state.kind) {
			case "recording":  showRecording(state.startedAt ?? Date.now()); break;
			case "uploading":
			case "finishing":  showFinishing(); break;
			case "complete":   if (state.shareUrl) showComplete(state.shareUrl); break;
			case "error":      showError(state.reason ?? "Unknown error"); break;
			case "idle":
				clearElapsed();
				host.remove();
				break;
		}
	}

	// ── Bootstrap ──────────────────────────────────────────────────────────
	chrome.storage.local.get("capExtState", (result) => {
		const state = (result as Record<string, unknown>).capExtState as St | undefined;
		if (state) handleState(state);
	});

	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local" || !changes.capExtState?.newValue) return;
		handleState(changes.capExtState.newValue as St);
	});
}
