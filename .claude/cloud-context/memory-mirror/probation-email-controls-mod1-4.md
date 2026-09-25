---
name: probation-email-controls-mod1-4
description: "Probation email controls (weekly digest, SLA ladder, daily cap, pre-send audit) — PR #1094 MERGED+LIVE 2026-07-17; emails still PAUSED, PHX-1 work_email unset"
metadata: 
  node_type: memory
  type: project
  originSessionId: 8c826290-3610-4c5c-80f9-d84104d12c1c
  modified: 2026-07-19T08:41:56.829Z
---

Owner-requested batch (2026-07-17) reducing probation email noise + guaranteeing correctness. Built in worktree `F:/Phoenix Workforce/_wt-probation-sla-fix`, branch `codex/probation-email-clarity`, **PR #1094 MERGED+LIVE 2026-07-17** (merge commit 56ffee27; CI green, prod Cloud Run deploy promoted to 100% after smoke test, domain 200). Code is live but SILENT — see gated follow-ups below.

The 4 modifications:
- **MOD-1 Weekly digest** — replaced the per-Double-Visit-day snapshot email with ONE weekly digest per probationer with DV activity that week. Self-gates to `WEEKLY_DIGEST_WEEKDAY=0` (Sunday) via `processProbationWeeklyDigest` in `probation-emails.ts`, wired into `/api/notifications/daily`. Greeting `"Dear Line {{line}} Managers,"` (e.g. "Dear Line Pedia Managers"). TO=line chain (NSM/DM/TM/PM·GPM/SFE), CC=CEO/HR. New template `probation_weekly_digest`. Per-DV-day send removed from `dv-sync.ts`.
- **MOD-2 SLA recipient ladder** (`feedback-sla-reminders.ts`) — timings unchanged (24/48/72h). Reminder 1 (due)=evaluator only; reminder 2 (escalated) CC = Direct Manager (`probation_cases.manager_hr_id`) + System Admin; reminder 3 (overdue) CC = CEO + HR + Super Admin. **System Admin CC resolves B-10, NOT PHX-1** (`SYSTEM_ADMIN_CC_HR_ID="B-10"`, PR #1098) — PHX-1 has no deliverable mailbox (employees.work_email UNIQUE; omar.anwar@satopharma.com already belongs to B-10, Omar Anwar HR Manager+Super Admin).
- **MOD-3 Daily cap** (new `notification-cap.ts`) — max 2 probation notification EVENTS per recipient per Cairo day (email+in-app+telegram = 1). **PHX-1 exempt**. Over-cap defers to next day free (idempotent sweeps). Counts via `notification_events`(module=probation)+`notification_deliveries`. Fails OPEN. Pure `createCapGate(cairoDate, baseline, exempt)` extracted for unit tests.
- **MOD-4 Pre-send audit** (`auditProbationOutboundEmail` in `email.ts`) — probation outbox rows must pass a correctness check before send: no unresolved `{{tokens}}`, non-empty subject/title, employee by NAME not HR_ID. Fail → `markNotificationOutboxSkipped(..., "probation_audit_failed")` + log.

Tests: new `tests/probation-notification-controls.test.ts` (behavioral cap-gate + audit), MOD guards in `probation-emails.test.ts` + `probation-feedback-workflow.test.ts`. Gate green (typecheck, 390 tests, lint 0 errors).

**Follow-on work (2026-07-17, ALL SHIPPED + LIVE):**
1. **B-10 System-Admin CC routing** — PR #1098 MERGED+deployed. `SYSTEM_ADMIN_CC_HR_ID="B-10"`.
2. **MEDICAL-REPS-ONLY scope fix** — owner flagged non-reps were enrolled. Bundled into PR #1098 (guards in cases.ts/backfill.ts) + migration `20260717140000` (hire trigger, applied staging+prod). Deleted 4 non-rep prod cases (2 DSM/1 RSM/1 Admin Assistant). See [[probation-module-is-field-force-only]].
3. **FRESH-START cutoff** — PR #1103 MERGED+deployed. `PROBATION_EMAIL_FRESH_START_ISO="2026-07-17T13:00:00Z"` in `email-fresh-start.ts`; SLA + milestone + digest sweeps skip pre-reset activity (there were 62 open DV-days + crossed milestones that would otherwise catch-up-blast). Owner directive: no backfill emails on re-enable.
4. Emails RE-ENABLED 2026-07-17 13:14 UTC after the cutoff deployed, then **PAUSED AGAIN on owner request 2026-07-19 08:41 UTC** (`email_notification_policies.probation.enabled=false`, 0 rows in flight). **CURRENT STATE: probation EMAIL is OFF** (in-app/Telegram unaffected). Reversible via the same flag.
5. Weekly-digest run day = Sunday (`WEEKLY_DIGEST_WEEKDAY=0`) — owner not yet asked to confirm.

Incident note: during the FIRST re-enable (11:07 UTC, before the scope+fresh-start fixes) a /process tick sent the 2 owner demo rows; owner then flagged the non-rep scope bug; I re-paused (11:19), confirmed NO real non-rep emails leaked, then did the full fix. See [[email-render-map-vs-placeholderhints]] [[probation-email-recipients-and-templates-rule]] [[phx1-system-admin-identity]].

Merge base note: branch was behind origin/main; merged main in (commit 223b999c), resolved one conflict in `phoenix-email-layout.tsx` by taking main's premium zebra table. Needed `npm install` for main's new `puppeteer-core` dep in the worktree.
