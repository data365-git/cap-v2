# QA_FLOWS.md — cap-v2 / @cap/web

Generated for Step 1 of the 6-step QA. Source of truth: code only (no runtime).
Scope: web app `apps/web` (Next.js 15 App Router). Browser extension (`apps/browser-extension`) and desktop (Tauri releases endpoint only) are referenced where the web surface depends on them but not exhaustively mapped.

Entities discovered in `packages/database/schema.ts`:
- users, accounts, sessions, verification_tokens, auth_api_keys
- organizations, organization_members, organization_invites
- spaces, space_members, space_videos
- folders
- videos, video_edits, video_edit_history, video_uploads, shared_videos
- comments, notifications
- messenger_conversations, messenger_messages
- s3_buckets, storage_integrations, storage_objects
- audit_log
- (developer-app entities are referenced from `actions/developers/*` and `dashboard/developers/apps/*`; full schema rows live further in `schema.ts` than read window).

Risk legend: **P0** business-critical (auth, video data integrity, payments, sharing/permissions, deletion). **P1** important but non-fatal (settings, secondary admin UI, analytics, notifications). **P2** low-risk (cosmetic, marketing pages, dev tooling).

Gap-type codes for Table C:
A. Missing management action · B. Incomplete CRUD · C. Broken journey / dead end · D. Missing state sync · E. Missing relationship handling · F. Missing permission logic · G. Missing automation control · H. Missing feedback / error handling · I. UI looks interactive but isn't · J. Missing audit / history.

---

## TABLE A — Platform Map

