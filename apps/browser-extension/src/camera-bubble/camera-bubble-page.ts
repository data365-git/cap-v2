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

// Turn off
offBtn.addEventListener("click", () => {
	const stream = vid.srcObject as MediaStream | null;
	if (stream) stream.getTracks().forEach((t) => t.stop());
	window.parent.postMessage({ type: "cam-off" }, "*");
});

// Drag — setPointerCapture keeps firing even when pointer leaves iframe bounds.
// Deltas are forwarded to the parent content script which moves the host div.
let dragging = false;

wrap.addEventListener("pointerdown", (e: PointerEvent) => {
	if ((e.target as Element).closest("button, #menu-overlay")) return;
	dragging = true;
	wrap.setPointerCapture(e.pointerId);
	e.preventDefault();
});

wrap.addEventListener("pointermove", (e: PointerEvent) => {
	if (!dragging) return;
	window.parent.postMessage({ type: "cam-drag", dx: e.movementX, dy: e.movementY }, "*");
});

wrap.addEventListener("pointerup", () => { dragging = false; });
wrap.addEventListener("pointercancel", () => { dragging = false; });
