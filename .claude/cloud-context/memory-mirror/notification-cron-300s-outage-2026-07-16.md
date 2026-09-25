---
name: notification-cron-300s-outage-2026-07-16
description: "/api/notifications/process 504'd at exactly 300s on every invocation for 20+ hours; root cause was no timeout budget across ~15 serial cron steps, compounded by a slow serial per-recipient notification dispatch. Fixed via PR"
metadata: 
  node_type: memory
  type: project
  originSessionId: 17621ccf-12d5-416a-aa7c-05cd5757f96f
---

Production incident 2026-07-15 ~21:30 UTC → 2026-07-16 ~18:53 UTC: `/api/notifications/process`
(Cloud Scheduler, every 5 min, `maxDuration=300`) 504'd at almost exactly 300.000s on **every**
single invocation, for 20+ continuous hours, reproduced identically across multiple deploys/revisions
(so not caused by any one deploy).

**Root cause (layer 1 — the outage itself):** `runScheduledNotificationProcessing`
([scheduled-processing.ts](../../../src/lib/notifications/scheduled-processing.ts)) runs ~15 domain
steps fully serially with no per-step or overall timeout budget. Once the aggregate exceeded 300s,
Cloud Run returned 504 to the caller but did **not** kill the underlying Node execution — confirmed
via a domain log line firing 1m40s *after* the platform had already 504'd that same request. New
cron ticks kept firing every 5 min regardless, causing overlapping in-flight executions.

**Ruled out:** b866-supabase-5xx-retry-style unbounded retries — audited every outbound call
(Resend, Brevo, Telegram Bot API, Supabase/PostgREST incl. the PR #866 retry layer) and all use
AbortController/AbortSignal.timeout with capped attempts (worst case ~30-60s). None could hang
indefinitely.

**Fix 1 (PR #1067):** `src/lib/notifications/step-runner.ts` — per-step 30s soft cap via
`Promise.race` + 240s global deadline (safely under the 300s route cap), plus an in-process overlap
guard (`inFlightStartedAt`/`OVERLAP_LOCK_MS`). Every step in scheduled-processing.ts now runs
through `runStep(...)`. This stopped the 504s and added a per-run timing summary log
(`[cron:process] finished in …ms — step=Xms…`) that immediately surfaced the real culprit.

**Root cause (layer 2 — what was actually slow):** the new timing log showed
`probation-feedback-sla` and `probation-milestones` consistently hitting the 30s cap. Two
*independent* parallel sessions diagnosed this correctly and in parallel: both steps
(`feedback-sla-reminders.ts`, `probation-emails.ts`) process every work item and every recipient
**fully sequentially** via `for...await`, and each `createSystemNotification()` call makes ~10
sequential Supabase round trips. Cross-region latency (Cloud Run `us-central1` ↔ Supabase
`eu-central-1`) on every serial round trip is what pushed wall-clock past 30s (and, pre-fix, past
300s). Confirmed via `EXPLAIN ANALYZE` (0.625ms on the real query) and Supabase logs (no 5xx) — the
employee-directory table itself was never the bottleneck.

**Fix 2 (PR #1068, merged over duplicate PR #1069):** parallelized the independent per-recipient
and per-task/per-case loops in both files via `Promise.all`, preserving per-recipient/per-case error
isolation. Post-deploy: cron total time dropped from ~70s (with the two steps timing out) to ~20s.

**How to apply:** if a Cloud Run route with a hard `maxDuration` starts showing suspiciously exact,
non-varying latency at the cap, suspect "platform kills the response, not the handler" before
suspecting a true infinite hang — check whether any log line fires *after* the reported request
latency. When adding new steps to this cron, prefer parallel fan-out for independent per-recipient
work over serial `for...await`, matching the existing convention in
`processDueProbationReminderEvents` (`src/lib/probation/service.ts`), which already does this safely.

**Process note:** during this incident, three+ parallel Claude Code sessions ended up working the
same problem simultaneously (this session, another that opened #1067, another that opened #1068,
and a spawned follow-up that opened the now-closed duplicate #1069). Worth checking
`git worktree list` / `gh pr list` for existing in-flight work before assuming a fix needs to be
built from scratch — see [[parallel-session-swarm-hazard]].
