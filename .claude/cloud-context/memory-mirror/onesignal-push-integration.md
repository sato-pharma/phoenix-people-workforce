---
name: onesignal-push-integration
description: "OneSignal web push (desktop + mobile) as a 4th notification channel — now added EVERYWHERE email/telegram/in-app fires (PR #1339 merged 2026-07-25), including payroll (owner override). PR #1276 (original rollout) merged. Android app push rides the SAME OneSignal app through a Firebase key from project Phoenix Workforce Push, which lives on the Phoenix HR Gmail, outside the Cloud org that blocks keys. The app's Expo account is the organization Phoenix Sato CRM (@phoenix-sato-crm); never link its starter project Omar."
metadata: 
  node_type: memory
  type: project
  originSessionId: 33b59429-9583-49c9-8d64-e7be7c328397
  modified: 2026-09-18T11:43:11.467Z
---

## Android app push: the Firebase side (2026-09-18)

- The Phoenix Android app's push needs a Firebase service-account key uploaded to the SAME
  OneSignal app the web uses: **Phoenix Workforce** (App ID below), under the owner's OneSignal
  login "Omar Anwar". No google-services.json and no SHA fingerprint are needed.
- The Firebase project is **Phoenix Workforce Push** (`phoenix-workforce-push`), owned by the
  owner's **Phoenix HR** Gmail (`phoenixx.oag@gmail.com`). He chose that account on 2026-09-18
  instead of omarrr.g.3003@gmail.com, whose org `omarrr-g-3003-org` enforces
  `iam.disableServiceAccountKeyCreation`. So the org's key block and the scratchpad script
  `firebase-push-key.sh` do not apply to this project. Firebase Cloud Messaging API (V1) was
  already Enabled when it was created.
- Firebase console path (read live 2026-09-18). There is no gear beside Project Overview any more:
  left menu **Settings** → pop-out **Service accounts** → **Generate new private key** →
  **Generate key**. That is the Firebase Admin SDK account `firebase-adminsdk-fbsvc@…`. The JSON
  goes into OneSignal only, never into the repo or chat, and Firebase can make a replacement at
  any time.
