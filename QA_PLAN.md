# QA Plan for cap-v2 (@cap/web)
Platform: Web (Next.js 15 + Turbopack) — evidence: `apps/web/next.config.mjs`, `apps/web/package.json` (`next`, `next dev`), Turbo monorepo (`turbo.json`, `pnpm-workspace.yaml`).
Tooling:  Chrome MCP background tab (no Playwright installed — `apps/web/package.json` shows no `@playwright/test`). Run `pnpm web dev` and drive via `mcp__claude-in-chrome__*` (note: `pnpm dev:web` trips Turborepo's interactive `db:push` task in non-TTY contexts; `pnpm web dev` bypasses it).
Hardening tools detected: Biome 2.2 (lint+format), Vitest 3.2 + @vitest/coverage-v8 + @vitest/ui (unit tests), Turbo, PostHog (`posthog-js`, `posthog-node`), OpenTelemetry (`@effect/opentelemetry`, `instrumentation.ts`). No e2e framework, no Sentry/Crashlytics, no Lighthouse config, no `.github/` CI workflows, no axe, no `npm audit` script.
Status: Step 0 ✅ · Step 1 ✅ · Step 2 ✅ · Step 3 ✅ · Step 4 ✅ · Step 5 ⚠️ — P0 hardening fails, run Prompt 4 to fix, then re-run Prompt 5 only on the failed layer.

## The 6 steps
- Step 1 — Map flows + product-logic gaps  → QA_FLOWS.md
- Step 2 — Smoke gate (5-min sanity)        → QA_SMOKE.md
- Step 3 — Full QA execution                → QA_REPORT.md
- Step 4 — Fix all failures, re-verify      → updates QA_REPORT.md
- Step 5 — Production hardening pass        → QA_HARDENING.md

## Non-disruptive rules (every step obeys)
- Never open windows on the user's Mac. No Preview, Finder, browsers.
- No `open` or host-display commands.
- All work on device / simulator / headless browser only.
- Screenshots resized to height ≤1800 before reading.
- Read screenshots via the Read tool only — never pop visually.
- Batch parallel work in single messages.

## Hand-off contract
- Each step reads QA_PLAN.md first to verify it's next in line.
- Each step writes its output file and updates Status.
- Files are the source of truth — chats can change, files persist.
