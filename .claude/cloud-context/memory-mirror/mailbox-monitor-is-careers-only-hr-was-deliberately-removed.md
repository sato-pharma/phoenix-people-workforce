---
name: mailbox-monitor-is-careers-only-hr-was-deliberately-removed
description: "The Mailbox Compliance Monitor watches careers@ ONLY; hr@ was connected and deliberately removed, and the one-click import keeps offering it back. Re-verified live 2026-09-03 — still exactly 1 row (careers@, active), hr@ absent. last_checked_at is on-demand (no cron polls this), so it being frozen at 08-30 setup time is expected, not broken — but it also means nobody has opened the dashboard since."
metadata: 
  node_type: memory
  type: project
  originSessionId: b84fcd22-a5f7-4a12-88e9-8bc7506440bf
  modified: 2026-09-03T00:59:38.076Z
---

## Re-verified 2026-09-03 against production

**Unchanged.** `mailbox_monitors` has exactly one row: `careers@satopharma.com`, `status = active`,
created by `b-10`. `hr@satopharma.com` is not in the table at all — confirms it was actually
deleted, not merely deactivated. Matches the 08-30 decision below with no drift.

**`last_checked_at`/`last_ok_at` are both still frozen at 2026-08-30 02:15 UTC** — same moment as the
last row in `mailbox_monitor_access_log`. This is by design, not a stall: `markHealth()` in
`src/lib/mailbox-monitor/service.ts` only updates those columns when someone actually opens the
dashboard and lists/reads messages (or on initial connection test at `addMonitor`); there is no
scheduled job in `src/lib/observability/job-schedule.ts` that polls it. **The real fact worth
carrying forward: nobody has opened `/admin/mailbox-monitor` since the 08-30 setup session** — the
access log has 10 rows, all within that same ~1-minute window, none since. Not a bug in the feature;
just unused since it was configured.

---

Owner call 2026-08-30: the Mailbox Compliance Monitor (`/admin/mailbox-monitor`) is enrolled on
**`careers@satopharma.com` only**. `hr@satopharma.com` was connected in the same click and then
removed on his instruction.

**Why:** the one-click "Company mailboxes ready to connect" control is **all-or-nothing** — it
posts `{ importConfigured: true }` and `importConfiguredMailboxes(actorHrId)` takes no list, so it
enrols *every* mailbox in `RECRUITMENT_EMAIL_INBOXES_JSON` at once. There is no per-mailbox connect
button. hr@ came along with careers@ and had to be deleted afterwards.

**How to apply:** because `listImportableMailboxes()` returns configured-minus-already-monitored,
hr@ now shows up **again** in that card with a "Connect 1 mailbox" button. Do NOT click it, and do
not treat its presence as a fault — it is a deliberate exclusion, not a missing enrolment. If a
future need is genuinely careers@-plus-hr@, that is his call, not a tidy-up.

The first ever successful connection was 2026-08-30 05:05 Cairo — before that the feature had never
authenticated once, in the two days since it shipped.
