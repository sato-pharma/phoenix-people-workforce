---
name: onesignal-push-integration
description: "OneSignal web push (desktop + mobile) is the 4th notification channel, added EVERYWHERE email/telegram/in-app fires — including payroll/payslip (owner override; payslip EMAIL stays blocked). Android app push rides the SAME OneSignal app via a Firebase key. Holds the account identity (OneSignal app id, the Phoenix Sato CRM Expo org — never link the 'Omar' starter project, the owner runs the first eas build because the keystore is a credential), and the reusable lessons (grep `channels: [` repo-wide; NEXT_PUBLIC_* is baked at build time)."
metadata: 
  node_type: memory
  type: project
  originSessionId: 33b59429-9583-49c9-8d64-e7be7c328397
  modified: 2026-09-26T05:19:23.177Z
---

OneSignal web push (desktop + mobile browser) is a 4th notification channel alongside in_app/email/telegram,
built greenfield 2026-07-23 and expanded 2026-07-25 to fire **everywhere** email/telegram/in-app does.
Recipients are targeted by **OneSignal External ID = HR_ID** (set client-side via `OneSignal.login(hrId)`) —
no player-id storage; OneSignal fans out to every device itself. The whole feature is a no-op until
`NEXT_PUBLIC_ONESIGNAL_APP_ID` is set. ⚠️ The 2026-07 build wired this through **Cloud Run / Secret Manager /
cloudbuild**, which is DEAD infrastructure now (production is Railway) — treat those deploy mechanics as
stale; only the identity and behaviour below are current.

## Account identity

- **OneSignal app** (single app, staging AND prod): App ID `69a84e14-4c24-4426-bb5f-1e4a0ae26cd6`, under the
  owner's OneSignal login "Omar Anwar". `NEXT_PUBLIC_ONESIGNAL_APP_ID` is the public/client half;
  `ONESIGNAL_REST_API_KEY` is server-only, never in the client bundle.
- **Firebase (for Android app push), 2026-09-18:** the service-account key goes to the SAME OneSignal app.
  Project **Phoenix Workforce Push** (`phoenix-workforce-push`), owned by the **Phoenix HR** Gmail
  (`phoenixx.oag@gmail.com`) — chosen over `omarrr.g.3003@gmail.com`, whose org enforces
  `iam.disableServiceAccountKeyCreation`. FCM V1 already enabled; no `google-services.json` and no SHA needed.
  The JSON goes into OneSignal only (Google Android FCM now **Active**), never the repo or chat. **Done** —
  owner uploaded the key, wizard finished with Select SDK = **Expo**.
- **Expo account, 2026-09-18:** organization **Phoenix Sato CRM** (`@phoenix-sato-crm`), GitHub sign-up,
  Business tier. 🔴 **Never link the empty starter project "Omar" (slug `omar`)** Expo's onboarding created —
  link with `eas init --account phoenix-sato-crm`; the real project is `@phoenix-sato-crm/phoenix-workforce`.
  `eas init` writes plugin-evaluated `extra` back into `app.json` — keep only `owner` + `extra.eas.projectId`,
  or the OneSignal plugin double-lists its iOS app-extension on the next evaluation.

## Android build and distribution

- 🔴 **The FIRST `eas build` creates the upload keystore on Expo's servers — a credential — so auto mode
  DENIES it from a session** ("[Secret-Store Writes]", even `--non-interactive`). The **owner** runs the
  first build and answers yes to the new-keystore question. **Later builds a session CAN run** — they use the
  existing keystore and create nothing (`--non-interactive --no-wait` launched fine). `EAS_SKIP_AUTO_FINGERPRINT=1`
  skips the slow local fingerprint. Auto mode refuses a `cat` of the build output, but the Read tool reads it.
- 🔴 **The enterprise EXISTS** — `enterprises/LC017auv4o`, set on Railway production; `mobile/PUBLISHING.md`
  saying "Does not exist" is STALE. **Never suggest creating it — a second signup is a second fleet**
  ([[new-hire-medical-reps-get-company-tablets]] holds the account). Distribution path: the `preview` APK is
  the owner's phone only; a `production` AAB uploads under Managed Google Play → Private apps; "Add to rep
  tablets" refuses a package Google does not have yet, so it waits ~10 min after publishing.

## Behaviour and owner decisions

- **Payroll/payslip: push INCLUDED** (owner override of the original lock-screen guard) — `isSensitivePayroll()`
  and the payslip guard now strip only telegram/email, letting push through; **payslip EMAIL stays
  hard-blocked** (separate 2026-07-13 rule, untouched).
- **`password_reset`/`password_setup`: email-only** — pre-login, `OneSignal.login(hrId)` hasn't fired, so
  push cannot reach the device regardless of policy.
- **Deliberately no push:** the shared marketing/weekly-plan email ENVELOPE
  (`createWorkflowEmailEnvelopeNotification`, `channels:["email"]`) — it is one-email-to-primary+CC while push
  is per-recipient and already sent separately by the caller, so adding push there double-sends; and the
  Telegram-only admin test/preview utilities.

## Reusable lessons

- 🔴 **A notification's channel list is decided TWO ways — grep the literal `channels: [` pattern REPO-WIDE
  when auditing.** Either policy-driven (`notifications/policy.ts` `policyTable`; `defaultPolicy.channels`
  now includes push so unlisted modules inherit it) OR an explicit call-site `channels: [...]` array that
  bypasses policy entirely (`if (input.channels?.length) return dedupeChannels(...)`). A module-name grep
  MISSES the explicit-array call sites (it missed `vacation/service.ts` and `excuses/service.ts` on the first
  sweep).
- 🔴 **Several notification tests assert against the literal SOURCE TEXT of `channels: [...]` arrays via
  regex** (`readFileSync` + `assert.match`), not behaviour — every channel-list edit breaks them in lockstep,
  and `pnpm run test` fails fast one file at a time, so a channel change needs iterative fix-and-rerun.
- 🔴 **`NEXT_PUBLIC_*` vars are baked into the client bundle at `next build` time (webpack DefinePlugin), NOT
  read at container runtime** — setting one as a runtime env var only affects server code, never client JS.
  Trace the full path (secret → build substitution → build ARG) before believing an env change "enables" a
  client-side feature.
- **iOS Safari web push works only for a site added to the Home Screen as an installed PWA** (Apple
  requirement — no way around it; needs `manifest.json` + `appleWebApp` metadata). A same-origin service
  worker (`public/OneSignalSDKWorker.js`) is required for web push at all.
- **`next dev` Strict-Mode double-invoke can make the OneSignal `<script>` tag appear MISSING from the DOM**
  though the compiled bundle bakes the App ID in correctly — dev-only noise, not a defect. Check the compiled
  chunk or a production build, not live DOM across HMR restarts.
- A latent, real bug left unresolved: `probation.reminder_due` (and likely other governance-routed
  single-resolved-recipient events) once produced ZERO push delivery rows with no error logged — superseded
  by the push-everywhere rewrite that touches the same paths, but re-check `notification_deliveries` for
  `channel='push'` coverage there if it resurfaces.
