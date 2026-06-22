// Extension page — NOT a service worker.
// chrome.desktopCapture.chooseDesktopMedia works here without a targetTab.
// The resulting streamId is valid for any extension context (offscreen, SW, etc.)
// because no targetTab restriction is set.

async function run(): Promise<void> {
	const result = await new Promise<{ streamId: string | null; error: string | null }>(
		(resolve) => {
			chrome.desktopCapture.chooseDesktopMedia(
				["screen", "window", "tab"],
				(id: string) => {
					const err = chrome.runtime.lastError;
					if (err) {
						resolve({ streamId: null, error: err.message ?? "unknown error" });
					} else if (!id) {
						resolve({ streamId: null, error: "cancelled" });
					} else {
						resolve({ streamId: id, error: null });
					}
				},
			);
		},
	);

	try {
		await chrome.runtime.sendMessage({
			type: "CAPTURE_RESULT",
			streamId: result.streamId,
			error: result.error,
		});
	} catch {
		// SW might already have moved on (e.g. user cancelled via the extension)
	}

	// Close this helper tab
	try {
		const tab = await chrome.tabs.getCurrent();
		if (tab?.id !== undefined) {
			chrome.tabs.remove(tab.id);
			return;
		}
	} catch {
		// fallthrough
	}
	window.close();
}

run().catch(() => {
	chrome.runtime.sendMessage({
		type: "CAPTURE_RESULT",
		streamId: null,
		error: "capture page error",
	}).catch(() => {});
	window.close();
});
