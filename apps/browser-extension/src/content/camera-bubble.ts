// Camera bubble — injected into the active tab when cameraOverlay is enabled.
// Wraps an iframe pointing to camera-bubble.html (an extension page) so that
// getUserMedia runs in the extension's permission context, not the host page's.
// Drag is handled by forwarding pointer deltas from the iframe via postMessage.

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
			border: "none",
			display: "block",
			background: "transparent",
		});
		iframe.setAttribute("scrolling", "no");
		iframe.setAttribute("frameborder", "0");
		host.appendChild(iframe);

		function handleMessage(e: MessageEvent) {
			if (e.source !== iframe.contentWindow) return;
			const msg = e.data as { type?: string; size?: string; dx?: number; dy?: number };
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

				case "cam-drag": {
					// Convert from bottom/left anchoring to top/left on first drag.
					if (host.style.bottom !== "auto") {
						const rect = host.getBoundingClientRect();
						host.style.top = rect.top + "px";
						host.style.bottom = "auto";
					}
					host.style.left = (parseFloat(host.style.left || "0") + (msg.dx ?? 0)) + "px";
					host.style.top = (parseFloat(host.style.top || "0") + (msg.dy ?? 0)) + "px";
					break;
				}

				case "cam-error":
					cleanup();
					break;
			}
		}

		window.addEventListener("message", handleMessage);

		function cleanup() {
			window.removeEventListener("message", handleMessage);
			const stream = (iframe.contentWindow as Window & { _camStream?: MediaStream } | null)?._camStream;
			if (stream) stream.getTracks().forEach((t) => t.stop());
			host.remove();
		}

		chrome.storage.onChanged.addListener((changes, area) => {
			if (area !== "local") return;
			const newState = changes.capExtState?.newValue as { kind: string } | undefined;
			if (newState?.kind === "idle") cleanup();
			const newSettings = changes.capExtSettings?.newValue as { cameraOverlay?: boolean } | undefined;
			if (newSettings?.cameraOverlay === false) cleanup();
		});
	});
}
