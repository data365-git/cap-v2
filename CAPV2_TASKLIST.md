# cap-v2 Production-Readiness Tasklist

**Method:** port fixes forward from `ustoz-github` (cloned at `../ustoz-github`, shares ancestor `f1da4a5`), per-hunk, on a `hardening` branch. Diff each file both directions before editing so cap-v2 features aren't clobbered.

**Deployed state:** `main @ ab4ff92` is live at `web-production-e6fe4.up.railway.app`. Every merge to `main` auto-deploys.

Legend: `[ ]` todo · `port` = take ustoz's hunk · `new` = write fresh · `infra` = Railway/R2 action, not code

---

## Phase 0 — Setup (do first, ~10 min)
- [ ] `0.1` Create `hardening` branch off `main`
- [ ] `0.2` Confirm build works before touching anything: `pnpm install && pnpm build:web` (baseline green)
- [ ] `0.3` Add a real `typecheck` script to `apps/web/package.json` and run it — establish the true error count behind the false-green gate

## Phase S — Security (BLOCKING — exploitable on the live server)
Each fixes a bug verified present in cap-v2. `port` from ustoz unless noted.

- [ ] `S1`  port  `VideosPolicy.ts:54,154` — missing video must DENY (`onNone: () => false`, buildCanView deny). IDOR N012/F028
- [ ] `S2`  port  `api/video/ai/chat/route.ts` — add auth + `canView` + rate limit + 20-msg cap. **Do not take cap-v2's file wholesale — it drops aiBudget.** Merge by hand: keep cap-v2 aiBudget, add ustoz guards. F001/F025/F031
- [ ] `S3`  new   `instrumentation.node.ts:117–124` — delete the `PutBucketPolicy` / `Principal:"*"` block. N002
- [ ] `S4`  port  `instrumentation.ts` — `NEXT_PUBLIC_AXIOM_TOKEN` → `AXIOM_TOKEN`. N001 (⚠ needs rotation — see infra I2)
- [ ] `S5`  port  `actions/admin/access.ts:35` — drop `passwordHash`, return `accessDisabled` bool. N005
- [ ] `S6`  port  ownership guards on `api/video/ai`, `api/video/transcribe/status`, `api/thumbnail`. F022/F023/N004
- [ ] `S7`  port  `S3BucketsRepo.ts` `getByIdForOwnerOrOrganization` + policy re-check on token path in `api/storage/object/route.ts`. N013/N016
- [ ] `S8`  port  `Loom/Url.ts` (new file) + auth/size/timeout guards on `api/tools/loom-download`. N009/N010/N011 (SSRF/DoS)
- [ ] `S9`  port  `authApiKeyHash.ts` (new file) + widen `authApiKeys.id` to `varchar(64)` + migration. N006
- [ ] `S10` port  `auth-options.ts:58` — `debug: false`. F014 (⚠ needs rotation — see infra I2)
- [ ] `S11` port  `login/form.tsx:50` — validate `?next=` (open redirect). F012
- [ ] `S12` port  remainder: N007, N008, N015, N017, N018, N020, F008, F009, F010, F003/F033, F011
- [ ] `S13`  —    full typecheck + build green after security phase; smoke-test login + share page

## Phase C-RW — Railway cost ($9.55/mo → <$1, measured 97.9% idle RAM)
- [ ] `C-RW1` infra  Move MySQL off Railway to external managed (PlanetScale/Aiven free), OR set `performance_schema=OFF` + `innodb_buffer_pool_size=64M`. −$3–5/mo
- [ ] `C-RW2` infra  Enable App Sleeping on `web` (`deploy.sleepApplication: true` in `railway.json`). −$3.58/mo
- [ ] `C-RW3` port   Revert `api/playlist/route.ts` to ustoz's 302-redirect. **Prereq for C-RW2** (proxy blocks sleep). $0 now, −$12/mo at scale
- [ ] `C-RW4` new    Audit client polling (`usePipelineProgress.ts` 3s) so it doesn't defeat sleep

## Phase C-AI — Gemini cost (separate bill; dashboard under-reports ~9×)
- [ ] `C-AI1` new  Fix `packages/utils/src/ai-pricing.ts` — real rates + separate audio-input rate. **Do first — it's the instrument.**
- [ ] `C-AI2` new  Delete `gemini-2.5-pro` fallback; cap retries at 2; abort on repeated 429. Kills 6.6× storm
- [ ] `C-AI3` new  Pass `budgetCapOrgMicros` into `withCostGuard` in `transcribe.ts` (~4 lines)
- [ ] `C-AI4` port Switch to `gemini-3-flash-preview`; single-call ≤90 min; `maxOutputTokens: 65536`; keep 8-min timeout
- [ ] `C-AI5` new  Move transcription off the web request into a real job (pairs with R2)

## Phase R — Reliability
- [ ] `R1` new   Write `/api/cron/recover-stale-ai-jobs` endpoint, THEN port `recover-cron.yml`. (ustoz's cron pings a 404)
- [ ] `R2` new   Stop fire-and-forget workflow launch in `lib/transcribe.ts:117` (strands rows in PROCESSING on crash)
- [ ] `R3` port  Playwright e2e (`e2e/auth.spec.ts`, `e2e/share.spec.ts`) + anti-cheat rule in CLAUDE.md
- [ ] `R4` new   Remove `ignoreBuildErrors: true` (`next.config.mjs:37`); wire CI (cap-v2 has no `.github/`)
- [ ] `R5` port  Reconcile upload retry (F021/F006) by hand against ustoz

## Phase P — Polish (pre-launch)
- [ ] `P1` Strip debug: `Dockerfile:63` BUILD_REV; dead `_enhance*` (`transcribe.ts:1247–1335`); `void userId` (`process-video.ts:158`); `/dev/[videoId]`; `[CAP-*]` logs
- [ ] `P2` `MeetingCostPanel.tsx:12` hardcoded UZS rate → configurable
- [ ] `P3` Fix `audio-extract.ts:401` chunkAudio comment/code mismatch
- [ ] `P4` Move `QA_*.md` + `meet-nudge-harness.html` out of repo root
- [ ] `P5` Extract Uzbek prompts/strings if multi-locale is planned

## Infra actions (not code — decide who runs these)
- [ ] `I1` infra  Pull ustoz's `railway metrics --all --json` to copy its cheaper topology
- [ ] `I2` infra  **Rotate exposed credentials** — Axiom token (public since S4 shipped) + `NEXTAUTH_SECRET` (in logs via S10). Rotating NEXTAUTH_SECRET logs out all sessions.
- [ ] `I3` infra  Audit R2: if the `Principal:"*"` policy ever applied, treat all object URLs as leaked
- [ ] `I4` infra  Pull Google Cloud Gemini billing; compare to `ai_usage_events` sum (gap should be ~9×)