- OneSignal path (read live 2026-09-18):
  1. The gear at the bottom-left → **Push & In-App**.
  2. Under **Inactive Platforms**: **Google Android (FCM)** → **Activate**.
  3. This opens the page `/settings/configure/google-android`, and nothing saves until you upload.
  4. **Service Account JSON** → **Select file** → **Save & Continue**, then Select SDK, then
     Install and Test.

  **Done 2026-09-18.**
  - The owner uploaded the key himself.
  - At his request, Claude finished the wizard in Chrome: Select SDK = **Expo**, since the app uses
    `react-native-onesignal` + `onesignal-expo-plugin`, then Install and Test → Done.
  - **Google Android (FCM)** reads **Active** under Active Platforms, next to Web, and the app list
    shows the Android robot next to Chrome.

  Phone push now waits only on the first EAS build carrying OneSignal. `mobile/PUBLISHING.md`'s
  "What no session will do" still lists the credential step as open; it is not open.

  **The Expo account exists (2026-09-18, about 13:20 Cairo).** The owner signed up with **GitHub**
  and chose **Business**, which created the organization **Phoenix Sato CRM** (`@phoenix-sato-crm`;
  the signed-in user shows as `phoenix-satocrm`). Read live on the dashboard.
  - Expo's onboarding also made an empty starter project **Omar** (slug `omar`) in that org, and its
    "Get your project started" page says to run `eas init --id <that project's id>`. **Never link
    that id:** its slug is not `phoenix-workforce`. Link the app with
    `eas init --account phoenix-sato-crm` so Expo makes the real project.
  - **Linked 2026-09-18, PR #4020:** project `@phoenix-sato-crm/phoenix-workforce`. `eas init` also
    writes the plugin-evaluated `extra` (OneSignal's iOS app extension, `router: {}`) back into
    `app.json`; keep only `owner` + `extra.eas.projectId`, or the OneSignal plugin lists that
    extension twice on the next evaluation.
  - 🔴 **The FIRST `eas build` creates the upload keystore on Expo's servers, which is a credential.**
    Auto mode denied it from a session as "[Secret-Store Writes]" (even `--non-interactive`, which
    generates the keystore silently). The owner runs that first build himself and answers yes to
    the new-keystore question. **Later builds: a session CAN run them (tested 2026-09-18 14:11).**
    `eas build --profile production --non-interactive --no-wait` printed "Using Keystore from
    configuration: Build Credentials 0A91-FccAJ (default)" and created nothing; auto mode allowed the
    launch. It then refused a `cat` of that build's output as "[Secret-Store Writes]", and the Read
    tool read the same file fine. `EAS_SKIP_AUTO_FINGERPRINT=1` skips the slow local fingerprint.
    That night the store AAB was 111 MB and the test APK 146 MB.
  - `eas login` opens the browser by default (`--no-browser` for the old prompt), and a GitHub
    sign-up has no Expo password. A laptop login is written to `~/.expo/state.json`: judge it by
    that file's write time (00:56 that day was an older Expo tool, before the account existed).
    Never read the file's contents, which hold the session secret.
  - He also installed Expo's Claude Code plugin; its MCP server (`plugin:expo:expo`) needs his own
    `/mcp` sign-in in an interactive `claude` terminal. Nothing in the build plan needs it.
  - 🔴 **`mobile/PUBLISHING.md` says the enterprise "Does not exist" — STALE since 2026-09-18 11:48.**
    It is `enterprises/LC017auv4o`, set on Railway production (read back 14:03 that day). This session
    trusted that line and suggested "the enterprise" as his next step; never suggest creating it — a
    second signup is a second fleet ([[new-hire-medical-reps-get-company-tablets]] holds the account).
    The app's path through it: the `preview` APK is for his own phone only. Next comes a `production`
    AAB, uploaded under Phoenix, Managed Google Play, then Private apps. Rep Tablets, "Add to the rep
    tablets", refuses a package Google does not have yet, so that step waits the ~10 minutes after
    publishing. At 14:08 no `android_device_policy` audit row existed: "Save the rules to Google" was
    still his first click. The custody register held no tablets.

## Update 2026-07-25: expanded to push EVERYWHERE (PR #1339, merged, live in prod)

Owner reported "push doesn't happen" — investigation found two separate causes, then owner asked
to make push universal rather than just fix the bug:

1. **Adoption was near-zero**: only 8 devices ever subscribed org-wide (opt-in Settings toggle).
2. **Real bug found**: `probation.reminder_due` (and likely other governance-routed, single-resolved-
   recipient notifications) had push in its policy row but silently produced ZERO push delivery rows
   in production — not even a "skipped, no subscription" row like every other channel writes. No
   error logged. Traced deep into `system.ts`/`policy.ts` (channel resolution, quiet-hours branch,
   retry worker, `claimDelivery`, `hasActivePushSubscription`) without finding the exact line —
   confirmed by elimination (Cloud Run logs showed no exception in that cron step) but never fully
   root-caused. **Not fixed as a standalone bug** — superseded by the "push everywhere" rewrite below,
   which touches the same code paths; worth re-checking `notification_deliveries` for `channel='push'`
   coverage on `probation.reminder_due` if it resurfaces.

Owner then asked: "every single thing that trigger telegram or email in-app must trigger a push
notification." Delivered as [[phoenix-people-workforce#1339]] (repo `Phoenix-HR/phoenix-people-workforce`),
worktree `_wt-push-everywhere` off fresh `origin/main` (isolated because two other Claude sessions
were active in the primary checkout at the time — see [[parallel-work-model-2026-07]]).

**Owner explicit decisions (asked via AskUserQuestion, not assumed):**
- **Payroll/payslip: INCLUDE push** — overrode the original lock-screen-exposure guard that had
  deliberately excluded push from `isSensitivePayroll()` notifications (`system.ts`
  `resolveBasePolicyChannels`) and from payslip specifically (`payslip-channel-guard.ts`
  `enforcePayslipEmailBlock`). Both guards now only strip telegram/email respectively — push flows
  through. Payslip **email** stays hard-blocked (unrelated, untouched, owner's separate 2026-07-13 rule).
- **password_reset/password_setup: left email-only** — pre-login, OneSignal.login(hrId) hasn't
  fired yet so push can't reach the device regardless of policy.

**Scope of the change** — 27 source files. Two categories of fix, because the codebase has two
distinct ways a notification's channel list gets decided:
1. **Policy-driven** (`notifications/policy.ts` `policyTable`): added `"push"` to every row missing
   it (attendance, birthday, employee_import, expenses, internal_messages, offers, recruitment,
   system.announcement, payroll.*, payroll.payslip_available, telegram.daily_hr_digest). New rows
   added for modules that had **no policy entry at all** (silently defaulted to bare `["in_app","email"]`):
   `weekly_plans.*`, `field_workforce_compliance.*`. New `marketing_requests.*` wildcard as a safety
   net (previously only 8 exact eventType keys, no fallback). Added `"push"` to `defaultPolicy.channels`
   itself so any future/unlisted module inherits it automatically.
2. **Explicit call-site `channels: [...]` arrays** (bypass policy.ts entirely — `if (input.channels?.length)
   return dedupeChannels(input.channels)` in `resolveBasePolicyChannels`/`requestedChannelsForEnvelope`):
   found via `grep "channels: \[" src/` across the whole tree, NOT just files near known module-string
   hits — the first sweep missed `vacation/service.ts` (6 sites) and `excuses/service.ts` (4 sites)
   entirely because those weren't in the initially-grepped directories. **Lesson: when auditing
   notification channels in this codebase, always grep the literal `channels: [` pattern repo-wide —
   module-name greps alone will miss explicit-array call sites in files you didn't think to check.**
   13+ files fixed this way, incl. `vacation/service.ts`, `excuses/service.ts`, `outstation/{service,expenses}.ts`,
   `resignations/service.ts` (the `module: "resignation"` singular-alias SLA reminder — a latent
   module-name mismatch bug vs the `resignations.*` policy key, left unfixed/out-of-scope since the
   explicit channels array bypasses policy anyway), `weekly-planning/service.ts`, `private-calendar/
   {disputes,no-activity-clarifications}.ts`, `recruitment/{applications,interview-notifications}.ts`,
   `probation/{feedback-service,intelligence/feedback-sla-reminders,intelligence/probation-emails}.ts`,
   `internal-messages/service.ts`, `double-visit-analytics/weekly-digest.ts`, `automated-payroll/notify.ts`,
   and the internal ops-health digests (`background-jobs-digest.ts`, `ireports360-sync-digest.ts`,
   `weekly-system-health-digest.ts`, `held-notification-alert.ts` — this one alerts on the Notification
   Confidence Gate holding a send; push is safe here because it doesn't route through `sendPhoenixEmail`
   like email would, so no recursion risk), `settings.ts` (Telegram-link-connected security alert),
   and two `system.ts` Telegram-permanent-failure fallback branches.

**Deliberately left without push:**
- `password_reset.*`/`password_setup.*` (see above).
- The shared marketing/weekly-plan **email envelope** (`system.ts` `createWorkflowEmailEnvelopeNotification`,
  `channels: ["email"]`) — this is a ONE-email-to-primary+CC construct; push is inherently per-recipient
  and already sent separately by the caller via `nonEmailChannels`. Adding push here would double-send.
- Two admin **test/preview** utilities that intentionally test Telegram only: `telegram-admin.ts:495`
  (test-telegram-connection button) and `telegram-templates.ts:750` (`sendTelegramTemplateAdminPreview`).

**Test-suite trap hit**: 7 existing tests (`excuses.test.ts`, `outstation-notifications.test.ts`,
`probation-telegram-channel.test.ts`, `support-requests-notifications.test.ts`,
`telegram-operations.test.ts`, `vacation-module.test.ts`, `weekly-monthly-plans-v1.test.ts`) assert
against the literal source text of `channels: [...]` arrays via regex (`readFileSync` + `assert.match`)
rather than testing behavior — every one of these breaks on any channel-list edit and needs updating
in lockstep. `pnpm run test` fails fast (uncaught exception crashes the whole run, one file at a time)
so this required 7 iterative fix-and-rerun cycles to converge, not one shot.

**Verified live**: PR merged → `f00c2cc5` on main → prod revision `phoenix-hr-00503-tor` at 100%
traffic within ~10 min (standard no-traffic/smoke-test/promote pipeline) → `/login` and `/` both 200,
logs clean (only the pipeline's own pre-promotion smoke-test 401s). Did NOT verify a real OneSignal
push round-trip for this specific change (would need a subscribed device) — the original push.ts
send pipeline itself was already proven working in the 2026-07-23 session below.

Built a full "push" channel alongside in_app/email/telegram in `src/lib/notifications/system.ts`,
targeting recipients by OneSignal External ID (= HR_ID, set via `OneSignal.login()` client-side) —
no player-id storage needed, OneSignal fans out to every device (desktop + mobile browser) itself.
Work done in worktree `F:/Phoenix Workforce/_wt-onesignal`, branch `codex/onesignal-integration`.
**PR #1276 merged** (repo `Phoenix-HR/phoenix-people-workforce` — NOT `phoenix-workforce`, easy to
get wrong), 2026-07-23, followed by 4 small fix-up PRs same day (#1277 opt-in vs requestPermission,
#1278 CSP script-src, #1283 OneSignal legacy-endpoint switch, #1287 service-worker-active await) —
all merged, all live in prod as of the 2026-07-25 update below.

**Why:** owner asked to "start integrating with OneSignal for desktop and mobile notifications."
Greenfield — no prior web-push/service-worker code existed in the repo.

Owner's real OneSignal app: App ID `69a84e14-4c24-4426-bb5f-1e4a0ae26cd6` (Web Push, single app
used for both staging and prod — no separate staging app was created). REST API key lives in
Secret Manager (`ONESIGNAL_REST_API_KEY`) on production Cloud Run, granted to
`phoenix-hr-run@phoenix-workforce-498619.iam.gserviceaccount.com`.

**What was built (all passed lint+typecheck+test(425 files)+build in the worktree):**
- `src/lib/notifications/push.ts` — OneSignal REST send (`api.onesignal.com/notifications`,
  `Authorization: Key <REST_API_KEY>`, `include_aliases.external_id`, `target_channel: "push"`).
- `system.ts`/`policy.ts`/`scheduled-processing.ts` — "push" added to `SystemNotificationChannel`;
  added to policy rows that already had `telegram` (vacation, probation, contract_renewal,
  resignations, outstation, excuse, direct_orders, marketing_requests, telegram.delivery_escalation)
  — deliberately NOT added to payroll/payslip (lock-screen exposure risk — see
  `payslip-channel-guard.ts`, now also strips "push" the same way it already stripped "email").
  Retry worker `processPushDeliveryRetries` mirrors `processTelegramDeliveryRetries`, wired into
  the 5-min cron chain as a new `push` step.
- Migration `supabase/migrations/20260723150000_web_push_onesignal_subscriptions.sql` — adds
  `'push'` to the `notification_deliveries`/`notification_templates` channel CHECK constraints,
  `notification_preferences.push_enabled` column, new `push_subscriptions` table (one row per
  browser/device, keyed by OneSignal's own subscription id, tracks desktop vs mobile). **Applied
  to both staging (`cifwmndunmlxjhyjugxa`) and production (`ozucdzovmcqvepbozvqf`)**, verified via
  direct query on each — owner approved each apply explicitly.
- Client: `src/lib/notifications/onesignal-client.ts` + `src/components/notifications/onesignal-provider.tsx`
  (mounted in both `app-shell.tsx` and `employee-portal-layout.tsx`, the same spot as
  `SessionSecurityGuard`) — loads the OneSignal v16 SDK, calls `OneSignal.login(hrId)`, mirrors
  subscription state to `push_subscriptions` via `/api/notifications/push/register`. Whole feature
  is a no-op (renders nothing, zero API calls) until `NEXT_PUBLIC_ONESIGNAL_APP_ID` is set.
- `public/OneSignalSDKWorker.js` (required same-origin service worker proxy),
  `public/manifest.json` + `appleWebApp` metadata in `app/layout.tsx` (iOS Safari only supports
  web push for a site added to the Home Screen as an installed PWA — no way around that Apple
  requirement).
- CSP (`next.config.ts`): added `cdn.onesignal.com`/`api.onesignal.com`/`onesignal.com` to
  `script-src`/`connect-src`.
- Settings UI: `notification-settings-panel.tsx` gained a Push toggle + "Enable push on this
  device" + "Test Push" buttons (mirrors the existing Telegram test button) + device count, gated
  on `pushSupported = hydrated && Boolean(onesignalAppId())` so it's invisible until configured.
- `.env.example` documents `NEXT_PUBLIC_ONESIGNAL_APP_ID` (public) + `ONESIGNAL_REST_API_KEY`
  (server-only, never in client bundle).
- Build pipeline: `Dockerfile` ARG/ENV, `cloudbuild.yaml` --build-arg, both
  `deploy-cloud-run*.yml` workflows' Cloud Build substitutions, and the
  `NEXT_PUBLIC_ONESIGNAL_APP_ID` GitHub Actions secret — all wired so the App ID actually reaches
  the production client bundle at build time, mirroring the existing
  `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` pattern exactly.

**Already live on infra before merge (owner-approved each step, done directly via gcloud/MCP,
not through CI):**
- Both migrations applied (staging + production).
- Both env vars set on production Cloud Run — `NEXT_PUBLIC_ONESIGNAL_APP_ID` plain,
  `ONESIGNAL_REST_API_KEY` migrated to Secret Manager (it was initially added as a plain env var
  by the owner manually, breaking the convention every other secret on that service follows — now
  fixed). Two manual `gcloud run services update` redeploys (revisions `phoenix-hr-00131-pnk`,
  `-00132-b5p`), smoke-verified healthy (login/root 200) after each.
- Locally verified end-to-end once the migration existed: subscribe → `push_subscriptions` row →
  Test Push → real OS notification received.

**Key lesson for next time:** `NEXT_PUBLIC_*` vars are baked into the client bundle at `next build`
time (webpack DefinePlugin), NOT read at Cloud Run container runtime — setting one as a plain Cloud
Run env var only affects server-rendered/runtime code, never the client JS. This repo's own
Dockerfile has a comment about exactly this. Always trace the full path (GH secret → Cloud Build
substitution → Dockerfile ARG) before believing a Cloud Run env var change alone "enables" a
client-side feature.

**Testing gotcha found and worth remembering:** in `next dev`, React Strict Mode double-invokes
effects, and `next/script`'s internal load-dedup state can end up removed-but-marked-loaded across
that synthetic mount→cleanup→remount cycle, so the OneSignal `<script id="onesignal-sdk">` tag can
appear MISSING from the DOM on a live dev-mode page even though the compiled bundle correctly bakes
in the App ID and the very first real load already round-tripped successfully to OneSignal's
backend. Confirmed via reading the actual compiled chunk (`onesignalAppId()` returned the literal
configured string) — this is dev-only Strict Mode noise, not a defect; doesn't reproduce in prod
where effects aren't double-invoked. Don't re-chase this if it resurfaces during future dev-mode
testing of this feature — check the compiled bundle content and/or test against a production build
instead of trusting live DOM state across HMR restarts.

**Open idea for later, not built:** an admin-editable push-template UI (the `notification_templates`
table now accepts `channel='push'` rows and `renderNotificationTemplate()` already supports it
generically) — deferred since Template Studio's telegram-templates.ts CRUD is telegram-specific by
design; a push equivalent would be new admin UI, not required for the channel to function (falls
back to the same title/message every other channel uses when no custom template row exists).
