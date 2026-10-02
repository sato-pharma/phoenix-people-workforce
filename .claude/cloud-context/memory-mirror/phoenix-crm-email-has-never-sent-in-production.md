---
name: phoenix-crm-email-has-never-sent-in-production
description: "Phoenix CRM's emailed notices have NEVER produced an email delivery row in production — the only plan_edit row ever written is a TEST-world in-app copy — so an audit asking 'does the module's email work?' finds nothing and must not read that absence as a defect."
metadata:
  node_type: memory
  type: project
  originSessionId: f8ae6f5c-9f6a-423a-af23-a21c4bec1582
  modified: 2026-10-02T21:19:05.477Z
---

Measured on production `ozucdzovmcqvepbozvqf`, 2026-10-03, joining
`notification_deliveries` to `notification_events` on `notification_event_id`
(**not** `event_id` — that column does not exist) for `module = 'phoenix_crm'`:

- `plan_edit_waiting` → **1 row, channel `in_app`, status `sent`**, and nothing else. No email row,
  no Telegram row, no push row.
- Reading the event itself settles it: `event_key` ends `:test:TEST-DF` and the metadata carries
  `testLoginId: TEST-DF`. It was a **test-world** notice, which is in-app only by design
  (`deliver()` in `src/lib/phoenix-crm/server/notifications.ts`). **No real plan edit has been
  raised since the owner ordered the email on 2026-10-01**, so there was never a send to find.

**Why this matters.** It is the ABSENCE-as-evidence shape. A session verifying the owner's email
rule, or checking a NEW Phoenix CRM email before shipping it, queries the module's deliveries, sees
one in-app row, and concludes the email half is broken or blocked. It is not. The pipeline is proven
by every other module in the same 7-day window — `direct_orders` 113 email rows sent,
`weekly_plans` 74, `crm` 59, `recruitment` 36 — all through the same
`createSystemNotificationForRecipients` → `sendPhoenixEmail` path.

**How to apply.** To prove a Phoenix CRM email *can* send, read another module's email rows, not
this module's. To prove one *did*, you need a real (non-test) event of that event type to exist
first — check `event_key` for a `:test:` suffix before drawing any conclusion from a Phoenix CRM
delivery row. Related: [[verify-notification-deliveries-before-claiming-a-send]],
[[strict-recipients-silently-drops-whole-alert-families]].

**The gate that could hold such a send, and does not here.** `checkRecipientVolume` caps a
first-run `(module,eventType)` pair at `min(10, round(headcount × 0.25))` = **10** recipients until
five real sends accumulate. The first-visit notice addresses at most 4 (district manager, national
sales manager, 1–2 SFE Managers) plus the standing-admin BCC, so it passes on its first send.
