// Camera bubble — injected into the active tab when cameraOverlay is enabled.
// Wraps an iframe pointing to camera-bubble.html (an extension page) so that
// getUserMedia runs in the extension's permission context, not the host page's.
//
// Drag: iframe signals "cam-drag-start" with its clientX/Y; the content script
// creates a full-viewport transparent shield that captures all mousemove/mouseup,
// blocking the underlying page from receiving those events during the drag.
//
// Teardown: content script posts "cam-stop" to iframe; iframe stops all tracks
// and acks with "cam-stopped"; content script then removes the host div.
// Cross-origin security blocks direct access to iframe.contentWindow properties,
// so the message-round-trip is the only reliable way to stop the camera.

const CAM_HOST_ID = "cap-camera-host";
if (!document.getElementById(CAM_HOST_ID)) {
	const SIZES: Record<string, number> = { small: 100, large: 180 };
	let size = 180;

	const host = document.createElement("div");
	host.id = CAM_HOST_ID;
	Object.assign(host.style, {
		position: "fixed",
		bottom: "20px",
		left: "20px",
		width: size + "px",
		height: size + "px",
		zIndex: "2147483646",
		userSelect: "none",
		borderRadius: "50%",
		overflow: "hidden",
	});
	document.body.appendChild(host);

	chrome.storage.local.get("capExtSettings", (result) => {
		const s = (result.capExtSettings as { cameraDeviceId?: string } | undefined) ?? {};
		const deviceId = s.cameraDeviceId ?? "";

		const url = new URL(chrome.runtime.getURL("camera-bubble.html"));
		if (deviceId) url.searchParams.set("d", deviceId);

		const iframe = document.createElement("iframe");
		iframe.src = url.toString();
		iframe.allow = "camera";
		iframe.setAttribute("allowtransparency", "true");
		Object.assign(iframe.style, {
			width: "100%",
			height: "100%",
			border: "0",
			borderRadius: "50%",
			overflow: "hidden",
			display: "block",
			background: "transparent",
			outline: "none",
		});
		iframe.setAttribute("scrolling", "no");
		iframe.setAttribute("frameborder", "0");
		host.appendChild(iframe);

		// ── Message handler ────────────────────────────────────────────────

		function handleMessage(e: MessageEvent) {
			if (e.source !== iframe.contentWindow) return;
			const msg = e.data as {
				type?: string;
				size?: string;
				clientX?: number;
				clientY?: number;
			};
			if (!msg?.type) return;

			switch (msg.type) {
				case "cam-off":
					chrome.runtime.sendMessage({ type: "SAVE_SETTINGS", settings: { cameraOverlay: false } }).catch(() => {});
					cleanup();
					break;

				case "cam-resize": {
					const newSize = SIZES[msg.size ?? "large"] ?? 180;
					size = newSize;
					host.style.width = host.style.height = newSize + "px";
					break;
				}

				case "cam-drag-start": {
					// Convert from bottom/left anchoring to top/left before first drag.
					if (host.style.bottom !== "auto") {
						const r = host.getBoundingClientRect();
						host.style.top = r.top + "px";
						host.style.bottom = "auto";
					}

					// iframe's clientX/Y + host's bounding rect = parent page clientX/Y
					// for the same physical point. This eliminates any first-move jump.
					const hostRect = host.getBoundingClientRect();
					let lastX = hostRect.left + (msg.clientX ?? 0);
					let lastY = hostRect.top + (msg.clientY ?? 0);

					// Full-viewport shield: transparent but intercepts all pointer events,
					// so the underlying page never receives mousemove or mouseup during drag.
					const shield = document.createElement("div");
					Object.assign(shield.style, {
						position: "fixed",
						inset: "0",
						zIndex: "2147483647",
						cursor: "grabbing",
					});
					document.body.appendChild(shield);

					const onMove = (ev: MouseEvent) => {
						const dx = ev.clientX - lastX;
						const dy = ev.clientY - lastY;
						lastX = ev.clientX;
						lastY = ev.clientY;
						host.style.left = (parseFloat(host.style.left || "0") + dx) + "px";
						host.style.top  = (parseFloat(host.style.top  || "0") + dy) + "px";
					};

					const onUp = () => {
						document.removeEventListener("mousemove", onMove);
						document.removeEventListener("mouseup",   onUp);
						shield.remove();
					};

					document.addEventListener("mousemove", onMove);
					document.addEventListener("mouseup",   onUp);
					break;
				}

				case "cam-error":
					cleanup();
					break;
			}
		}

		window.addEventListener("message", handleMessage);

		// ── Teardown ───────────────────────────────────────────────────────
		// The stream lives inside the cross-origin iframe — we can't access it
		// directly. Post "cam-stop" so the iframe stops all tracks itself, then
		// remove the host once we receive the ack. Fallback timeout guards
		// against the iframe being already destroyed before the message arrives.

		let cleanupCalled = false;
		function cleanup() {
			if (cleanupCalled) return;
			cleanupCalled = true;
			window.removeEventListener("message", handleMessage);

			let hostRemoved = false;
			function removeHost() {
				if (hostRemoved) return;
				hostRemoved = true;
				host.remove();
			}

			const onStopped = (e: MessageEvent) => {
				if (e.source === iframe.contentWindow && e.data?.type === "cam-stopped") {
					window.removeEventListener("message", onStopped);
					removeHost();
				}
			};
			window.addEventListener("message", onStopped);

			// Tell the iframe to stop its camera tracks.
			try { iframe.contentWindow?.postMessage({ type: "cam-stop" }, "*"); } catch { /* gone */ }

			// Safety net: remove after 300 ms even if the ack never arrives.
			setTimeout(() => {
				window.removeEventListener("message", onStopped);
				removeHost();
			}, 300);
		}

		// ── State listeners ────────────────────────────────────────────────
		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== "local") return;
			const newState = changes.capExtState?.newValue as { kind: string } | undefined;
			if (newState?.kind === "idle") cleanup();
			const newSettings = changes.capExtSettings?.newValue as { cameraOverlay?: boolean } | undefined;
			if (newSettings?.cameraOverlay === false) cleanup();
		});
	});
}
