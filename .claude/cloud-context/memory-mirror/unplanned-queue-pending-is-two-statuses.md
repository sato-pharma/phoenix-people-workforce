---
name: unplanned-queue-pending-is-two-statuses
description: "phoenix_crm_unplanned_visits has no 'pending' status — waiting rows are manager_pending or sfe_pending, so status = 'pending' is a false zero"
metadata:
  node_type: memory
  type: project
  originSessionId: 9cd19506-2a81-4c3b-ade5-ed1a25a80194
  modified: 2026-10-30T21:19:22.705Z
---

`public.phoenix_crm_unplanned_visits.status` takes `manager_pending`, `sfe_pending`, `approved`, `refused` (read
on production 2026-10-30). There is NO plain `pending`. A check written as `status = 'pending'` returns 0 every
time and reads as "nothing waiting".

**Why:** on 2026-10-29/30 it bit twice in one job. The iReports360 history import's before-snapshot first counted
0 pending (the truth was 26), and the parallel session that ran the import reported "pending unplanned visits are
still 0" from the same false zero. The real check — queue rows joined to the copied visits, and rows created during
the copy — was 0 and 0, so nothing was wrong, but the reported proof was not proof.

**How to apply:** count waiting rows with `status like '%pending'`. To prove a bulk write added nothing to the
approval queue, count total rows plus rows created in the write's time window, and join to the written visit
ids. Never compare a single `'pending'` count. Related: [[a-mismatch-query-hides-the-row-that-matches]].
