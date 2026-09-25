---
name: guard-every-prod-write-when-another-session-shares-the-queue
description: "Put the precondition you believe in the WHERE clause of every production UPDATE — on 2026-08-19 a guard was the only thing that stopped a wrong pharmacy being written, because another session had fixed the row 20 seconds earlier"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e57e90b1-6df8-4f5f-b57e-e8bd26ebf3a5
  modified: 2026-08-19T18:01:59.680Z
---

**Every production `UPDATE`/`DELETE` must carry the precondition you believe in its `WHERE`, not
just the row id.** Not as a nicety — it is the only thing standing between you and a silent
overwrite when more than one Claude Code session is working the same backlog. That is now the
normal case here, not the exception.

**The near-miss, 2026-08-19.** The owner asked me to correct `marketing_pharmacy_distributor_codes`
row `be0e6efd…` (pharmacy الشفاء, code `1558287`). I wrote:

```sql
update public.marketing_pharmacy_distributor_codes
set distributor_pharmacy_code = '0001562168', reference_status = 'matched', ...
where id = 'be0e6efd-67f9-45f6-a4fb-c4ae69531ede'
  and reference_status = 'not_found';        -- <- this line
```

It returned **zero rows**. Another session had corrected the row **20 seconds earlier**, to a better
answer: not POS at all but **Ibn sina `361157` "الشفاء جديدة"**, matched by name in
`source_of_sales_customer_map`. My value was wrong — `0001562168` is a different shop entirely
(اسامه السيد ابراهيم شومان). Without `and reference_status = 'not_found'` the update would have
clobbered a correct row with a wrong pharmacy, and nothing would have flagged it.

**Why the damage would have been invisible.** `reference_status` would still read `matched` and
`reference_match_count` still `1`, so every dashboard and badge stays green while ROI attribution
silently credits another shop's sales. See [[pos-pharmacy-codes-are-zero-padded]] for why the stored
code is the thing attribution joins on.

**How to apply**

- Guard on the state you *observed*, not the id you looked up: `and reference_status = 'not_found'`,
  `and updated_at = '<the timestamp you read>'`, `and not exists (select 1 from …)`.
- Treat **0 rows affected as a signal to re-read, never to retry without the guard.** It means your
  premise expired.
- `returning` on every write, and read it. A write that reports nothing is not a write that worked.
- Re-read the row immediately before writing when the session has been long — production moved
  under me four separate times in one evening (22 → 8 `not_found` rows while I worked).

Related: [[never-silent-drop-count-and-flag-instead]],
[[another-session-can-remove-a-worktree-under-you]] (same hazard, filesystem instead of database),
[[supabase-client-15s-timeout-commits-anyway-half-applies]],
[[marketing-not-found-codes-have-three-root-causes]].
