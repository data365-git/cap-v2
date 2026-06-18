# Railway Environment Variables

All variables below must be set in Railway's service environment settings. No sensitive values are committed to the repo.

---

## Required — Core

| Variable | Source | Notes |
|----------|--------|-------|
| `DATABASE_URL` | Railway MySQL plugin (auto-injected) | `mysql://user:pass@host:3306/railway` |
| `NEXTAUTH_SECRET` | Generate: `openssl rand -base64 32` | 32-byte base64 string |
| `NEXTAUTH_URL` | Railway service public URL | `https://cap-v2-web.up.railway.app` |
| `WEB_URL` | Same as `NEXTAUTH_URL` | Must match exactly |
| `NEXT_PUBLIC_WEB_URL` | Same as `NEXTAUTH_URL` | Build-time baked in — set before first deploy |
| `DATABASE_ENCRYPTION_KEY` | Generate: `openssl rand -hex 32` | 32-byte hex; used to encrypt stored AWS keys |
| `INVITE_TOKEN_SECRET` | Generate: `openssl rand -base64 32` | Signs invite tokens |

---

## Required — Storage (Cloudflare R2 or any S3-compatible)

Variable names use the `CAP_AWS_` prefix but work with any S3-compatible provider.

| Variable | Source | Notes |
|----------|--------|-------|
| `CAP_AWS_BUCKET` | R2 bucket name you created | e.g. `cap-videos` |
| `CAP_AWS_REGION` | `auto` for R2; region string for real AWS | e.g. `auto` or `us-east-1` |
| `CAP_AWS_ACCESS_KEY` | R2 API token → Access Key ID | |
| `CAP_AWS_SECRET_KEY` | R2 API token → Secret Access Key | |
| `S3_PUBLIC_ENDPOINT` | R2 public bucket URL | `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_INTERNAL_ENDPOINT` | Same as above (or VPC-local URL if available) | |
| `CAP_AWS_BUCKET_URL` | R2 public URL or CloudFront distribution URL | Optional — used to build public video URLs |
| `S3_PATH_STYLE` | `true` | Required for non-AWS providers (R2, MinIO) |

---

## Required — Admin Bootstrap (seed script)

| Variable | Source | Notes |
|----------|--------|-------|
| `INITIAL_ADMIN_EMAIL` | Your choice | Used by `scripts/seed-admin.ts` on first run |
| `INITIAL_ADMIN_PASSWORD` | Your choice | Bcrypt-hashed on seed; change after first login |

---

## Optional — Google Auth (enables "Sign in with Google")

| Variable | Source |
|----------|--------|
| `GOOGLE_CLIENT_ID` | Google Cloud Console → OAuth 2.0 credentials |
| `GOOGLE_CLIENT_SECRET` | Same |

---

## Optional — AI

| Variable | Source | Notes |
|----------|--------|-------|
| `GEMINI_API_KEY` | Google AI Studio | Primary AI provider for transcription / summaries |
| `ANTHROPIC_API_KEY` | Anthropic Console | AI chat fallback |
| `OPENAI_API_KEY` | OpenAI | Optional AI summaries |

---

## Optional — Settings / Limits

| Variable | Default | Notes |
|----------|---------|-------|
| `CAP_VIDEOS_DEFAULT_PUBLIC` | `true` | Set `false` to make all new videos private by default |
| `CAP_ALLOWED_SIGNUP_DOMAINS` | _(unset = open)_ | Comma-separated list, e.g. `data365.co,data365.online` |
| `STORAGE_QUOTA_BYTES_PER_ORG` | _(unset = unlimited)_ | Bytes, e.g. `107374182400` for 100 GB |
| `CAP_BROWSER_EXTENSION_ORIGIN` | _(unset)_ | Allowed CORS origin for browser extension |
| `CRON_SECRET` | Generate: `openssl rand -hex 32` | Protects `/api/cron/*` endpoints |

---

## Optional — Workflows RPC

Only needed if the background workflow service is deployed separately.

| Variable | Source |
|----------|--------|
| `WORKFLOWS_RPC_URL` | Internal URL of the workflow service |
| `WORKFLOWS_RPC_SECRET` | Shared secret between web and workflow service |

---

## Build-time Variables

These must be set **before the first build** (Railway "Variables" tab, not just runtime).

| Variable | Value | Notes |
|----------|-------|-------|
| `NEXT_PUBLIC_DOCKER_BUILD` | `true` | Switches Next.js into self-hosted Docker mode |
| `NEXT_PUBLIC_WEB_URL` | Same as `WEB_URL` | Baked into the JS bundle at build time |
| `NEXT_PUBLIC_IS_CAP` | _(leave unset)_ | Enables Cap Cloud billing gates — do not set |

---

## NOT Needed (removed or Vercel-only)

These were in the original Cap codebase but have been removed or are Vercel-specific:

| Variable | Reason |
|----------|--------|
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Billing removed |
| `NEXT_PUBLIC_POSTHOG_*`, `POSTHOG_PERSONAL_API_KEY` | Analytics removed |
| `WORKOS_*` | SSO removed |
| `RESEND_API_KEY`, `RESEND_BASE_URL` | Email removed |
| `GROQ_API_KEY` | Superseded by Gemini |
| `MEDIA_SERVER_URL`, `MEDIA_SERVER_WEBHOOK_*` | Media server removed |
| `VERCEL_*`, `VERCEL_ENV` | Vercel-specific; ignored on Railway |
| `DISCORD_FEEDBACK_WEBHOOK_URL`, `DISCORD_LOGS_WEBHOOK_URL` | Cap Cloud only |
| `TINYBIRD_HOST`, `TINYBIRD_TOKEN` | Cap Cloud analytics only |
| `NEXT_PUBLIC_AXIOM_*` | Cap Cloud logging only |
| `CLOUDFRONT_*`, `CAP_CLOUDFRONT_*` | Only needed if using CloudFront CDN |
