// Camera preview bubble — injected into the active tab when cameraOverlay is enabled.
// Shows a live circular webcam feed that the user can drag and configure.
// The preview is cosmetic; actual camera compositing happens in capture.ts.
// The bubble bakes in at the bottom-right corner matching the canvas compositor.

const CAM_HOST_ID = "cap-camera-host";
if (!document.getElementById(CAM_HOST_ID)) {
	const host = document.createElement("div");
	host.id = CAM_HOST_ID;
	document.body.appendChild(host);
	const shadow = host.attachShadow({ mode: "closed" });

	const style = document.createElement("style");
	style.textContent = `
:host { all: initial; }

.cam-bubble {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 2147483646;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  user-select: none;
}

@keyframes cam-in {
  from { opacity: 0; transform: scale(0.85); }
  to   { opacity: 1; transform: scale(1); }
}
.cam-bubble { animation: cam-in .25s cubic-bezier(.2,.8,.4,1) both; }

.cam-circle {
  border-radius: 50%;
  overflow: hidden;
  cursor: grab;
  border: 3px solid rgba(255,255,255,0.9);
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
  background: #111;
  flex-shrink: 0;
  position: relative;
}
.cam-circle:active { cursor: grabbing; }

.cam-circle video {
  width: 100%; height: 100%;
  object-fit: cover;
  display: block;
  transform: scaleX(-1); /* mirror effect */
}

/* "…" menu button */
.cam-menu-btn {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: rgba(0,0,0,0.55);
  border: none;
  color: #fff;
  font-size: 13px;
  cursor: pointer;
  display: flex; align-items: center; justify-content: center;
  opacity: 0;
  transition: opacity .15s;
  font-family: system-ui, sans-serif;
  line-height: 1;
  padding: 0;
}
.cam-circle:hover .cam-menu-btn { opacity: 1; }

/* dropdown */
.cam-dropdown {
  position: absolute;
  bottom: 34px;
  right: 6px;
  background: #1f2937;
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 10px;
  padding: 4px;
  min-width: 150px;
  box-shadow: 0 8px 24px rgba(0,0,0,.5);
  display: none;
}
.cam-dropdown.open { display: block; }

.cam-dropdown-item {
  width: 100%;
  background: none;
  border: none;
  color: #f9fafb;
  font-size: 13px;
  font-family: system-ui, sans-serif;
  text-align: left;
  padding: 8px 12px;
  border-radius: 7px;
  cursor: pointer;
  display: flex; align-items: center; gap: 8px;
}
.cam-dropdown-item:hover { background: rgba(255,255,255,0.1); }
.cam-dropdown-item--danger { color: #f87171; }

.cam-size-row {
  display: flex;
  gap: 4px;
  padding: 4px 8px 8px;
}
.cam-size-btn {
  flex: 1;
  background: rgba(255,255,255,0.08);
  border: 1px solid rgba(255,255,255,0.15);
  color: #f9fafb;
  font-size: 12px;
  font-family: system-ui, sans-serif;
  border-radius: 6px;
  padding: 5px 0;
  cursor: pointer;
}
.cam-size-btn.active { background: #3b82f6; border-color: #3b82f6; }
.cam-size-btn:hover:not(.active) { background: rgba(255,255,255,0.15); }

.cam-divider { height: 1px; background: rgba(255,255,255,0.1); margin: 4px 0; }
`;
	shadow.appendChild(style);

	// ── Sizes ─────────────────────────────────────────────────────────────
	const SIZES: Record<string, number> = { small: 100, large: 180 };
	let currentSize: keyof typeof SIZES = "large";

	const bubble = document.createElement("div");
	bubble.className = "cam-bubble";
	shadow.appendChild(bubble);

	const circle = document.createElement("div");
	circle.className = "cam-circle";
	circle.style.width = circle.style.height = SIZES[currentSize] + "px";
	bubble.appendChild(circle);

	const video = document.createElement("video");
	video.autoplay = true;
	video.muted = true;
	video.playsInline = true;
	circle.appendChild(video);

	const menuBtn = document.createElement("button");
	menuBtn.className = "cam-menu-btn";
	menuBtn.textContent = "···";
	menuBtn.title = "Camera options";
	circle.appendChild(menuBtn);

	const dropdown = document.createElement("div");
	dropdown.className = "cam-dropdown";
	circle.appendChild(dropdown);

	// Size row
	const sizeLabel = document.createElement("div");
	sizeLabel.style.cssText = "color:#9ca3af;font-size:11px;font-family:system-ui;padding:6px 12px 2px;";
	sizeLabel.textContent = "Size";
	dropdown.appendChild(sizeLabel);
	const sizeRow = document.createElement("div");
	sizeRow.className = "cam-size-row";

	function makeSizeBtn(key: string, label: string): HTMLButtonElement {
		const b = document.createElement("button");
		b.className = "cam-size-btn" + (key === currentSize ? " active" : "");
		b.textContent = label;
		b.addEventListener("click", () => {
			currentSize = key as keyof typeof SIZES;
			circle.style.width = circle.style.height = SIZES[currentSize] + "px";
			sizeRow.querySelectorAll(".cam-size-btn").forEach((el) => {
				el.classList.toggle("active", el === b);
			});
		});
		return b;
	}
	sizeRow.appendChild(makeSizeBtn("small", "Small"));
	sizeRow.appendChild(makeSizeBtn("large", "Large"));
	dropdown.appendChild(sizeRow);

	const div0 = document.createElement("div");
	div0.className = "cam-divider";
	dropdown.appendChild(div0);

	// Turn off camera item
	const offItem = document.createElement("button");
	offItem.className = "cam-dropdown-item cam-dropdown-item--danger";
	offItem.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M21 21H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3m3-3h6l2 3h4a2 2 0 0 1 2 2v9.34m-7.72-2.06A4 4 0 1 1 8.27 8.27"/></svg>Turn off camera`;
	offItem.addEventListener("click", () => {
		chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { cameraOverlay: false } }).catch(() => {});
		host.remove();
	});
	dropdown.appendChild(offItem);

	menuBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		dropdown.classList.toggle("open");
	});
	document.addEventListener("click", () => dropdown.classList.remove("open"));

	// ── Drag ──────────────────────────────────────────────────────────────
	let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
	circle.addEventListener("mousedown", (e) => {
		if ((e.target as Element).closest("button")) return;
		e.preventDefault();
		const rect = bubble.getBoundingClientRect();
		sx = e.clientX; sy = e.clientY;
		sl = rect.left; st = rect.top;
		bubble.style.right = "auto"; bubble.style.bottom = "auto";
		bubble.style.left = rect.left + "px"; bubble.style.top = rect.top + "px";
		dragging = true;
	});
	document.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		bubble.style.left = (sl + e.clientX - sx) + "px";
		bubble.style.top  = (st + e.clientY - sy) + "px";
	});
	document.addEventListener("mouseup", () => { dragging = false; });

	// ── Camera stream ──────────────────────────────────────────────────────
	async function startCamera(): Promise<void> {
		try {
			const stored = await chrome.storage.local.get("capExtSettings");
			const settings = (stored.capExtSettings as { cameraDeviceId?: string } | undefined) ?? {};
			const deviceId = settings.cameraDeviceId ?? "";
			const constraints: MediaStreamConstraints = deviceId
				? { video: { deviceId: { exact: deviceId } } }
				: { video: true };
			const stream = await navigator.mediaDevices.getUserMedia(constraints);
			video.srcObject = stream;
		} catch {
			// Permission denied or no camera — remove bubble silently
			host.remove();
		}
	}

	startCamera().catch(() => host.remove());

	// ── State listener — remove when idle ─────────────────────────────────
	chrome.storage.onChanged.addListener((changes, area) => {
		if (area !== "local") return;
		const newState = changes.capExtState?.newValue as { kind: string } | undefined;
		if (newState && newState.kind === "idle") {
			// Stop camera tracks
			const stream = video.srcObject as MediaStream | null;
			if (stream) for (const t of stream.getTracks()) t.stop();
			host.remove();
		}
		// If camera setting disabled, also remove
		const newSettings = changes.capExtSettings?.newValue as { cameraOverlay?: boolean } | undefined;
		if (newSettings && newSettings.cameraOverlay === false) {
			const stream = video.srcObject as MediaStream | null;
			if (stream) for (const t of stream.getTracks()) t.stop();
			host.remove();
		}
	});
}
