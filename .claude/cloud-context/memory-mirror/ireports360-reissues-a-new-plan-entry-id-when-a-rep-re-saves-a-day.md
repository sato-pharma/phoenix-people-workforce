---
name: ireports360-reissues-a-new-plan-entry-id-when-a-rep-re-saves-a-day
description: "The CRM gives a planned call a NEW entry id whenever a rep re-saves that day, so most rows that look \"removed from the plan\" are the same doctor re-planned — and plannedCalls counts entries, not doctors."
metadata: 
  node_type: memory
  type: project
  originSessionId: edc71556-4013-4eca-9919-93ac229cd4c4
  modified: 2026-08-27T19:52:27.674Z
---

iReports360 does **not** keep a stable id for a planned call. When a rep re-saves a day's plan, the
vendor issues **new `id` values for that whole day** and the old ones simply stop appearing in the
answer. Measured against production on **2026-08-27**, syncing August:

- CRM held **24,613** plan entries; Phoenix's mirror held **18,645**.
- **1,449** mirrored rows were absent from the CRM answer — but only **5** were doctors genuinely
  leaving a rep's list. The other **1,444** were the *same doctor re-planned onto another day*.
- Across the 99 affected (rep, day) buckets: **58** kept the same doctors under new ids, **36**
  gained doctors, **5** lost one or two, and **0** vanished.

**Why this matters more than it looks.** `plannedCalls` on the Rep Doctor Lists board counts plan
**ENTRIES**, not distinct doctors (`plannedDoctors` is the distinct count). So a sync that only ever
upserts keeps BOTH ids for a re-saved day and silently inflates the planned-call count — and with
it `plannedCallsToDate`, `frequencyDelta` and `frequencyStatus`, pushing genuinely on-plan reps into
`under`. That is the board inventing a performance problem for a named person, which is the exact
failure its own test header warns about.

**How to apply:** never treat "absent from the vendor's answer" as "removed from the rep's list" —
compare the **(agentID, contactID) pair** across the whole window before calling a doctor dropped.
And any pull of `ireports360_plan_entries` that adds must also prune, or it double-counts. Since
2026-08-27 the hourly in-process sync does both — see [[outbox-drain-is-blocked-by-50-exhausted-rows-head-of-line]]
for the sibling lesson that a scheduled job looking healthy proves nothing about what it did.

Related: [[achievement-numerator-is-covered-actual-not-all-sales]],
[[crm-coverage-and-frequency-are-two-kpis-that-disagree]].
