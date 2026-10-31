---
name: ireports360-api-closes-after-delta-2-training
description: "The iReports360 API is closed only on his word after the Delta (2) training (Thursday 2026-11-05) AND after those teams start on Phoenix — 36 people still record in iReports360 on 31 Oct"
metadata:
  node_type: memory
  type: project
  originSessionId: 9cd19506-2a81-4c3b-ade5-ed1a25a80194
  modified: 2026-10-31T02:48:40.278Z
---

The Delta (2) training is on **Thursday 5 November 2026** (owner, 2026-10-30, about 23:30 Cairo: "Delta (2) training
is the next thursday"). On 2026-10-31 about 03:45 Cairo he said "close the iReports360 API after the Delta (2)
training". Closing comes after it, and only on his own word.

**Why it cannot simply be the day of the training:** on 31 Oct, 36 active people (1,732 visits since 18 Oct) still
have visits served from iReports360 by `crm_visits_unified`. 9 have no Phoenix visit at all (4 medical reps, 3
district managers, 2 national sales managers). 27 record in Phoenix too but had 135 person-days recorded only in
iReports360 — Phoenix wins a day only when it has an entry, and district managers keep both apps by his rule.
Closing while anyone still records a day only in iReports360 leaves that day empty, and CRM no-activity is charged
on it. A team that has not started on Phoenix is started on Admin → CRM (team start, a Saturday — the first after
the training is 7 November), his act. The 2026 history of every current rep was already copied into
Phoenix CRM on 2026-10-30 (PR 6676), so closing loses no history.

**How to apply:** order in `docs/crm-cutover-runbook.md`, "Closing iReports360 when every team started on its own
date" (merged 2026-10-31 04:04 Cairo as PR 6697, which lets `vendor_sync_retired_at` stand without
`cutover_date`; its migration `20261031150000` is applied to production only at the close): their teams start → one rolling sync covers the day before the start → the
recent-iReports360-rows query returns nothing → retire with `cutover_date` left NULL (announce) → cron-job.org →
Healthchecks → secrets (keep `PHOENIX_LIVE_CRM_POLL`). Never set `cutover_date` as part of closing: it waives that
month's CRM no-activity (decision 18) — a money decision, never made in chat. Never close on your own reading of the
date; if the training moves, ask him. No announcement email to reps: [[never-fire-bulk-emails-ever]].

**Never put the closing words in a `Next step:` line before the training is over.** On Sat 31 Oct 04:48
Cairo the words "close the iReports360 API now that the Delta (2) training is done" arrived five days early,
sent from the suggestion box a session had filled. The gate query returned 38 people (2,014 iReports360
visits in 14 days, last 29 Oct), so nothing was closed. If the words arrive, run the gate query first;
any row means do not close.
