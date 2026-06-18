# Cap Browser Extension

Cap browser extension for screen recording and instant sharing.

## Build

```bash
pnpm --filter @cap/browser-extension build
```

## Development

Watch mode with auto-rebuild:

```bash
pnpm --filter @cap/browser-extension watch
```

## Load in Chrome

1. Open `chrome://extensions`
2. Enable **Developer mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `dist/` folder

## Package for Upload

Create a `.zip` file ready for Chrome Web Store submission:

```bash
pnpm --filter @cap/browser-extension package
```

Output: `cap-recorder.zip` (in the monorepo root)

## Consent & Privacy

- **Auto-record is OFF by default.** Users must explicitly enable it in extension settings.
- **Recording always shows a visible countdown** (5 seconds by default, configurable from 3 to 10 seconds) before starting.
- **The user can cancel during the countdown** — a prominent Cancel button is shown on the page itself, not just in the popup.
- **The extension never records without the user's knowledge.** Every recording requires either an explicit click or a visible countdown with cancel option.
- **All data goes to the configured Cap server only** (self-hosted or cap.so). No data is sent to third parties.

## Consent Model

This extension implements a consent-first design with four core guarantees:

1. **Explicit user action required.** The extension never records without an explicit user action (manual record button) or an explicit countdown the user can cancel. Recording is never silent or automatic.

2. **Auto-record is opt-in.** Auto-record on Google Meet is OFF by default. Users must actively flip the setting in extension preferences; it does not enable itself on install or update.

3. **Onboarding surfaces the rules.** On first install, users see a one-screen onboarding overlay stating the above guarantees in plain language. This is a prerequisite to using the extension.

4. **Participant notification is the user's responsibility.** The extension provides the technical capability to record, but the user is responsible for informing Meet participants they are being recorded. The extension cannot enforce this — it is a legal and ethical obligation the user accepts on install.

Future contributors: do not weaken these defaults without explicit product sign-off.
