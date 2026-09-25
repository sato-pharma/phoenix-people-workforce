---
name: dv-evidence-window-same-day-submits
description: "CRM visits are entered through and after the working day, so any same-day check against iReports reads zero — never treat that as a measured zero."
metadata: 
  node_type: memory
  type: project
  originSessionId: d3d7ff0c-7077-426c-bc7c-4f0b250fec8d
  modified: 2026-08-09T08:29:08.973Z
---

**iReports360 visits are entered through and AFTER the working day, so any same-day read is empty
by construction.** Measured on production 2026-08-09: 2026-08-08 recorded **647 visits and only 3
of them were saved before 11:00**; the bulk lands 12:00–23:00 and roughly 100 more are saved after
midnight. At 10:32 on 2026-08-09 the whole company had 7 rows for that day.

**Why:** the outstation campaign rule read the CRM at submit time and auto-rejected a traveling
claim with zero double-visits. All four zero-DV rejections it ever produced were filed on the trip
day itself (#42 B-74, #44 B-184, #64 and #65 A-7 — 2,018.60 EGP). It never once caught a real zero.
B-184's claim is the proof: 6 double-visits for 2026-08-03 landed after she submitted at 11:26.
Fixed in PR #1933 (`outstationDvEvidenceWindowClosed`, one full day of grace after the trip's last
Cairo day), then generalised by [[system-flags-expenses-never-rejects]].

**How to apply:** before any code judges an employee on CRM visit data, ask whether the day's
visits could have been written yet. Treat an empty read within ~1 day of the activity as UNKNOWN,
never as zero — the same rule `src/lib/outstation/workload-capture.ts` already states for the AM/PM
workload. For a live check of what has actually arrived, query `ireports360_visits` by `visit_date`
and compare `crm_save_date` — and note visits attach to a manager via `double_hr_id`, not
`agent_hr_id` (see [[employees-crm-id-null-does-not-mean-no-crm-activity]]).
