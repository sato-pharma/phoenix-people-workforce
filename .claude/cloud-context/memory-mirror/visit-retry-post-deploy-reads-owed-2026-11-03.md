---
name: visit-retry-post-deploy-reads-owed-2026-11-03
description: "Pull request 28 (visit retry, vendor accounts, approval reminders) went live 3 Nov 2026; the first-working-day reads are owed; the real-browser press ran on staging and pull request 34 carries its two fixes."
metadata:
  node_type: memory
  type: project
  originSessionId: 0c04efb3-07cb-4951-a5b4-067a48ed21f3
  modified: 2026-11-03T06:14:38.024Z
---

Pull request 28 merged 3 Nov 2026 06:41 Cairo; production served `ef50ae919` about 10 minutes later. The visit retry is on by its switch; the reminders send nothing until the switch, the third number and Meta's template approval are in place.

**Owed, none of it done yet:**
- After the first working day: `phoenix_crm_visit_resend_log` by outcome, left-joined to `phoenix_crm_visits` on `visit_id`, reported as "no visit saved" and never "lost".
- A success row in `job_heartbeats` for `phoenix-approval-whatsapp-reminders` (first tick 10:09 Cairo) with zero rows in `approval_whatsapp_reminders`.
- `phoenix_crm_location_integrity` cases where `'travel_rests_on_held_wait' = any(flags)`, counted for him, by name. Only he settles a case.
- `phoenix_crm_visit_capture_provenance` rows with `queued_seconds` not null.

**The real-browser press ran, on staging, 3 Nov 2026** (route: [[a-real-browser-press-can-run-on-a-github-runner]]). Four runs. It found two defects, the header line and the stuck panels, both fixed in pull request 34, which was open when this was written; read its state before saying either fix is live. Seen on the fixed code: held, refused, too-late and landed at 375 and 1440.

**Not seen:** a real phone; the board page on production; the kept comment after Log it again on an off-plan visit, where the form opens on the customer step first (a unit test proves it).

**Why:** the auto-mode classifier refused a one-time scheduled task for these reads on 3 Nov 2026, so nothing fires them by itself.

**How to apply:** when he asks for the first-day figures, read the tables above, in Cairo time, with names.
