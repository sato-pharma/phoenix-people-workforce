---
name: an-employee-insert-auto-fills-a-vacant-seat-and-restamps-nothing
description: "Inserting a row in public.employees fires a trigger that seats the person, rewrites au.line_area_map, and thereby invalidates the achievement fingerprint on EVERY period - silently."
metadata: 
  node_type: memory
  type: project
  originSessionId: 52493c41-8681-4061-aa67-4d730444cc29
  modified: 2026-08-28T16:24:35.921Z
---

**A plain `insert into public.employees` is not a plain insert.** Measured on staging 2026-08-28
while filling three vacant Cairo rep seats. Do NOT hand-write `au.occupancy_history` rows after an
employee insert - the system has already written them, and a manual insert duplicates the seat.

`phx_employee_insert_autofill_replacement_vacancy` (AFTER INSERT on `public.employees`) fires and:

1. **Closes the seat's `vacant_placeholder` occupancy row**, setting `effective_to` to **today** -
   not to any date you supplied, and it ignores a `change_reason` you set in the same statement.
2. **Inserts a `node_type='person'` occupancy row** with `event_type='hire'`,
   `source_system='hire_rpc'`, `effective_from` = **today**.
3. **Flips `au.line_area_map.area_state` from `vacant_will_hire` to `occupied`.**

Step 3 is the dangerous one. `au.f_attribution_config_fingerprint()` hashes **whole `line_area_map`
rows** (`sum(hashtextextended(m.*::text,0))`), so that flip changes the fingerprint - and
`phx_monthly_achievement(period)` silently falls through to `f_monthly_achievement_live()` whenever
`au.monthly_attribution_rollup_meta.config_fp` no longer matches. **Hiring one person therefore
invalidates the stamp on every period at once**: 8 of 8 went `fp_ok=false` from three inserts. There
is no error and no warning - the numbers just stop coming from the rollup.

**So: after ANY hire, re-stamp.** Then verify through the function, not by reading back the meta row:

```sql
insert into au.monthly_attribution_rollup_meta (period, config_fp, refreshed_at)
select p, au.f_attribution_config_fingerprint(), now()
from (select distinct period as p from au.monthly_attribution_rollup) s
on conflict (period) do update set config_fp = excluded.config_fp, refreshed_at = now();
```

Three smaller traps found alongside it:

- **`au.occupancy_history.occupant_canonical_hr_id` is a GENERATED column** - naming it in an insert
  errors with `428C9`, and that error aborts every statement batched with it.
- **`occupancy_id` is an identity column but the seed rows carry explicit ids**, so the sequence
  trails the table; `setval` it before inserting or the first insert collides.
- **The trigger dates everything TODAY.** If the seat should read as filled earlier, UPDATE
  `effective_from`/`effective_to` afterwards - there is no BEFORE trigger on `occupancy_history`, so
  an update is safe (the only trigger there is `trg_au_reclaim_reports_on_manager_hire`, AFTER
  INSERT).

Attribution is per **area**, not per person, so seating someone changes **no** achievement figure -
verified identical before and after. The risk here is entirely the silent fingerprint break, not the
arithmetic. Context: [[staging-is-now-mock-data-not-a-production-mirror]] ·
[[never-change-the-organogram-skeleton]]
