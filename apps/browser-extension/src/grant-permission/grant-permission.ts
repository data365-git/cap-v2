// grant-permission.ts
// Opened as a persistent tab by the popup when the user clicks "Grant access".
// The tab immediately calls getUserMedia so Chrome's permission prompt appears.
// On grant → shows confirmation + auto-closes in 1.5s.
// On denial → shows an error with a close button.

const params = new URLSearchParams(location.search);
const permType = params.get("type") ?? "mic"; // "mic" | "camera"
const isMic = permType !== "camera";

const LABEL = isMic ? "microphone" : "camera";
const CONSTRAINT: MediaStreamConstraints = isMic
	? { audio: true }
	: { video: true };

function logoSVG(): string {
	return `<svg width="40" height="40" viewBox="0 0 40 40" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="40" height="40" fill="#fff" rx="8"/>
    <path fill="#4785FF" d="M20 36c8.837 0 16-7.163 16-16 0-8.836-7.163-16-16-16-8.836 0-16 7.164-16 16 0 8.837 7.164 16 16 16z"/>
    <path fill="#ADC9FF" d="M20 33c7.18 0 13-5.82 13-13S27.18 7 20 7 7 12.82 7 20s5.82 13 13 13z"/>
    <path fill="#fff" d="M20 30c5.523 0 10-4.477 10-10s-4.477-10-10-10-10 4.477-10 10 4.477 10 10 10z"/>
  </svg>`;
}

function deviceIconSVG(): string {
	if (isMic) {
		return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
      xmlns="http://www.w3.org/2000/svg">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
      <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
      <line x1="12" x2="12" y1="19" y2="22"/>
    </svg>`;
	}
	return `<svg width="28" height="28" viewBox="0 0 24 24" fill="none"
    stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
    xmlns="http://www.w3.org/2000/svg">
    <path d="m22 8-6 4 6 4V8z"/>
    <rect width="14" height="12" x="2" y="6" rx="2" ry="2"/>
  </svg>`;
}

async function run(): Promise<void> {
	const root = document.getElementById("root");
	if (!root) return;

	root.innerHTML = `
    <div class="card">
      <div class="logo">${logoSVG()}</div>
      <div class="device-icon">${deviceIconSVG()}</div>
      <h1 class="title">Cap needs ${LABEL} access</h1>
      <p class="sub">Click <strong>Allow</strong> in the browser prompt to enable your ${LABEL}.</p>
      <div class="spinner"></div>
    </div>`;

	try {
		const stream = await navigator.mediaDevices.getUserMedia(CONSTRAINT);
		for (const t of stream.getTracks()) t.stop();

		root.innerHTML = `
      <div class="card">
        <div class="logo">${logoSVG()}</div>
        <div class="check-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12"/>
          </svg>
        </div>
        <h1 class="title success-title">${LABEL.charAt(0).toUpperCase() + LABEL.slice(1)} access granted</h1>
        <p class="sub">You can close this tab. Return to the extension to continue.</p>
      </div>`;

		setTimeout(() => window.close(), 1500);
	} catch {
		root.innerHTML = `
      <div class="card">
        <div class="logo">${logoSVG()}</div>
        <div class="error-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" x2="9" y1="9" y2="15"/>
            <line x1="9" x2="15" y1="9" y2="15"/>
          </svg>
        </div>
        <h1 class="title">Permission denied</h1>
        <p class="sub">Check your browser's site settings and try again. You may need to click the lock icon in the address bar.</p>
        <button class="close-btn" onclick="window.close()">Close tab</button>
      </div>`;
	}
}

run().catch(console.error);
