---
name: notifications-cron-timeout-chain-2026-07-16
description: "2026-07-16 notifications-cron incident chain: #1067 (30s step cap) exposed #1068's fix for probation-feedback-sla/probation-milestones timing out; confirmed resolved in prod"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3ffe51a6-2564-428f-b029-999f5c7f47e3
---

Chain of events, all 2026-07-16, all in `phoenix-people-workforce`:

1. **#1067** (`fix(notifications): bound cron steps with a timeout budget + overlap guard`, merged 18:08 UTC) fixed the 2026-07-15 504 outage by wrapping every step in `runScheduledNotificationProcessing` (`src/lib/notifications/scheduled-processing.ts`) with a 30s soft cap + 240s global deadline (`src/lib/notifications/step-runner.ts`).
2. That cap immediately exposed a pre-existing latency problem: `probation-feedback-sla` and `probation-milestones` steps started hitting exactly the 30000ms cap on **every single run** (confirmed via `gcloud logging read` on the `phoenix-hr` Cloud Run service).
3. **Root cause** (verified empirically, not guessed): NOT a slow query — `employees` is a 162-row table, `EXPLAIN ANALYZE` on the real query shape is 0.625ms, no 5xx in Supabase logs. The actual cause: `emitForTask`/`emitToRecipients` in `feedback-sla-reminders.ts`/`probation-emails.ts` dispatched notifications to every recipient of every task/case in a **serial `for...await` loop**, and each `createSystemNotification` call makes ~10 sequential Supabase round trips. With 62 open feedback tasks and 9–14 active probation cases in milestone windows, that's O(tasks × recipients × round-trips) sequential network calls across a cross-region link (Cloud Run `us-central1` ↔ Supabase `eu-central-1`).
4. **Two independent parallel sessions diagnosed and fixed the same root cause simultaneously** — see [[feedback-parallel-session-pr-collision]]. **#1068** (`perf(probation): parallelize per-recipient notification dispatch`) merged first (18:42 UTC) and is the fix now live. My own PR #1069 (same diagnosis, same fix shape) became unmergeable (`CONFLICTING`) once #1068 landed and was closed as superseded, unmerged.
5. **Confirmed resolved in production**: 5 consecutive post-deploy cron runs (18:55–19:15 UTC) — `probation-feedback-sla` 5.6–9.5s, `probation-milestones` 2.8–3.5s, total run ~19–24s. No `(timeout)` since deploy.

**#1070** (`perf(probation): parallelize sequential role lookups in resolveStakeholders`, merged 2026-07-16 ~19:43 UTC) shipped the leftover optimization from closed #1069: parallelizes the CEO/HR/SFE/TM/NSM role lookups in `resolveStakeholders()` (`probation-emails.ts`) into one `Promise.all`. Confirmed stable post-deploy: 5 consecutive cron runs 19:50–20:05 UTC, `probation-feedback-sla` 4.8–6.6s, `probation-milestones` 2.5–3.4s, no `(timeout)`. One of those runs (20:05 UTC) was also post a separate unrelated infra PR #1071 (prod Cloud Run min-instances 1→0, "near-free" cost change) that merged and deployed right after #1070 — cold starts from that change did not reintroduce the timeout. Incident chain fully closed.

**Also flagged but deliberately out of scope in both #1068 and #1069:** `createSystemNotificationForRecipient` in `src/lib/notifications/system.ts` still processes its channels (in_app/email/telegram) in a sequential `for` loop internally — the next latency source if task/recipient volume grows further. Not touched because it has an order-dependent `emailAttempted` flag feeding Telegram-fallback logic and is the single choke point for every notification send in the app (touching it needs its own dedicated review, much bigger blast radius than this incident).
