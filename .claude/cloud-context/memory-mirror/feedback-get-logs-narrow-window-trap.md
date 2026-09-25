---
name: feedback-get-logs-narrow-window-trap
description: "Supabase get_logs' fixed row cap can silently shrink its \"last 24h\" coverage to 1-2 hours during high-activity periods — always cross-check app_error_events (or equivalent long-retention app table) before calling anything \"clean\""
metadata:
  node_type: memory
  type: feedback
  originSessionId: a521782f-ade2-4f0a-88ab-a720b96ba864
  modified: 2026-07-19T20:13:13.948Z
---

During the 2026-07-19 Supabase deep audit, an initial pass characterized "Operational Health" as
9/10 based on `get_logs` (postgres + auth services) showing only self-inflicted errors. The user
correctly called this out as dishonest/inaccurate: `get_logs` claims "last 24 hours" but returns a
**fixed row count** (~100), so during a period of heavy activity (in this case, the audit's own
migration applies) the effective time window it actually covers can shrink to 1-2 hours — nowhere
near 24h. That narrow, self-referential window was then presented with unwarranted confidence.

**Why:** the user's exact words were "what about api errors and postgres errors and alll other
errors from logs ur finding in not honest and not accurate." The fix wasn't a longer `get_logs`
call (the tool has no pagination/time-range parameter to fix this) — it was switching to a
better-suited source entirely: `public.app_error_events` (this app's own client-error-reporting
table) had 634 rows spanning a full 13 days, and surfaced a real 4-day, 511-event user-facing
incident (`/payslips` access errors) that the narrow log window completely missed. Also worth
checking in the same pass: `notification_outbox`/`background_jobs` status breakdowns (long
retention, not log-window-limited) for failed sends/jobs.

**How to apply:** when asked to audit "errors" or "operational health" on a Supabase project:
1. Check for an app-level error-tracking table first (grep the schema for `*_error*`,
   `*_audit_log*`, or check `src/lib/error-monitor/` or similar in the codebase) — these usually
   have real retention (days/weeks) unlike `get_logs`.
2. Explicitly report the actual min/max timestamp span of whatever `get_logs` returns, not just
   "last 24h" — don't repeat the tool's own claimed window without verifying it against the data.
3. Treat an EMPTY `get_logs` result (e.g. `service: "api"` or `"edge-function"` returning `[]`) as
   ambiguous, not as evidence of health — say so explicitly rather than letting silence read as a
   clean bill.
4. Cross-reference findings against existing memory of KNOWN patterns (e.g.
   [[ci-smoke-login-prod-audit-noise]], the Resend 429 rate-limit pattern) so real anomalies aren't
   drowned in already-understood noise, but also aren't used as an excuse to stop looking.

Related: [[supabase-advisor-by-design]] (the same audit's other corrected findings),
[[ci-smoke-login-prod-audit-noise]].