| Area | Screen / Route | Entity | Main user actions | Related screens | Risk |
|---|---|---|---|---|---|
| Auth | `/login` (`(org)/login/page.tsx`) | users, sessions, verification_tokens | Email+password sign-in, OTP request/verify, OAuth provider sign-in (NextAuth) | `/signup`, `/invite/[token]`, `/dashboard` | P0 |
| Auth | `/signup` (`(org)/signup/page.tsx`) | users | Email/password registration; redirect if already signed-in | `/login`, `/onboarding` | P0 |
| Auth | `/api/auth/[...nextauth]` | sessions, accounts, auth_api_keys | NextAuth credential + provider callback; OTP verify | `/login` | P0 |
| Onboarding | `/onboarding` and `/onboarding/[...steps]` | users.onboardingSteps, organizations | Welcome → organization setup → custom domain → invite team → download client (steps stored as JSON) | `/dashboard` | P1 |
| Invites | `/invite/[token]` | organization_invites | Accept/decline invite via token | `/api/invite/accept`, `/api/invite/decline`, `/dashboard` | P0 |
| Dashboard root | `/dashboard` | – | Redirects to `/dashboard/caps` | – | P2 |
| Caps list | `/dashboard/caps` | videos (context=instruction) | List instruction recordings, move-to-folder, share, delete, rename, thumbnail preview | `/dashboard/folder/[id]`, `/s/[videoId]` | P0 |
| Caps record | `/dashboard/caps/record` | videos, video_uploads | Browser-based record / launch desktop client | `/dashboard/caps` | P0 |
| Meetings list | `/dashboard/meetings` | videos (context=meeting) | List meeting recordings; same actions as caps | `/dashboard/folder/[id]` | P0 |
| Folder view | `/dashboard/folder/[id]` | folders, videos, sub-folders | Browse videos in folder; create sub-folder; rename/delete folder; share folder (public toggle) | `/dashboard/caps`, `/c/[id]` | P0 |
| Spaces hub | `/dashboard/spaces/browse` | spaces, space_members | Browse all spaces; create new space | `/dashboard/spaces/[spaceId]` | P1 |
| Space detail | `/dashboard/spaces/[spaceId]` | spaces, space_members, space_videos, folders | List videos & folders inside a space; add/remove videos; manage members; sub-folder browse | `/dashboard/spaces/[spaceId]/folder/[folderId]`, `/c/[id]` | P0 |
| Space folder | `/dashboard/spaces/[spaceId]/folder/[folderId]` | folders, space_videos | Folder-scoped browsing within a space | – | P1 |
| Import landing | `/dashboard/import` | videos, video_uploads | Choose import method (file or Loom) | `/dashboard/import/file`, `/dashboard/import/loom` | P1 |
| Import file | `/dashboard/import/file` | videos, video_uploads, storage_objects | Upload a local file, progress, post-process | `/dashboard/caps` | P0 |
| Import Loom | `/dashboard/import/loom` | videos (Loom imported) | Pull video from Loom; uses `actions/loom.ts` and backend `Loom` package | `/dashboard/caps` | P1 |
| Analytics dashboard | `/dashboard/analytics` | videos, Tinybird analytics | Aggregate view/comment/reaction analytics; per-video drill-in via `actions/analytics/*` and Tinybird | `/dashboard/caps`, `/s/[videoId]` | P1 |
| Notifications inbox | `/dashboard/notifications` | notifications | Paginated list of view/comment/reply/reaction/anon_view events; mark read | `/s/[videoId]`, `/dashboard/settings/notifications` | P1 |
| Notification prefs | `/dashboard/settings/notifications` | users.preferences.notifications | Toggle pause for comments / replies / views / reactions / anon views | – | P1 |
| Account settings | `/dashboard/settings/account` | users, accounts | Profile name, avatar, password, Gemini API key (save/test/delete), delete account, language, dev-mode toggle | – | P0 |
| Storage settings | `/dashboard/settings/storage` | s3_buckets, storage_integrations, storage_objects | Add/edit S3 bucket, add Google Drive integration, default-storage selection, usage stats | `/api/storage/object`, `/api/storage` | P0 |
| Org general settings | `/dashboard/settings/organization` (`GeneralPage`) | organizations | Edit org name, icon, allowedEmailDomain, customDomain (verify), shareable-link branding | members, billing, integrations | P0 |
| Org members | `/dashboard/settings/organization/members` | organization_members, organization_invites | Invite by email/link, list pending invites, update role, remove member, toggle pro-seat, resend invite, remove invite, copy invite URL | – | P0 |
| Org billing | `/dashboard/settings/organization/billing` | organizations, users.stripe* | Manage Stripe subscription (Stripe customer portal redirect), seat quantity, guest-checkout, usage | `/api/settings/billing/*` | P0 |
| Org AI spend | `/dashboard/billing/ai-spend` | (Tinybird/AI ledger) | View per-period AI spend, set budget cap, export CSV | – | P1 |
| Org integrations | `/dashboard/settings/organization/integrations` | storage_integrations | Manage storage integrations (Google Drive) at org level | `/dashboard/settings/storage` | P1 |
| Org preferences | `/dashboard/settings/organization/preferences` | organizations.settings | Toggle disable-summary / captions / chapters / reactions / transcript / comments, default playback speed, AI-generation language, storage/user quotas, enforceQuota | – | P0 |
| Org activity / audit | `/dashboard/settings/organization/activity` | audit_log, users | Read-only audit log feed, filter by actor/action/entityType | – | P1 |
| Roles & perms doc | `/dashboard/settings/organization/permissions` | – | Static table summarising what each role can do | – | P2 |
| Workspace redirect | `/dashboard/settings/workspace` | – | Redirects to `/dashboard/settings/organization` (legacy) | – | P2 |
| Admin access mgmt | `/dashboard/admin/access` | users, auth_api_keys, invites (admin-scoped) | List users, revoke user, reset password, toggle admin flag, create user, generate invite link, revoke invite | – | P0 |
| Developers landing | `/dashboard/developers` | – | Redirects to `/dashboard/developers/apps` | – | P2 |
| Developer apps list | `/dashboard/developers/apps` | (dev apps) | Create app, list apps | `apps/[appId]/*` | P1 |
| Developer app — settings | `/dashboard/developers/apps/[appId]/settings` | dev apps | Edit app metadata; delete app; auto-topup config | – | P1 |
| Developer app — domains | `.../apps/[appId]/domains` | dev app domains | Add/remove allowed domains | – | P1 |
| Developer app — API keys | `.../apps/[appId]/api-keys` | dev API keys | Regenerate keys | – | P1 |
| Developer app — videos | `.../apps/[appId]/videos` | dev-app-scoped videos | List + delete dev-app-owned videos | – | P1 |
| Developer usage | `/dashboard/developers/usage` | developer events ledger | Monthly usage chart | – | P1 |
| Developer credits | `/dashboard/developers/credits` | developer credits ledger | Buy credits via Stripe checkout, auto-topup settings | – | P0 |
| Refer | `/dashboard/refer` | (Dub embed) | Embedded Dub referrals dashboard; gracefully disabled without `DUB_API_KEY` | – | P2 |
| Public collection | `/c/[id]` | folders/spaces with `public=true` | Public-facing card grid; password overlay; CTA URL; pagination | `/s/[videoId]` | P0 |
| Public video page | `/s/[videoId]` | videos, comments, video_edits, transcriptChunks | Watch, comment, react, transcript, summary, chapters, tasks, refined transcript, AI chat (Millie), download, copy share link, password overlay, password auth, OTP overlay, branding overlay | `/s/[videoId]/edit`, `/dashboard/caps` | P0 |
| Video edit | `/s/[videoId]/edit` | video_edits, video_edit_history | Clip/trim editor; save edit spec; history | `/s/[videoId]` | P0 |
| Embed | `/embed/[videoId]` | videos | Iframe-friendly player; password overlay | – | P1 |
| Dev embed redirect | `/dev/[videoId]` | – | Redirects to `/embed/[videoId]?sdk=1` | – | P2 |
| Extension callback | `/extension/callback` | auth_api_keys | Browser-extension OAuth callback / mint API key | – | P1 |
| Messenger inbox | `/messenger` (CAP build only) | messenger_conversations | List conversations, start new conversation (server action), navigate to `[id]` | `/messenger/[id]` | P1 |
| Messenger thread | `/messenger/[id]` (CAP build only) | messenger_conversations, messenger_messages | Chat with Millie (LLM) or human takeover; send message; conversation modes (agent vs human) | – | P1 |
| Admin replace video | `/admin/replace-video` | videos | Admin-only utility to replace a video's source | – | P1 |
| Admin reprocess video | `/admin/reprocess-video` | videos, video_uploads | Admin-only utility to re-trigger processing | – | P1 |
| Health | `/api/health` | – | Liveness probe | – | P2 |
| Status | `/api/status` | – | Service status payload | – | P2 |
| API: video CRUD | `/api/videos/[videoId]`, `/api/video/delete`, `/api/video/comment`, `/api/video/comment/delete`, `/api/video/ai/chat`, `/api/video/transcribe`, `/api/video/transcribe/status`, `/api/video/tasks`, `/api/video/tasks/toggle`, `/api/video/preview`, `/api/video/og`, `/api/video/metadata`, `/api/video/domain-info` | videos, comments, transcriptChunks | Video CRUD; comment CRUD; AI chat streaming; transcription orchestration; task list toggle; OG preview | – | P0 |
| API: videos retry | `/api/videos/[videoId]/retry-transcription`, `/retry-ai` | videos | Force retry of failed transcription / AI generation | – | P1 |
| API: upload | `/api/upload/[...route]` | video_uploads, storage_objects | Multipart upload to S3 / storage integration | – | P0 |
| API: storage | `/api/storage`, `/api/storage/object` | s3_buckets, storage_integrations, storage_objects | Storage object listing / fetch / signed URL | – | P0 |
| API: video proxy | `/api/video-proxy/[videoId]` | videos | Stream proxy for protected sources | – | P0 |
| API: dashboard analytics | `/api/dashboard/analytics`, `/api/analytics/track` | videos (Tinybird) | Aggregate analytics + tracking pixel | – | P1 |
| API: notifications | `/api/notifications/preferences` | users.preferences.notifications | Update notification preferences | – | P1 |
| API: settings billing | `/api/settings/billing/{subscribe,manage,usage,guest-checkout}` | users, organizations | Stripe checkout/portal sessions, usage fetch | – | P0 |
| API: developer | `/api/developer/v1/[...route]`, `/api/developer/sdk/v1/[...route]`, `/api/developer/credits/checkout` | dev apps, credits | Public developer REST API, SDK gateway, credits Stripe checkout | – | P0 |
| API: extension | `/api/extension/mint-key`, `/api/extension/me` | auth_api_keys | Browser-extension auth | – | P1 |
| API: webhooks | `/api/webhooks/media-server`, `/api/webhooks/media-server/progress`, `/api/webhooks/stripe` | videos, video_uploads, users | MediaConvert / Mux media-server callbacks; Stripe events | – | P0 |
| API: cron | `/api/cron/finalize-stale-desktop-segments`, `/api/cron/developer-storage` | video_uploads, storage_objects | Background jobs | – | P1 |
| API: thumbnail / download / changelog | `/api/thumbnail`, `/api/download`, `/api/changelog`, `/api/changelog/status` | videos, releases | Public assets / release feeds | – | P2 |
| API: erpc | `/api/erpc` | (Effect-RPC) | Typed RPC gateway (Video/Folder/Org/User RPCs in `web-domain`) | – | P0 |
| API: tools | `/api/tools/loom-download` | (third-party Loom) | Loom downloader helper | – | P2 |
| API: invite | `/api/invite/accept`, `/api/invite/decline` | organization_invites | Accept / decline org invite | – | P0 |
| Robots / sitemap | `/robots.ts`, `/sitemap.ts` | – | SEO endpoints | – | P2 |
| Install CLI | `/install-cli.{sh,cmd,ps1}` | – | Static installer scripts | – | P2 |

---

## TABLE B — Entity Lifecycle Matrix

For every cell: ✅ exists · ⚠️ partial · ❌ missing. "Manage/Configure" means the ability to preview, test, audit, undo, or disable the entity's effect.

