---
name: strict-recipients-silently-drops-whole-alert-families
description: "\"no exact authorized recipient was resolved\" silently kills entire notification families on EVERY channel — resignation, attendance-agent, employee-import all at 0 sent"
metadata:
  type: project
---

`notification_deliveries.last_error = "Notification skipped because no exact authorized
recipient was resolved."` is a **silent, total** drop: status `skipped`, every channel at once
(email + in_app + telegram + push), no retry, no error surfaced anywhere in the UI. Measured live
on production 2026-08-09:

| family (idempotency_key prefix) | sent | skipped-no-recipient | last attempt |
| --- | --- | --- | --- |
| `marketing-request` | 29 | 510 | 2026-08-04 |
| `resignation` | **0 since 2026-06-28** | 269 (84 email + 84 in_app + 84 telegram + 17 push) | 2026-08-08 20:09 |
| `attendance-agent-ingestion` | **0 since 2026-07-19** | 23 | fires daily, still failing |
| `employee-import` | **0** | 3 | 2026-08-05 |

**Why it bites:** the alert keeps firing on schedule and keeps writing rows, so every "is the
cron running?" check looks healthy. Only `status`/`last_error` reveal that nothing was delivered.
An employee resigned 2026-08-08 and no human was notified on any channel.

**Mechanism** — `strictRecipients: true` (default policy, `src/lib/notifications/policy.ts`) plus a
`recipientStrategy` that performs a LOOKUP rather than reading explicitly-passed recipients. For
`attendance.attendance_agent_ingestion_stalled` (policy.ts:104) the comment says it targets admins
named via `metadata.moduleOwnerHrIds`, but the strategy is `["permission_based"]` — a lookup that
ignores that metadata. The `early_birds.*` entry documents the correct pattern: when recipients are
supplied explicitly, the strategy must be `"cc"`, not a lookup.

**NOT the hr_id casing trap** — checked: both Super Admin hr_ids (`B-10`, `PHX-1`) match
`employees.hr_id` exactly. Don't reach for [[marketing-approver-hrid-casing-fk]] here.

**How to check:** group `notification_deliveries` by `split_part(idempotency_key,':',1)` with
`count(*) filter (where status='sent')` vs `filter (where last_error ilike '%no exact authorized%')`.
A family with sent=0 is a dead alert. Relates to [[attendance-agent-needs-the-office-lan]] —
the LAN outage is why attendance ingestion stopped, this is why nobody found out.
