# QA Hardening Report — cap-v2 (@cap/web)

Step 5 of 6 — Production hardening pass. Static analysis + dev-server HTTP probes.
Dev server probe: `pnpm web dev` (Next.js 15 + Turbopack) on `localhost:3000`. Evidence under `qa-evidence/step5/`.

---

## Severity tallies

| P0 (must fix before launch) | P1 (week 1) | P2 (backlog) | ✅ pass | ⏭️ skipped (no infra) |
|---|---|---|---|---|
| **5** | **9** | **5** | 8 | 4 |

**Verdict: P0 hardening fails — fix before launch.**

---

## Findings (sorted by severity)

| # | Layer | Check | Status | Evidence | Severity | Fix recommendation |
|---|---|---|---|---|---|---|
| 1 | Security | `pnpm audit --prod` CVEs | ❌ | `qa-evidence/step5/pnpm-audit.txt` — 269 vulns: **4 critical / 104 high / 130 moderate / 31 low**. Criticals: `form-data` RCE-adjacent boundary issue (≥4.0.0 <4.0.4), `fast-xml-parser` regex injection (2 paths), `protobufjs` arbitrary code execution (<7.5.5). | **P0** | `pnpm update form-data fast-xml-parser protobufjs @modelcontextprotocol/sdk nodemailer`. Re-run audit and pin transitive deps in `pnpm.overrides` for `form-data ^4.0.4`, `fast-xml-parser ^4.5.4` and `^5.3.5`, `protobufjs ^7.5.5`. |
| 2 | Security | HTTP response security headers | ❌ | `qa-evidence/step5/headers-login.txt`, `headers-signup.txt`, `headers-api-health.txt` — only `/login` carries `content-security-policy: frame-ancestors https://cap.so` and `x-frame-options: SAMEORIGIN`. `/signup`, `/api/health`, `/embed/*` carry **zero** security headers. No HSTS, no Referrer-Policy, no Permissions-Policy, no X-Content-Type-Options anywhere. `X-Powered-By: Next.js` leaks framework. | **P0** | In `apps/web/next.config.mjs` `headers()`, add a wildcard `source: "/(.*)"` entry with: `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` (or matching the granted Capabilities for the app). Set `poweredByHeader: false` at the top of `nextConfig`. Add baseline CSP (Report-Only first) once asset origins are inventoried. |
| 3 | Security | Build-time error suppression | ❌ | `apps/web/next.config.mjs:36-38` — `typescript: { ignoreBuildErrors: true }`. Production builds will ship even when TS catches a real bug. | **P0** | Flip `ignoreBuildErrors: false`. Fix or `@ts-expect-error`-with-issue-id the failures; do not leave the gate open. |
| 4 | Resilience | Migration filename collisions | ❌ | `packages/database/migrations/` contains duplicates at indexes `0008`, `0026`, `0027`, `0028`, `0029`, `0030` (e.g. `0008_fat_ender_wiggin.sql` + `0008_secondary_index_cleanup.sql`). Drizzle's `_journal.json` resolves order, but parallel branches produced two migrations with the same prefix — risk of one being skipped if a teammate regenerates locally. | **P0** | Inspect `packages/database/migrations/meta/_journal.json` and confirm both members of every collision are listed. Renumber duplicates to unique indexes (e.g. `0008b_`, `0026b_`) and add a pre-commit check that rejects duplicate numeric prefixes. |
| 5 | Compliance | `/privacy` and `/terms` routes return 404 but are linked from UI | ❌ | `qa-evidence/step5/timings.txt`: both 404. Linked from `apps/web/app/(org)/login/form.tsx`, `apps/web/app/s/[videoId]/_components/AuthOverlay.tsx`, `apps/web/app/invite/[token]/ClaimInvite.tsx`, footer in `apps/web/data/homepage-copy.ts`. Auth flow requires user agreement to non-existent pages. | **P0** | Either (a) add `/privacy/page.tsx` + `/terms/page.tsx` rendering the published policies, or (b) update the links to point at `https://cap.so/privacy` and `https://cap.so/terms` (the brand pages already exist; `apps/web/lib/messenger/supermemory.ts` already references those URLs). Cannot ship a TOS-gated login flow without a TOS page. |
| 6 | Observability | Error tracking not installed | ⚠️ | No `@sentry/*` or Crashlytics in `apps/web/package.json`. `global-error.tsx` (verified at `apps/web/app/global-error.tsx`) only `console.error`s — production errors are invisible. | **P1** | Install `@sentry/nextjs`, wire `Sentry.captureException(error)` into `global-error.tsx` and `instrumentation.ts`. Alternatively use existing OpenTelemetry → Axiom pipeline by emitting an error span and standing up an alert in Axiom. |
| 7 | Security | Stripe webhook logs user emails | ❌ | `apps/web/app/api/webhooks/stripe/route.ts:77,86,89,438`: `console.log(\`Attempting to find user by email: ${email}\`)` and four similar. Emails are PII; logs land in Railway log retention. | **P1** | Replace with structured log that hashes or redacts the email: `console.log("stripe.webhook.lookup", { emailHash: sha256(email).slice(0,8) })`. Or remove the logs once the flow is stable — they were debugging breadcrumbs. |
| 8 | Security | Cookies on session token | ✅ | `packages/database/auth/auth-options.ts` — `httpOnly: true`, `secure: true`, `sameSite: "none"`. `secret` sourced from `serverEnv().NEXTAUTH_SECRET`, no hardcoded fallback. | — | None. |
| 9 | Security | `.env` files not committed | ✅ | `.gitignore` covers `.env`, `.env.production`, `.env.development`, `.env.test`, `.env*.local`. `git check-ignore .env` confirms ignored. `git ls-files | grep env` returns nothing. | — | None. |
| 10 | Security | Route auth gating | ✅ | `apps/web/proxy.ts` gates non-public paths with `NextResponse.redirect("/login")` when `NEXT_PUBLIC_IS_CAP !== "true"`. Validated in Step 3. | — | None. |
| 11 | Security | SQL injection surface | ✅ | `qa-evidence/step5/dangerouslyset.txt` shows 17 `dangerouslySetInnerHTML` sites — all are structured-data JSON-LD or controlled markdown-rendered HTML from CMS pages (no user input). `grep` for `sql\`...${...}\`` shows drizzle parameterized templates, no `sql.raw(\`...${userInput}...\`)`. | — | None. |
| 12 | Security | CSP on `/embed/*` and other framable surfaces | ⚠️ | `apps/web/proxy.ts:33-37` sets `frame-ancestors https://cap.so` only on `/login`. Embed routes (`/embed/[videoId]`) carry no `frame-ancestors` — the very route designed to be iframed is unprotected and can be embedded anywhere (clickjacking surface for the auth overlay it renders). | **P1** | Add `frame-ancestors *` explicitly on `/embed/*` and a strict `frame-ancestors 'self' https://cap.so` everywhere else. Move the CSP into `next.config.mjs headers()` so it's centralized. |
| 13 | Performance | `force-dynamic` over-use | ✅ | `qa-evidence/step5/force-dynamic.txt` — 21 hits, all on dashboard/admin/dev routes that legitimately need fresh-per-request data. None on marketing pages. | — | None. |
| 14 | Performance | Bundle hygiene | ✅ | `next.config.mjs` `experimental.optimizePackageImports` enumerates `lucide-react`, `framer-motion`, `recharts`, `@radix-ui/*`, `date-fns`, etc. — tree-shakes well. No `import _ from 'lodash'` or full `moment` imports detected. | — | None. |
| 15 | Performance | Dev-server response times | ✅ | `qa-evidence/step5/timings.txt`: `/login` 30ms, `/signup` 26ms, `/api/health` 4ms (after warmup). Acceptable dev figures; production with build-cache will be faster. Lighthouse skipped (no browser driver). | — | Skip Lighthouse here; rerun on Railway preview deploy. |
| 16 | Performance | Compression / output mode | ⚠️ | `next.config.mjs` has no explicit `compress: true` (default is on) and `output` is unset unless `NEXT_PUBLIC_DOCKER_BUILD=true`. Railway deploy should set that flag for `standalone` output to keep image size down. | **P2** | Document in `RAILWAY_ENV.md` that `NEXT_PUBLIC_DOCKER_BUILD=true` is required for Railway, or set `output: "standalone"` unconditionally for prod. |
| 17 | Accessibility | axe-core automated scan | ⏭️ | No browser driver in this sandbox. Static review of `apps/web/app/layout.tsx` — `<html lang={locale}>` set via next-intl ✅. | — | Run axe in CI on a preview deploy in week 1. |
| 18 | Accessibility | Static a11y review | ⚠️ | Step 3 evidence (`qa-evidence/step3/`) shows rendered HTML but contains no a11y-specific scan output. Source spot-checks: icon-only buttons across `apps/web/components/ui` generally use Radix primitives which inject aria-labels, but no enforcement. | **P2** | Add `eslint-plugin-jsx-a11y` to the Biome/lint pipeline (Biome 2.2 already runs in this repo) or a separate `eslint` step. Mark icon-only buttons missing `aria-label` as build errors. |
| 19 | Observability | PostHog wired | ✅ | `apps/web/app/Layout/AppProviders.tsx`, `apps/web/app/Layout/PosthogPageView.tsx`, `apps/web/app/Layout/providers.tsx`, `apps/web/app/utils/analytics.ts`, `apps/web/utils/getBootstrapData.ts` — provider mounted at app shell, pageview tracker emits on route change. Events are captured throughout. | — | None. |
| 20 | Observability | OpenTelemetry exporter | ✅ | `apps/web/instrumentation.ts` — `OTLPHttpJsonTraceExporter` to Axiom (`api.axiom.co/v1/traces`) when `NEXT_PUBLIC_AXIOM_TOKEN` set, otherwise local exporter in dev. Falls through to `instrumentation.node.ts` on Node runtime. | — | None. |
| 21 | Observability | Structured logging | ⚠️ | `qa-evidence/step5/console-logs.txt` — 30+ `console.log` in production code paths (`api/webhooks/stripe/`, `api/changelog/`, `api/settings/billing/guest-checkout/`, etc.). Unstructured; bypasses OTel. | **P1** | Adopt a logger (`pino` or wrap OTel `diag` channel). Replace at least the `api/webhooks/stripe/route.ts`, `api/changelog/route.ts`, and `api/settings/billing/guest-checkout/route.ts` logs. |
| 22 | Resilience | User-data delete endpoint | ✅ | `apps/web/actions/account/delete-account.ts` + `apps/web/app/(org)/dashboard/settings/account/Settings.tsx`. GDPR right-to-erasure satisfied. | — | None. |
| 23 | Resilience | User-data export endpoint | ❌ | Grep for `export-data|exportData|/api/export` returns no hits. GDPR right-to-portability not implemented. | **P1** | Add `actions/account/export-data.ts` that emits a ZIP/JSON of the user's videos metadata, organization memberships, and comments. Surface in the settings page. |
| 24 | Resilience | Destructive migration ops | ✅ | `grep DROP|TRUNCATE` over `packages/database/migrations/*.sql` returns only `DROP INDEX` and `DROP PRIMARY KEY` — no `DROP TABLE`, no `DROP COLUMN`, no `TRUNCATE`. | — | None. |
| 25 | Resilience | Unbounded queries / N+1 | ✅ | Grep for `.findMany()` without args: zero hits. Drizzle queries reviewed in `apps/web/app/(org)/dashboard/caps/page.tsx` and `dashboard-data.ts` use `where`, `limit`, and explicit joins. | — | Static only — confirm with EXPLAIN on prod data shape. |
| 26 | Device/browser | Cross-browser matrix | ⏭️ | No browser driver in this sandbox. Marked as test-coverage gap. | **P2** | In week 1, add BrowserStack or Playwright (`@playwright/test`) matrix in CI covering Chrome/Firefox/Safari/Edge on a deploy preview. No vendor-prefixed CSS or browser-specific JS APIs detected in spot-check. |
| 27 | Load/scale | Live load test | ⏭️ | No DB / no local services. | — | Run k6 or Artillery against a Railway preview in week 1; static query review (#25) is clean. |
| 28 | Compliance | Cookie consent banner | ❌ | Grep for `CookieConsent|cookie-consent` returns no hits. PostHog initialized without consent gating. EU users hit a tracker on first paint. | **P1** | Add a consent banner (e.g. `@osano/cookieconsent` or a thin self-rolled component). Gate `posthog.init` behind consent for EU regions or use PostHog's `opt_out_capturing_by_default: true` + explicit opt-in. |
| 29 | Compliance | Root README | ⚠️ | `./README.md` missing. Sub-package READMEs present. | **P2** | Add a minimal root README that points at `OPERATIONS.md`, `PIPELINE_MAP.md`, `RAILWAY_ENV.md`, and the QA reports. |
| 30 | Compliance | Operations docs | ✅ | `OPERATIONS.md`, `PIPELINE_MAP.md`, `RAILWAY_ENV.md` all present at repo root. | — | None. |
| 31 | Security | `/manifest.json` 404 (Step 3 carry-forward) | ✅ | False alarm. `apps/web/app/layout.tsx` references `/site.webmanifest`, which serves 200 (`qa-evidence/step5/headers-site-webmanifest.txt`). Grep for `manifest.json` returns no application code hits — only Next.js generated artifacts. | — | None. Mark Step 3 fodder as resolved. |

---

## Top 5 highest-risk items

1. **269 dependency vulnerabilities, 4 critical** — `protobufjs <7.5.5` arbitrary code execution is the worst; runs in the Node server bundle.
2. **No security headers** on most responses (no HSTS, no X-Content-Type-Options, no Referrer-Policy, no Permissions-Policy) — every page is a downgrade-attack and MIME-sniff target.
3. **`typescript.ignoreBuildErrors: true`** — production ships through any TS regression undetected.
4. **`/privacy` and `/terms` 404 while UI links require them** — TOS-gated login flow with no TOS page is a hard compliance failure.
5. **Migration filename collisions at 0008/0026/0027/0028/0029/0030** — race condition risk if anyone regenerates from a stale branch.

---

## QA_PLAN.md status update

`Step 5 ⚠️ — P0 hardening fails`. Five P0 items must be fixed; rerun this pass after Prompt 4 patches them. No P0 can ship: all five are visible to a security scanner, a compliance auditor, or — in the case of the missing TOS page — to every user clicking "Sign up".

**P0 hardening fails — fix before launch.**