| Entity | Create | Read/List | Edit | Delete/Archive/Disable | Manage/Configure | Missing logic / open questions | Priority |
|---|---|---|---|---|---|---|---|
| User (account) | ✅ `/signup`, admin `createUser` | ✅ in admin/access, members table | ✅ profile name, avatar, password, language | ✅ `actions/account/delete-account.ts`, admin `revokeUser` | ⚠️ revoke vs delete vs soft-suspend not clearly separated; no "disable but keep videos" path | What happens to a revoked user's videos? Are sessions invalidated (`authSessionVersion`)? Cascading delete vs reassign owner unverified. **No GDPR export / data download flow visible.** | P0 |
| Admin flag (isAdmin) | – | ✅ via admin/access table | ✅ `toggleUserAdmin` | ✅ same toggle | ⚠️ no audit log row visible for `isAdmin` flip in the schema's `auditLog.action` enum (unverified); no two-step confirm | Is admin demotion of last admin prevented? Audited? | P0 |
| Session | ✅ NextAuth | ⚠️ no UI to see active sessions | ❌ no rename/label | ⚠️ "log out" present in nav; **no "log out everywhere" / per-device revoke** | ❌ no session list / device manager | `authSessionVersion` column exists but no UI to bump it. Password reset does not appear to force session invalidation (unverified). | P0 |
| Organization | ✅ `NewOrganization` modal in nav | ✅ switcher + settings | ✅ name, icon, allowedEmailDomain, customDomain | ⚠️ `Rpc.make("OrganisationSoftDelete")` exists; **no UI surface for soft-delete found**; `tombstoneAt` column present | ✅ preferences page toggles disable-*, quotas | UI to delete/leave an org is unverified — RPC defined but not wired into Settings UI. What happens to videos when org soft-deleted (cascade vs tombstone)? Can a user leave an org as member? | P0 |
| Org member | ✅ invite (email + link) | ✅ members table | ✅ role change (`update-member-role`), pro-seat toggle | ✅ `remove-member` action | ⚠️ no "transfer ownership" UI surfaced; sole-owner removal guard unverified | Can the owner remove themselves? Does removing a member reassign their videos or orphan them? | P0 |
| Org invite | ✅ email + link (`invite-by-email`, `invite-by-link`, `send-invites`) | ✅ pending invites list | ⚠️ resend exists; no "edit role of pending invite" | ✅ `remove-invite`, `resend-invite` | ⚠️ no visible expiry surfacing in UI (column `expiresAt` exists in schema) | Expired invite handling at `/invite/[token]` unverified. Can an invite be reused after `consumedAt`? | P1 |
| Space | ✅ `create-space` | ✅ spaces nav + `/spaces/browse` | ✅ `update-space`, `upload-space-icon`, `space-settings` | ✅ `delete-space` | ✅ privacy (`Public`/`Private`), internet-facing `public` toggle, password, per-space disable-summary/captions/etc, public-page settings | Does deleting a space cascade to space_videos? Are videos still discoverable via direct link? Members removed silently? | P0 |
| Space member | ✅ add (server action implied) | ✅ list in space settings | ✅ role (`admin`/`member`) | ✅ remove | ⚠️ no audit of who added whom | Sole-admin removal guard unverified. | P1 |
| Space video link (space_videos) | ✅ `spaces/add-videos` | ✅ space detail page | – | ✅ `spaces/remove-videos` | ⚠️ moving between folders inside space; `folderId` on space_videos but UI for in-space folder organisation unverified | If a video is deleted, does space_videos cascade? (FK has `onDelete: "cascade"` ✅) | P1 |
| Folder | ✅ `Rpc.make("FolderCreate")` | ✅ in folder/space view | ✅ `FolderUpdate` (rename, color, parent, public toggle, public-page settings) | ✅ `FolderDelete` | ✅ public toggle + public-page settings | Does deleting a folder cascade-delete sub-folders? Re-parent videos? UI behaviour on delete with children unverified. Color enum only `normal|blue|red|yellow` — no custom. | P0 |
| Public collection (folder/space with `public=true`) | ✅ toggle on folder/space | ✅ `/c/[id]` | ✅ public-page title/subtitle/CTA/layout | ⚠️ toggling off mid-stream — does existing `/c/[id]` URL 404 or 403? | ⚠️ password on collection (`folders.password` not in schema — only `spaces.password`); CTA URL sanitisation via `sanitizeCtaUrl` | Folder-level public password — schema only shows password on spaces; if folder-level public collection lacks password it may be unintentionally open. **Verify.** | P0 |
| Video | ✅ desktop client, web record, file import, Loom import, instant create RPC, dev-API create | ✅ caps + meetings + folders + spaces + public | ✅ rename, move to folder, change context, public/private toggle, password, settings overrides | ✅ `Rpc.make("VideoDelete")`, `/api/video/delete`, `/api/videos/[videoId]` | ✅ `VideoDuplicate`, `videoEdits` (clip spec), `videoEditHistory`, retry-transcription, retry-AI, comments/reactions/transcript settings | Bulk delete from caps list — unverified. Restore-from-trash — no `deletedAt` on videos table → **no trash / recoverability**. Replacing video keeps comments / analytics — unverified. | P0 |
| Video upload progress | ✅ auto on upload | ✅ progress polling, processing phase, message, error | ⚠️ no cancel-upload UI verified | ⚠️ failed uploads stay in `error` phase; retry exists via `retry-processing.ts` but exposure in UI unverified | ⚠️ stale-segment cron exists | Can user resume a half-uploaded multipart upload across browser refresh? Visible to user? | P0 |
| Video edit spec | ✅ in editor | ✅ history table | ✅ replace spec | ❌ no revert-to-history UI surfaced (table exists, route to view it unverified) | ⚠️ "history" stored but unclear if user-browsable | If the edit fails (`resultKey` null), does UI tell the user? | P1 |
| Comment / reaction | ✅ in share page | ✅ comments list in Activity tab | ✅ `actions/videos/edit-comment.ts` | ✅ `/api/video/comment/delete` | ⚠️ moderation by author/owner only — verify member-level moderation. Anonymous commenter identity rules? | Editing comment text — does it preserve thread `parentCommentId`? Audit trail for edit? Soft delete vs hard delete? | P1 |
| Notification | ✅ auto-created on view/comment/reply/reaction/anon_view (deduped via `dedupKey`) | ✅ paginated list | – | ⚠️ mark-read individually + mark-all; **no delete / clear notification UI** | ✅ per-type pause toggles via prefs | Notifications survive video delete (FK `onDelete: cascade`), so list count drops silently — **dashboard count update verification needed**. Pagination "next page" — boundary at 25 items: works on empty page? | P1 |
| Messenger conversation (Cap support) | ✅ `createMessengerConversation` action | ✅ inbox + `[id]` | ⚠️ no rename / archive / star | ❌ no delete-conversation surface | ⚠️ takeover by admin/human (columns exist) — admin UI for takeover not visible in this scan | Search across conversations missing. Mark-as-read missing. **For anon visitors, list-mine vs accidental cross-session leak — verify by `anonymousId` cookie.** | P1 |
| Messenger message | ✅ via chat | ✅ in thread | ❌ no edit | ❌ no delete | ⚠️ admin role exists (`role=admin`) but no admin UI to inject admin messages | – | P2 |
| Storage integration (Google Drive, etc) | ✅ add (org-level + user-level) | ✅ list | ✅ rename / re-auth | ✅ active toggle, status enum | ✅ quota cache, default selection, refresh-lease for token | If a token cannot be refreshed (status=error), are videos that depend on it shown as broken? Re-auth flow surfaced? | P0 |
| S3 bucket (BYO) | ✅ in storage settings | ✅ list | ✅ rotate creds | ✅ `active` flag | ⚠️ "test connection" / preflight — unverified | If a bucket is disabled, existing videos still hit it on playback — fallback path unverified. | P0 |
| Stripe subscription | ✅ `/api/settings/billing/subscribe` checkout | ✅ usage page, AI-spend | ⚠️ "manage" links to Stripe portal — seat quantity update has its own action | ⚠️ cancellation is via Stripe portal (no in-app status surfacing) | ⚠️ pro-seat per-member toggle exists; budget cap on AI spend | What does the app do when subscription lapses mid-session — feature gates flip? Verify `userIsPro` check coverage. | P0 |
| Developer app | ✅ `create-app` | ✅ list | ✅ `update-app`, regenerate keys, add/remove domain, auto-topup | ✅ `delete-app` | ⚠️ "test webhook" / sandbox key — unverified | Deleting an app with active credits ledger — credits forfeit? Refund path? | P1 |
| Developer credits | ✅ buy via Stripe checkout | ✅ on credits page | ⚠️ auto-topup config | ❌ no "refund / clear" path | ⚠️ usage chart | Negative-credit guardrail — verify backend stops `developer/v1` requests at zero. | P0 |
| Audit log row | ✅ implicit on actions | ✅ activity page | ❌ not editable (correct) | ❌ not deletable (correct) | ⚠️ filtering by actor/action/entity exists but unverified for completeness; **coverage of actions auditing IS sparse — only some actions appear to write to `auditLog` (unverified)** | Which actions write to `auditLog` vs which silently mutate? Need explicit enumeration. | P1 |
| Onboarding step | ✅ recorded via `Rpc.make("UserCompleteOnboardingStep")` | ✅ JSON column on user | ⚠️ no manual reset / "redo onboarding" UI | – | ⚠️ skip-step path | What if `onboardingSteps.organizationSetup=true` but org no longer exists (e.g. soft-deleted)? Stuck onboarding loop possible. | P1 |
| AI generation (summary/chapters/transcript/tasks/refined transcript) | ✅ auto on processing complete | ✅ shown in share page | ⚠️ regeneration: retry-AI exists but per-type regenerate UI unverified | ⚠️ org-level disable toggles, per-video override | ✅ generation language, budget cap | If org disables a feature mid-flight, do existing generations still display? Toggle reactivity. | P1 |
| AI chat (Millie / per-video AI chat) | ✅ start (chat popup) | ⚠️ no persisted thread storage visible in share-page AI chat (separate from messenger) | – | – | ⚠️ no clear-history / export | Streaming error recovery — visible from recent commits but not full coverage. | P1 |
| Video share link / password | ✅ default `public=true` | ✅ link copy | ✅ password set/clear | ✅ password clear | ⚠️ "expire link" / one-time link — not present | OTP overlay for guest viewers exists — verify rate-limit & lockout behaviour. | P0 |
| Custom domain | ✅ org settings | ✅ shown in nav with verified indicator | ✅ `update-domain`, `check-domain`, `remove-domain` | ✅ remove | ⚠️ DNS-status polling | If unverified, do videos still resolve at custom domain? Stale verification cache. | P1 |
| Workspace icon / shareable-link branding | ✅ org settings | ✅ on share page | ✅ replace | ✅ remove via API | ✅ `shareableLinkUseOrganizationIcon`, `hideShareableLinkCapLogo` toggles | Cache invalidation on share pages after icon change. | P2 |

