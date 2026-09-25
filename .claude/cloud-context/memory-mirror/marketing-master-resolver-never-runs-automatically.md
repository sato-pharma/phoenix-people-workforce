---
name: marketing-master-resolver-never-runs-automatically
description: "The marketing pharmacy master resolver went ten days uncalled and codes piled up NULL — fixed by PR #2210 (live prod 2026-08-19); the write path now resolves what it writes, and the two guards on that call must never be relaxed"
metadata: 
  node_type: memory
  type: project
  originSessionId: 3feca446-024a-4d2e-8f90-fe2a4611a626
  modified: 2026-08-19T16:34:04.140Z
---

**FIXED AND LIVE — PR #2210, merge `4a98e847`, serving on production 2026-08-19 18:56 Cairo
(verified via `/api/healthz`). Do not undo.** The file name is kept for its inbound links; the
"never runs" state it describes is history, and the reason it must not come back is below.

`phx_resolve_marketing_pharmacy_codes(uuid[])` shipped 2026-08-09 as a data-only migration
(`20260809014712_marketing_pharmacy_master_resolution.sql`): created, run once by hand over the 289
codes that existed that day, then **called by nothing** — no route, no cron, no trigger. Every code
validated afterwards accumulated `master_match_kind IS NULL`, with no error, no alert and no screen
that shows the gap. Found only because the owner asked an unrelated question about one customer.

| Run | Codes | Result |
| --- | --- | --- |
| 2026-08-09 12:16, by hand | 289 | 269 exact / 6 ambiguous / 14 unresolved |
| 2026-08-11 → 08-19: nothing ran | **28 piled up NULL** | invisible |
| 2026-08-19 18:35–18:37, by hand | 28 | 17 exact / 4 ambiguous / 7 unresolved |
| 2026-08-19, **#2210 — automatic from here** | every new code | at write time |

State after: 317 codes, **0 NULL** — 286 exact / 10 ambiguous / 21 unresolved.

**`src/lib/marketing-requests/master-resolution.ts` carries two guards. Both are load-bearing and
neither is defensive padding:**

1. **It must never throw.** `createMarketingValidationRecord` calls it from INSIDE the try block
   whose catch DELETES every customer and pharmacy the submission just wrote. A throw escaping the
   module would make a transient DB blip destroy a rep's completed field visit — GPS fix and live
   shop-front photo — and report it as a failed save. Every failure path logs a warning, returns
   false.
2. **It must never send a null `p_code_ids`.** The RPC reads null as *resolve every active code*.
   From a write path that re-runs the whole table on every validation and silently re-verdicts rows
   a human may have curated. An empty list makes NO call at all.

The call is `await`ed, not fire-and-forget — an unawaited promise races the response and leaves the
row unresolved, which is the exact failure this fixed.
`tests/marketing-master-resolution.test.ts` pins both guards plus the write-path wiring; each was
broken and confirmed to fire its own assertion.

**SECOND GAP, found 2026-08-19 and repaired: #2210 resolves at WRITE time, but nothing re-resolves
when the MASTER MAP changes.** An owner ruling on `source_of_sales_customer_map` silently leaves
every already-resolved marketing code pointing at the old area, with no error and no screen that
shows it. Found **8 drifted codes**, all stamped in the one-off 2026-08-09 12:16 run and all
out-of-date because the owner ruled on those customers between 08-09 16:21 and 08-12 10:31 — six of
them across an AREA boundary (`UE5→UE6` ×2, `D12→D13`, `GZ6→UE9`, `AB2→AB3`, `UE7→UE8`), two a brick
move inside the same area. Re-resolved by hand; **0 drifted of 283 exact codes** after. There is
still no automatic re-resolve, so re-run this check after any batch of placement rulings:

```sql
select count(*) from marketing_pharmacy_distributor_codes d
join source_of_sales_customer_map m
  on m.distributor_code=d.mapped_distributor_code and m.customer_code=d.mapped_customer_code
where d.active and d.master_match_kind='exact'
  and (d.mapped_area_code is distinct from m.area_code or d.mapped_brick_id is distinct from m.brick_id);
```

**The pharmacy table has TWO layers and they collide.** 283 pharmacies are a one-shot ROI seed
(2026-06-20, `pharmacy_code` = the bare numeric distributor code, no owner, `validation_status =
pending`, linked to `ROI-C-*` customers); only 26 are real field validations (`MKT-PHA-*`). Where a
rep validates a shop the ROI seed already holds, both rows exist under one distributor code — that
is what a "duplicate pharmacy" usually is here, and **deleting the seed row would damage ROI
reporting**. As validations grow, so will the overlap. Two such pairs exist today (Ibn Sina
`421516`, POS `1548234`/`0001548234` — the codes differ only by POS zero-padding, see
[[pos-pharmacy-codes-are-zero-padded]]).

**Still true, and still the thing that hides problems here: nothing READS the `mapped_*` columns.**
Grepped across `src/lib/marketing-requests`, `src/components/marketing-requests` and both route
trees — zero hits. Customer Validation still prints the Google-extracted `region_name` /
`extracted_area_name`. So resolution changes the database and changes NOTHING visible; never tell
the owner a page will look different after a resolver run.

**`marketing_customers.area_id` is NOT the shop's geography.** Validation copies the OWNER
employee's own area (`service.ts` ~`:4620`/`:4701`). A Product Manager owner (A-10) sits on area 42
= "Egypt", so every customer they validate is stamped 42. The shop's real placement is
`mapped_area_code` / `mapped_brick_id` from `source_of_sales_customer_map`, and the owner's rule is
that geography follows that master.

**Naming trap that will confuse you again:** Google's address text says "Asyut 1" / "Asyut 2"
(district labels); Phoenix sales areas are `UE3` = "Assuit 1" and `UE4` = "Assuit 2". Different
systems, routinely disagreeing on the same pin. Trust the master, not the Google string.

`master_match_kind IS NULL` (never checked) must stay distinct from `'unresolved'` (checked,
genuinely absent) — never give the column a default and never backfill NULL to `'unresolved'`.

Related: [[sos-bricks-are-the-authority-for-branch-to-area]],
[[marketing-reference-list-is-a-point-in-time-import]] (a different lookup entirely —
`reference_status` is unrelated to `master_match_kind`, neither derives from the other),
[[pos-pharmacy-codes-are-zero-padded]], [[railway-merge-is-the-production-deploy]].
