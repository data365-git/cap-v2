// Extension page loaded inside an iframe injected by camera-bubble.ts.
// Running from chrome-extension:// origin gives getUserMedia extension-level
// camera permission, bypassing the host page's permission entirely.

const vid = document.getElementById("vid") as HTMLVideoElement;
const menuBtn = document.getElementById("menu-btn") as HTMLButtonElement;
const menuOverlay = document.getElementById("menu-overlay") as HTMLDivElement;
const closeBtn = document.getElementById("close-btn") as HTMLButtonElement;
const offBtn = document.getElementById("off-btn") as HTMLButtonElement;
const errorDiv = document.getElementById("error") as HTMLDivElement;
const wrap = document.getElementById("wrap") as HTMLDivElement;

const deviceId = new URLSearchParams(location.search).get("d") ?? "";

async function startCamera(): Promise<void> {
	try {
		const c: MediaStreamConstraints = deviceId
			? { video: { deviceId: { exact: deviceId } } }
			: { video: { facingMode: "user" } };
		const stream = await navigator.mediaDevices.getUserMedia(c);
		vid.srcObject = stream;
	} catch {
		errorDiv.textContent = "Camera unavailable";
		errorDiv.classList.add("show");
		window.parent.postMessage({ type: "cam-error" }, "*");
	}
}
startCamera();

// Menu toggle
menuBtn.addEventListener("click", (e) => {
	e.stopPropagation();
	menuOverlay.classList.toggle("open");
});
closeBtn.addEventListener("click", () => menuOverlay.classList.remove("open"));

// Size selection
document.querySelectorAll<HTMLButtonElement>(".size-btn").forEach((btn) => {
	btn.addEventListener("click", () => {
		document.querySelectorAll(".size-btn").forEach((b) => b.classList.remove("active"));
		btn.classList.add("active");
		window.parent.postMessage({ type: "cam-resize", size: btn.dataset.size }, "*");
		menuOverlay.classList.remove("open");
	});
});

// Turn off — stop tracks here (have direct access to the stream) then notify parent.
offBtn.addEventListener("click", () => {
	stopTracks();
	window.parent.postMessage({ type: "cam-off" }, "*");
});

function stopTracks(): void {
	const stream = vid.srcObject as MediaStream | null;
	if (stream) stream.getTracks().forEach((t) => t.stop());
	vid.srcObject = null;
}

// Parent teardown: stop tracks and ack so the parent knows it's safe to remove the host.
window.addEventListener("message", (e) => {
	if (e.source !== window.parent) return;
	if (e.data?.type !== "cam-stop") return;
	stopTracks();
	window.parent.postMessage({ type: "cam-stopped" }, "*");
});

// Drag — the parent content script owns all drag logic via a viewport shield.
// The iframe only signals drag-start with the pointer's initial client coordinates
// (relative to the iframe viewport). The parent converts these to page coordinates
// and captures all subsequent mousemove/mouseup on a transparent shield div,
// preventing any underlying page elements from receiving those events.
wrap.addEventListener("pointerdown", (e: PointerEvent) => {
	if ((e.target as Element).closest("button, #menu-overlay")) return;
	e.preventDefault();
	window.parent.postMessage({ type: "cam-drag-start", clientX: e.clientX, clientY: e.clientY }, "*");
});