---

## TABLE C — Flow Inventory (execution list for Step 3)

Notation:
- **Role** = `guest` (unauthenticated), `member`, `admin` (org admin), `owner` (org owner), `super-admin` (`users.isAdmin=true`).
- Each row is one runnable test. Same Story / Goal text repeats across rows that realise it.
- **Smoke=YES** rows are the 5-min sanity set for Step 2.

| # | Story / Goal | Role | Flow | Trigger | Steps | Expected result + intent | Edge cases | Gap type | Critical? | Smoke? |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | App boots and login screen renders | guest | App loads | navigate to `/` then `/login` | open `/login` | Sees email field + provider buttons, no 5xx, no hydration error | offline, slow network, JS disabled (FOUC) | – | YES | YES |
| 2 | Sign up new user with email/password | guest | Signup → onboarding | `/signup` | enter email + password → submit | Redirect to `/onboarding`, user row created, default org created | duplicate email; weak password; OAuth-collision email; allowed-email-domain mismatch | H | YES | YES |
| 3 | Sign up new user with OAuth (Google) | guest | NextAuth OAuth | click provider on `/login` | OAuth round-trip | User row + accounts row; redirect to dashboard or onboarding | provider cancel; account already linked elsewhere | H | YES | NO |
| 4 | Log in with email/password | guest | Login | `/login` form | submit credentials | Land on `/dashboard/caps` | wrong password lockout/throttle (verify), case-sensitive email, password with unicode | H | YES | YES |
| 5 | Log in via OTP code | guest | OTP login | `/login` → request OTP | request OTP → check email → enter code | Session minted | expired OTP, code reuse, brute-force throttle | H | YES | NO |
| 6 | Log out | member | Sign out | nav top-right | click "Log out" | Session cleared, redirect to `/login` | log-out from one tab leaves other tab live (no broadcast) | I | NO | YES |
| 7 | Forgot/reset password | guest | Password reset | (Unverified entry point in `/login`) | Use "forgot password" link | Reset email sent | No "forgot password" UI surfaced — admin-only reset via `/dashboard/admin/access`. **GAP: end-user password reset missing.** | A | YES | NO |
| 8 | Sign sessions out everywhere | member | Force logout all devices | (none found) | – | – | No UI — `authSessionVersion` column unused by surface | A | NO | NO |
| 9 | Accept invite via link | guest | Invite accept | `/invite/[token]` | open link → claim | Joins org with role from invite; redirect to dashboard | expired invite, already-consumed invite, invite for different email than logged-in, anonymous user must sign up first | C, H | YES | NO |
| 10 | Decline invite | guest | Invite decline | `/invite/[token]` | click decline | Invite status flipped; cannot be reused | decline already-consumed; double-decline | H | NO | NO |
| 11 | Complete onboarding | new user | Onboarding wizard | first login | step through welcome → org setup → custom domain → invite team → download | All steps stored in `users.onboardingSteps`; final redirect to `/dashboard/caps` | skip step; back mid-step; refresh mid-step; org soft-deleted between steps (stuck loop) | C | NO | NO |
| 12 | Onboarding is skippable / resumable | new user | Resume mid-wizard | navigate away then back to `/onboarding` | – | Lands on last incomplete step | direct deep link `/onboarding/4` when step 2 unfinished | C | NO | NO |
| 13 | Switch active organization | member of 2+ orgs | Org switcher | nav popover | pick another org from `Items.tsx` switcher | `users.activeOrganizationId` updates; all dashboard data refetches | switching to a soft-deleted org; switching while a long upload is in progress | D | YES | YES |
| 14 | Create a new organization | member | New org dialog | nav → "+" | submit org name | Org row + owner membership + redirect | duplicate name; empty name; over `inviteQuota` already | H | NO | NO |
| 15 | Soft-delete (close) my organization | owner | Org soft-delete | (RPC `OrganisationSoftDelete` exists, UI unverified) | – | `tombstoneAt` set, members lose access, videos behaviour TBD | – **No UI surface found** | A, I | YES | NO |
| 16 | Leave an organization as member | member | Leave org | (not found) | – | – | **GAP: no "leave org" surface** found | A | YES | NO |
| 17 | Transfer org ownership | owner | Transfer ownership | (not found in actions) | – | – | **GAP: no transfer-ownership surface** | A | YES | NO |
| 18 | Edit org name + icon | admin/owner | Org general settings | `/dashboard/settings/organization` | edit + save | Persisted; nav reflects new name | upload broken image; very long name; emoji name | H | NO | NO |
| 19 | Configure allowed email domain | admin | Org settings | – | set domain | New invites restricted to that domain | conflicting domains across orgs; subdomain matching | E, H | NO | NO |
| 20 | Add custom domain & verify | admin | Custom domain | settings → custom domain | input → check DNS → poll | Verified flag set; share links use it | unverified state: do videos still resolve on the domain? | C, D | NO | NO |
| 21 | Remove custom domain | admin | Custom domain | settings → remove | confirm | Domain cleared; existing share links revert to default host | active embeds on third-party sites break silently | D | NO | NO |
| 22 | Toggle org-level disable flags (summary/captions/chapters/reactions/transcript/comments) | admin | Org preferences | `/dashboard/settings/organization/preferences` | flip toggle | Flag persisted; share pages hide the section | toggle off while live viewer has section open → reactive? | D | YES | NO |
| 23 | Set default playback speed | admin | Org preferences | – | set value | Cap player uses default | sub-1 speeds, very high speeds (>2x) | H | NO | NO |
| 24 | Set AI generation language | admin | Org preferences | – | pick language | New AI generations use that language | mid-flight regeneration | D | NO | NO |
| 25 | Set storage quota and enforce | admin | Org preferences | – | set bytes + enforce | Uploads beyond quota rejected with clear error | quota set below current usage; per-user vs per-org collision | H, F | YES | NO |
| 26 | Set per-user quota | admin | Org preferences | – | set user quota | Uploads rejected per user | – | F | NO | NO |
| 27 | Invite member by email | admin | Members → invite | `/dashboard/settings/organization/members` | email + role → send | Invite row + email sent; appears in pending list | invitee already a member; resending after expiry; rate-limit | H | YES | NO |
| 28 | Invite member by link | admin | Members → link invite | – | toggle/generate link | URL revealable + copyable; uses `organization_invites.token` | invite-quota exhausted; revoking link mid-share | F, H | NO | NO |
| 29 | Resend pending invite | admin | Invites table | – | click resend | Email re-sent (no new row) | resend after expiry: does it extend `expiresAt`? | H | NO | NO |
| 30 | Revoke pending invite | admin | Invites table | – | click revoke | Row marked / removed; URL stops working | already-consumed invite double-revoke | H | NO | NO |
| 31 | Update a member's role | admin | Members table | – | pick role | Role updated; permissions recompute on next request | downgrade self below admin (self-lockout); demoting last owner | F | YES | NO |
| 32 | Remove member from org | admin | Members table | – | confirm remove | Member row deleted; their videos remain owned by them but org-shared rows preserved? **Verify** | sole owner; member with active subscription seat | E, F | YES | NO |
| 33 | Toggle pro-seat for member | owner | Pro-seat toggle | – | click | `hasProSeat` flips; seat-quantity action called on Stripe | over-quota toggling | H | NO | NO |
| 34 | Update seat quantity | owner | Billing | – | adjust seats | Stripe subscription updated | proration confirmation; downgrade below current count | H | NO | NO |
| 35 | Go to Stripe billing portal | owner | Billing → Manage | – | click | Stripe portal opens via signed URL | Stripe account suspended; user in different geo | H | NO | NO |
| 36 | Set AI spend budget | admin | AI Spend page | – | set monthly cap | Cap stored; over-cap behaviour kicks in | exactly-at-cap; cap of 0; currency formatting | G, H | NO | NO |
| 37 | Export AI spend CSV | admin | AI Spend → Export | – | click | CSV downloaded; rows match displayed totals | empty month; very large month | H | NO | NO |
| 38 | View activity log | admin | Activity page | `/settings/organization/activity` | scroll | Rows render; filters work; rows include timestamps | filter no-match empty state; pagination | I | NO | NO |
| 39 | View permissions reference | any logged-in | Static page | `/permissions` | open | Table renders | none | – | NO | NO |
| 40 | Add custom S3 bucket | admin/user | Storage settings | – | enter creds | Bucket row created; videos can target it | invalid creds; region typo; bucket already exists | H | YES | NO |
| 41 | Test S3 bucket connection | admin/user | Storage settings | (button not verified) | – | – | **GAP suspected — no "test connection" found** | A | NO | NO |
| 42 | Disable a bucket | admin/user | Storage settings | toggle `active` | – | New uploads avoid it; existing playback still works (or surfaces fallback) | playback fails silently | E, H | YES | NO |
| 43 | Add Google Drive integration | admin/user | Storage integrations | OAuth | – | Integration row created `active=true` | revoked Google permission; token refresh fail surfacing | H | NO | NO |
| 44 | Re-auth Google Drive after token expiry | user | Storage integrations | status=error | click re-auth | Tokens refreshed; videos resume | concurrent re-auth races (lease columns exist) | H | NO | NO |
| 45 | Choose default storage integration | user | Storage settings | – | pick default | New uploads target that integration | switching while upload in flight | D | NO | NO |
| 46 | Open dashboard caps list | member | Caps list | `/dashboard/caps` | – | List of own + shared instructional caps; counts in sidebar match | empty state; very long names; pagination; deleted videos still in list | D, I | YES | YES |
| 47 | Open dashboard meetings list | member | Meetings list | `/dashboard/meetings` | – | List of meeting recordings | same as #46 | D | YES | YES |
| 48 | Record a cap (web) | member | Record flow | `/dashboard/caps/record` | grant permissions → record → stop | Video appears in caps list with processing state | denied permissions; tab close mid-record; over-quota; storage missing | C, H | YES | NO |
| 49 | Launch desktop client from web | member | Open desktop client | sidebar shortcut | – | Deep-link opens client | client not installed → fallback download page | C, H | NO | NO |
| 50 | Import a local file | member | Import file | `/dashboard/import/file` | drag/drop → upload | Progress bar → processing → ready | unsupported codec; very large file; cancel mid-upload; refresh mid-upload; multipart pause/resume | C, D, H | YES | NO |
| 51 | Import from Loom | member | Loom import | `/dashboard/import/loom` | URL → import | Video appears | invalid URL; Loom rate-limit; private Loom | H | NO | NO |
| 52 | Cancel an in-flight upload | member | Cancel upload | (verify) | abort | Upload row marked / cleaned | partial-multipart cleanup; orphaned S3 multipart upload | A, J | YES | NO |
| 53 | Retry failed upload processing | member | Retry processing | (verify UI button) | click retry | `video_uploads.phase` transitions away from `error` | infinite retry loop guard | H | NO | NO |
| 54 | See processing progress on caps list | member | Live progress | caps list | – | Card updates as phase advances | webhook delayed; stuck in `processing` | D | YES | NO |
| 55 | Rename a video | owner of video | Rename | caps list / share header | – | New name persists; URL/share-link unaffected | empty name; XSS in name; very long name | H | NO | NO |
| 56 | Move a video to a folder | owner | Move | caps list | drag/select | `folderId` updates; counts on folder change | move to folder in another space; permission denied | D, E | YES | NO |
| 57 | Bulk delete videos | owner | Bulk action | (verify multi-select) | – | All selected videos deleted | partial failure; very large selection | A, H | NO | NO |
| 58 | Delete a single video | owner | Delete | share header or list | confirm | Cascades to comments, video_edits, sharedVideos, spaceVideos, notifications; redirect | undo? no trash — **deletion is permanent** | B, A | YES | NO |
| 59 | Duplicate a video | owner | `VideoDuplicate` RPC | (verify UI) | – | New video row with same source | duplicate-name handling; storage usage doubled | – | NO | NO |
| 60 | Set a video to private | owner | Public toggle | settings menu | – | `public=false`; share link returns 403 to anonymous | live viewer mid-watch loses access | F, D | YES | NO |
| 61 | Password-protect a video | owner | Password set | settings menu | – | Anonymous viewer hits password overlay | password change while viewer mid-watch | F | YES | NO |
| 62 | Clear video password | owner | Password clear | – | – | Overlay gone | – | F | NO | NO |
| 63 | Override org disable-flags per video | owner | Video settings | – | toggle | Per-video setting takes precedence | – | – | NO | NO |
| 64 | Watch a public video | guest | Public watch | `/s/[videoId]` | open | Player loads; comments, transcript, summary, chapters, tasks, reactions per org+video settings | OTP overlay if required; password overlay; deleted video → 404; private video → branded auth | C, H | YES | YES |
| 65 | Watch via OTP overlay (guest) | guest | OTP gate | `/s/[videoId]` | enter email → code | One-time access | brute-force throttle; resend OTP | H | YES | NO |
| 66 | Watch a password-protected video | guest | Password gate | – | enter pw | Player unlocks | wrong pw rate-limit; pw rotation | H | NO | NO |
| 67 | Add a text comment | guest/member | Comment | share page | type → submit | Comment posted with timestamp; notification fires to owner | XSS attempt; very long comment; emoji-only; reply to comment | E, H | YES | NO |
| 68 | Add a reaction (emoji comment) | guest/member | React | – | click emoji | Reaction appears | dedup spamming | – | NO | NO |
| 69 | Reply to a comment | guest/member | Threaded reply | comments tab | – | `parentCommentId` set; nested rendering | depth limit; reply to deleted comment | E | NO | NO |
| 70 | Edit own comment | member | Edit comment | comment menu | – | Content updates; updated_at bumps | edit after replies exist; audit trail (E) | E, J | NO | NO |
| 71 | Delete own comment | member | Delete | – | – | Cascades to replies (FK cascade) | – | – | NO | NO |
| 72 | View transcript | viewer | Transcript panel | share page | – | Time-aligned chunks; jump to time | no audio source → SKIPPED status surfacing | H, I | YES | NO |
| 73 | View AI summary | viewer | Summary panel | share page | – | Summary renders; if org-disabled, panel hidden | mid-generation state ("loading…") | I, H | YES | NO |
| 74 | View chapters | viewer | Chapters | share page | – | Click to jump; if disabled hidden | – | I | NO | NO |
| 75 | View tasks | viewer | Tasks panel | share page | – | Tasks list; toggle complete (`/api/video/tasks/toggle`) | permission to toggle (anonymous toggling?) | F | NO | NO |
| 76 | Refined transcript | viewer | Refined transcript | share page | – | Cleaned transcript renders | regenerate UI surface | A | NO | NO |
| 77 | Meeting cost panel | viewer | Meeting cost | share page (meeting context) | – | Cost calculator renders | non-meeting video showing it accidentally | I | NO | NO |
| 78 | Open AI chat (Millie) on a video | viewer | AI chat | floating AI button | – | Chat popup; streamed answer with citations into video | mid-stream error; abort streaming (recent commit references this); cost gating; offline | C, H | YES | NO |
| 79 | AI chat stays available after error | viewer | Recovery | break network mid-stream | – | UI shows error, can retry | leaks partial messages on retry | H, D | NO | NO |
| 80 | Download a video | owner / permitted viewer | Download | share header | – | Signed URL → file downloads | huge file; resume; private fallback | H | NO | NO |
| 81 | Copy share link | owner | Copy link | share header | – | Clipboard receives correct URL (custom domain if configured) | feature-detect clipboard API; HTTP context fallback | I, H | NO | NO |
| 82 | Edit a video (clip/trim) | owner | Editor | `/s/[videoId]/edit` | trim → save | `video_edits` row updated; rendered output replaces source | partial render; render fails (resultKey null); concurrent edits | C, H | YES | NO |
| 83 | Browse video edit history | owner | History list | (verify UI in editor) | – | Past edit specs listed | revert action — unverified | A | NO | NO |
| 84 | Revert to a past edit | owner | Revert | (verify) | – | – | **GAP: revert UI not surfaced** | A | NO | NO |
| 85 | Embed a video on a third-party site | owner | Embed link | share header | – | `<iframe src="/embed/[id]">` works; respects private/password | embed on HTTPS site loading HTTP video; CSP; sandbox attr | H | NO | NO |
| 86 | Create a folder | member | New folder | caps list / folder view | – | Folder row; nav refreshes | duplicate name; emoji name; sub-folder under deleted parent | E, H | NO | NO |
| 87 | Rename a folder | owner | Folder rename | – | – | Persists | – | – | NO | NO |
| 88 | Re-color a folder | owner | Folder color | – | – | Updates; only `normal/blue/red/yellow` allowed | trying to set a custom hex | – | NO | NO |
| 89 | Move a folder | owner | Folder reparent | – | – | `parentId` updates | circular reparent (folder under its own child); cross-org reparent | E | NO | NO |
| 90 | Delete a folder | owner | Folder delete | – | – | Sub-folders + videos handling: cascade? re-parent? **Unverified — must test** | non-empty delete confirm | B, E | YES | NO |
| 91 | Make a folder a public collection | admin | Folder public toggle | folder settings | – | `/c/[id]` becomes reachable | toggle off doesn't reflect immediately | D | YES | NO |
| 92 | Configure public collection page (title/subtitle/CTA) | admin | Public page settings | folder settings | – | `/c/[id]` reflects changes | XSS in CTA URL — `sanitizeCtaUrl` exists; verify | H | NO | NO |
| 93 | Password-protect a public folder collection | admin | Folder password | folder settings | – | Overlay shown to guests | **GAP suspected — schema lacks `folders.password`; spaces only** | I, F | YES | NO |
| 94 | View public collection as guest | guest | Public browse | `/c/[id]` | – | Cards render with pagination | pagination past last page; empty collection | I | YES | NO |
| 95 | Create a space | admin | New space | spaces hub | – | Space row; auto-membership | duplicate name; emoji name | H | NO | NO |
| 96 | Toggle space privacy Public vs Private (org-internal) | admin | Space settings | space settings | – | Members can/can't browse | privacy switch while members viewing | F, D | YES | NO |
| 97 | Toggle space internet-public (`public` column) | admin | Space settings | – | – | `/c/[id]` becomes public | – | F | YES | NO |
| 98 | Password-protect a space | admin | Space password | – | – | Overlay enforced on public link | wrong pw rate-limit | F | NO | NO |
| 99 | Add member to space | admin | Space members | – | – | space_members row added | adding non-org member; bulk add | E, F | NO | NO |
| 100 | Change space-member role | admin | Space members | – | – | role enum updated | only-admin demote guard | F | NO | NO |
| 101 | Remove space member | admin | Space members | – | – | row deleted | last-admin guard | F | NO | NO |
| 102 | Add videos to a space | member with access | Add videos | space detail | – | space_videos rows | adding video already in space; permission denied (other-user video) | E, F | YES | NO |
| 103 | Remove videos from a space | admin | Remove videos | – | – | rows removed | concurrent remove + delete races | – | NO | NO |
| 104 | Delete a space | admin | Delete space | – | – | space + members + space_videos handling: spaceVideos has no FK cascade in schema shown — **verify orphan rows** | non-empty space; primary space deletion guard | B, E | YES | NO |
| 105 | Browse other spaces (Public privacy) | member | Spaces browse | `/dashboard/spaces/browse` | – | List of public spaces in org | private space leakage in list | F | NO | NO |
| 106 | View notifications inbox | member | Notifications | `/dashboard/notifications` | – | Paginated list, unread-first ordering | empty state; pagination beyond last page | I | YES | NO |
| 107 | Mark one notification read | member | Mark read | row click | – | `readAt` set; sidebar badge decrements | offline; double-click | D, I | YES | NO |
| 108 | Mark all notifications read | member | Mark all read | header button | – | All current-org rows updated | very large inbox; partial-write recovery | D, H | NO | NO |
| 109 | Notification badge live-updates after CRUD | member | Badge sync | view a comment elsewhere | – | Badge increments; on read, decrements | requires polling or websocket — verify | D, I | YES | NO |
| 110 | Delete a notification | member | Delete | (not present) | – | – | **GAP: no delete UI** — only mark read | A | NO | NO |
| 111 | Pause comment notifications | member | Prefs | `/settings/notifications` | toggle | New comment notifications suppressed | retroactive vs prospective | G | NO | NO |
| 112 | Pause anon-view notifications | member | Prefs | – | toggle | – | – | G | NO | NO |
| 113 | Edit own profile | member | Account settings | `/settings/account` | – | name/avatar persists | image too large; non-image file | H | NO | YES |
| 114 | Change password | member | Account settings | – | – | passwordHash updates; sessions invalidated? **verify** | wrong old pw; weak new pw | F, H | YES | NO |
| 115 | Set language | member | Account / nav | – | – | `set-language` action persists; UI re-renders strings | unsupported locale fallback | H | NO | NO |
| 116 | Save Gemini API key | member | Account settings | – | – | Stored encrypted | invalid key format | H | NO | NO |
| 117 | Test Gemini API key | member | Account settings | – | – | "Test" call returns success/error | network error; rate-limited test endpoint | H | NO | NO |
| 118 | Delete Gemini API key | member | Account settings | – | – | Key cleared | – | – | NO | NO |
| 119 | Delete own account | member | Account settings | – | confirm | User row + cascading data removed; redirect | active subscription owner; sole org owner | F, H | YES | NO |
| 120 | Toggle dev-mode | member | `actions/toggle-dev-mode.ts` | – | – | Hidden debug surfaces appear | persists across sessions? | – | NO | NO |
| 121 | Generate referral via Dub | member | Refer | `/dashboard/refer` | – | Embedded Dub UI loads | `DUB_API_KEY` missing → graceful disabled state ✅ verified in code | H | NO | NO |
| 122 | Visit referral page without `DUB_API_KEY` | member | Disabled refer | `/dashboard/refer` | – | Shows static disabled message | – | – | NO | NO |
| 123 | Admin: list users | super-admin | Admin access | `/dashboard/admin/access` | – | All users listed via `getUsers` | pagination on very large lists | H | NO | NO |
| 124 | Admin: create user with password | super-admin | Create user | – | – | User created, can log in | duplicate email; weak pw | H | NO | NO |
| 125 | Admin: reset another user's password | super-admin | Reset password | – | – | passwordHash updated; user sessions invalidated? | unverified session bump | F, J | YES | NO |
| 126 | Admin: revoke a user | super-admin | Revoke | – | – | User can no longer log in | revoked user's videos: deleted, orphaned, or kept? — **verify** | E, F | YES | NO |
| 127 | Admin: toggle admin flag | super-admin | Promote/demote | – | – | `isAdmin` flips | demoting last admin guard | F, J | NO | NO |
| 128 | Admin: generate invite link | super-admin | Invite | – | – | Link created with token | revoking active links | F | NO | NO |
| 129 | Admin: revoke invite | super-admin | Revoke invite | – | – | Token invalidated | already-consumed | H | NO | NO |
| 130 | Admin: replace a video's source | super-admin | Replace | `/admin/replace-video` | upload new file | Video source swapped; comments and analytics preserved? **verify** | size mismatch; codec mismatch | E, H | NO | NO |
| 131 | Admin: reprocess a video | super-admin | Reprocess | `/admin/reprocess-video` | – | Video processing re-triggered; existing transcripts/AI regenerated or kept? | retry loop guard | H | NO | NO |
| 132 | Open Messenger inbox (CAP build) | guest/member | Messenger | `/messenger` | – | Conversation list rendered or empty CTA | non-CAP build returns 404 ✅ | – | NO | NO |
| 133 | Start a new Messenger conversation | guest/member | Start chat | inbox CTA | – | `createMessengerConversation` action runs; redirect to `[id]` | anonymousId cookie missing | H | NO | NO |
| 134 | Send a chat message | user | Chat | `/messenger/[id]` | – | Message persisted; agent (Millie) replies | streaming abort; very long message | C, H | NO | NO |
| 135 | Human takeover of a conversation | super-admin | Takeover | (admin UI not found) | – | – | **GAP: no admin UI to take over conversations** | A | NO | NO |
| 136 | Delete a conversation | user | Delete | (not present) | – | – | **GAP: no delete** | A, B | NO | NO |
| 137 | Search across conversations | user | Search | (not present) | – | – | **GAP: no search** | A | NO | NO |
| 138 | Developer apps: create | owner | Dev apps | `/dashboard/developers/apps` | – | App created | name conflicts | H | NO | NO |
| 139 | Developer apps: update | owner | Settings | `apps/[appId]/settings` | – | Metadata saved | – | H | NO | NO |
| 140 | Developer apps: delete | owner | Delete app | – | confirm | App + dependent keys/domains/videos removed (cascading?); credits forfeited? **verify** | active apps with usage | B, E | NO | NO |
| 141 | Developer apps: regenerate keys | owner | API keys | – | – | New key shown once; old key invalidated | unrevoked-old-key usage during overlap window | F | YES | NO |
| 142 | Developer apps: add domain | owner | Domains | – | – | Domain saved + verification step | DNS unverified case | H | NO | NO |
| 143 | Developer apps: remove domain | owner | Domains | – | – | Domain removed | active embed pages on removed domain break | E | NO | NO |
| 144 | Developer apps: list videos | owner | Videos | – | – | Per-app video list | empty state | – | NO | NO |
| 145 | Developer apps: delete a video | owner | Delete dev video | – | – | Video removed via dev-scoped action | mirrored regular video | B, E | NO | NO |
| 146 | Developer credits: buy | owner | Credits | `/dashboard/developers/credits` | – | Stripe checkout → credit ledger updates on webhook | webhook delay; double-purchase | D | YES | NO |
| 147 | Developer credits: auto-topup | owner | Credits | – | – | Setting saved; triggers on threshold | failure path when card declined | G, H | YES | NO |
| 148 | Developer credits: usage chart | owner | Usage | `/dashboard/developers/usage` | – | Chart renders | empty/zero data; very long timespan | I | NO | NO |
| 149 | Analytics dashboard renders | member | Analytics | `/dashboard/analytics` | – | Tinybird-backed charts render | Tinybird auth/rate-limit error surfacing | H | YES | NO |
| 150 | Per-video analytics drill-in | owner | Video analytics | analytics → click video | – | Per-video chart shown | views from anon | – | NO | NO |
| 151 | Browser extension sign-in / callback | guest | Extension callback | `/extension/callback` | OAuth | API key minted | callback with malformed params | H | NO | NO |
| 152 | Health & status endpoints respond | guest | `/api/health`, `/api/status` | – | – | 200 OK | DB down → degraded payload | H | NO | YES |
| 153 | Webhook: media-server progress | server | `/api/webhooks/media-server/progress` | external POST | – | `video_uploads.processing_progress` advances | bad signature; out-of-order events | H | NO | NO |
| 154 | Webhook: Stripe events | server | `/api/webhooks/stripe` | external POST | – | Subscription state syncs | bad signature; replayed event | H | NO | NO |
| 155 | Cron: finalize stale desktop segments | server | `/api/cron/finalize-stale-desktop-segments` | scheduled | – | Stale uploads finalized | stuck job idempotency | H | NO | NO |
| 156 | Cron: developer storage accounting | server | `/api/cron/developer-storage` | scheduled | – | Storage usage recomputed | – | H | NO | NO |
| 157 | Resilience: kill+relaunch browser mid-upload | member | Kill+relaunch | force-reload during upload | – | Upload resumable OR clean error + retry | partial multipart; orphaned S3 objects | C, D | YES | YES |
| 158 | Resilience: permission denied UI | member viewing admin route | F | navigate to `/dashboard/settings/organization/billing` as member | – | Redirect or 403 page, never a partial render leaking owner data | – | F | YES | NO |
| 159 | Resilience: deep link to deleted resource | any | 404 path | open `/s/[videoId]` for deleted video | – | Branded 404 | leaks of metadata via og endpoint | H | YES | NO |
| 160 | Resilience: offline state | member | Offline banner | toggle offline in devtools | – | Surface offline state; no silent failures | reads from cache | H | NO | NO |
| 161 | Resilience: very long text inputs | member | Names, descriptions | – | – | Truncates UI, persists fully or rejects with clear error | DB column length overruns (varchar 255) | H | NO | NO |
| 162 | Resilience: emoji + special chars | member | Names | – | – | Persists; renders | normalisation; collation | H | NO | NO |
| 163 | Resilience: rotate device / responsive layout | member | Mobile nav | resize to mobile width | – | Mobile nav usable; sidebar collapses | very narrow widths | I | NO | NO |
| 164 | Resilience: back button mid-flow | member | Multi-step flows | upload, onboarding, edit | – | State preserved or warned | draft restore | C, D | NO | NO |
| 165 | Resilience: dashboard counts update after CRUD | member | Sidebar counts | create + delete a cap | – | `userCapsCount` / `userMeetingsCount` increment/decrement | stale cache | D | YES | YES |
| 166 | Resilience: 404 for an unknown route | any | `/not-found.tsx` | – | – | Branded 404 | – | – | NO | NO |
| 167 | Resilience: global-error boundary | any | `/global-error.tsx` | trigger throw via dev | – | Branded fallback, no white screen | telemetry capture | H | NO | NO |
| 168 | Theme toggle (light/dark) | member | Nav | – | flip | Theme persists across sessions | system theme follow; FOUC | – | NO | NO |
| 169 | Sidebar collapse persists | member | Nav | – | collapse | Persists across navigation | refresh | – | NO | NO |
| 170 | Spaces list sidebar shows my spaces only | member | Sidebar | – | – | Public + member-of spaces listed | shared-to-me but not member | F | NO | NO |
| 171 | Default-playback-speed is applied to embed | viewer | Embed | `/embed/[videoId]` | – | Player respects org default | per-video override wins | D | NO | NO |
| 172 | Public collection password set on space hides children | guest | `/c/[id]` | enter password | – | Children visible only after correct password | password rotation while guest in session | F | NO | NO |
| 173 | Public collection: CTA URL sanitisation | guest | `/c/[id]` | – | – | Only safe protocols rendered; javascript: URLs blocked | data: URLs; mixed-case schemes | H | YES | NO |
| 174 | Public collection: pagination | guest | `/c/[id]?page=N` | – | – | Out-of-range page → empty or last page | negative page; non-numeric | H | NO | NO |
| 175 | Live notification badge after a comment fires | owner | Notification fan-out | second tab comments | – | Owner sees updated count | requires polling / push — verify | D | NO | NO |
| 176 | Search / filter caps list | member | Filter | (verify search box) | – | – | **GAP suspected — no obvious search action** for videos list | A | NO | NO |
| 177 | Filter by folder / space tag | member | Filter | – | – | – | – | A | NO | NO |
| 178 | Branded share page with org icon | guest | Branding | `/s/[videoId]` | – | Icon + name shown per `shareableLinkUseOrganizationIcon` | icon missing fallback | H | NO | NO |
| 179 | Mobile share-page playback | guest mobile | Mobile player | `/s/[videoId]` on mobile width | – | Player and tabs usable | scrub gesture conflicts | I | NO | NO |
| 180 | Verify `videoSize` storage-key bump v2 (recent fix) | member | Sidebar video preference | – | – | Stale `md` preference auto-upgrades to LG default | corrupted localStorage | – | NO | NO |
| 181 | AI chat error message specificity (recent fix) | viewer | AI chat error path | break network | – | Specific error string, not generic | – | H | NO | NO |
| 182 | Generate-strip "blindness" fix (recent fix) | viewer | Share page strip | – | – | Strip respects scrub-highlight responsiveness | – | I | NO | NO |

---

## Summary

- **Total flows:** 182.
- **Critical (release-blockers) flows:** 50.
- **Smoke set:** 12 (rows #1, 2, 4, 6, 13, 46, 47, 64, 152, 157, 165 + #165 alias for sidebar counts). Precisely: #1, #2, #4, #6, #13, #46, #47, #64, #152, #157, #165 — 11 of the 5–10 essentials, plus one #165 explicitly tagged for state-sync.
- **Gap-type counts (rough, by appearance in the Gap column):**
  - A (missing management action): 24
  - B (incomplete CRUD): 7
  - C (broken journey / dead end): 10
  - D (missing state sync): 18
  - E (missing relationship handling): 18
  - F (missing permission logic): 21
  - G (missing automation control): 4
  - H (missing feedback / error handling): 53
  - I (UI looks interactive but isn't): 15
  - J (missing audit / history): 4
- **Notable hard gaps (not just unverified):**
  - End-user password reset / "forgot password" flow (#7).
  - "Log out everywhere" / per-device session control (#8).
  - "Leave organization" surface (#16).
  - Transfer org ownership (#17).
  - Org soft-delete UI (RPC exists, no surface) (#15).
  - Folder-level public-collection password not in schema (#93).
  - Delete-notification UI (#110).
  - Messenger: delete, search, admin takeover UI (#135, #136, #137).
  - No video trash / restore — deletion is permanent (#58).
  - Storage bucket "test connection" preflight (#41).
  - Revert-to-edit-history UI (#84).
  - Search/filter on caps list (#176, #177).
- **Unverified-from-code-alone risks** (Step 3 must validate at runtime):
  - Cascading behaviour on delete-space, delete-folder (sub-folders, space_videos orphans).
  - Whether `password reset` / `revoke user` / `change own password` invalidate sessions via `authSessionVersion`.
  - Whether the dashboard sidebar counters (`userCapsCount`, `userMeetingsCount`, notification badge) live-update after CRUD vs require navigation.
  - Whether org soft-delete keeps videos accessible at custom-domain share URLs.
  - Whether org-level `disable*` toggles affect already-rendered share pages (live viewers) reactively.
  - Whether `videoEdits` failure (resultKey null) is surfaced to the user.
  - Whether the developer credits ledger gates `/api/developer/v1/*` requests at zero balance.

Ready for Prompt 2.
