---
name: office-rerun-drops-a-net-negative-product
description: "Re-running the Office allocation SILENTLY DROPS any product whose net units are <= 0 (allocateProduct returns [] on the units > 0 guard), so the batch total comes out HIGHER than the input; 2026-02 DO003 nets -7 across 173 rows and is why Feb could not be re-run blind"
metadata:
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-08-26T17:31:15.194Z
---

**Found 2026-08-26 re-running Feb–Jun Office on the owner's order.** February refused to reconcile:
input 50,121 units, output 50,128 — **drift +7, in the direction nobody expects.** A re-allocation
losing units is intuitive; one *gaining* them is not, and that asymmetry is the tell.

**Cause.** Inside the LOCKED golden rule, `allocateProduct` opens with `if (!(units > 0)) return [];`.
A product whose net for the period is zero or negative is therefore emitted as **no rows at all**.
Its negative units simply cease to exist, so the batch total *rises* by exactly the amount dropped.
February's `DO003` (Dolabactin) nets **−7 units across 173 rows** (−17 negative, +10 positive) —
returns exceeding sales — so the re-run silently added 7 units to the month.

**Why it matters more than 7 units.** The guard is not wrong — you cannot spread a negative by
value shares and get anything meaningful — but it is *silent*. There is no advisory, no warning row,
no failed-row count; `status` still comes back `validated`. A re-run that quietly changes a month's
total is precisely the class of thing that is discovered a quarter later.

**How to apply.** Before re-running Office for any period, check for net-negative products first:

```sql
select product_code, sum(qty) net from source_of_sales_import_rows
where batch_id = :batch group by 1 having sum(qty) <= 0;
```

Then **assert unit conservation on the way out** (`|output − input| < 0.01`) rather than trusting
`status = validated` — that assert is what caught this. Do NOT "fix" it by editing the guard: that
region is the locked golden rule and CI turns red. Related:
[[ez-is-credited-evenly-across-cairo-giza-cns-reps]], [[owner-office-allocation-rule-value-share]],
[[a-narrowed-select-disarms-every-gate-downstream-of-it]] (same shape: the gate is upstream of where
the damage shows).

## The second February trap, found the same way

February's Office batch is **not purely the rule's output** — it carries **372 hand-inserted rows,
2,786 units, tagged `raw_row->>'source' = 'manual-closing-2026-02'` / `kind: cns-recon`**, added
2026-08-14 across 49 areas and 8 products with fractional quantities. A re-run deletes them, and
unlike July's override (which was a *redistribution* of the same total) these rows **add** units, so
removing them drops February's CNS line by 2,786. **Held pending the owner's word 2026-08-26.**

**The general check before re-running any Office month** — a batch header that disagrees with its own
rows is the cheapest signal that someone edited the batch by hand:

```sql
select b.total_rows, (select count(*) from source_of_sales_import_rows r where r.batch_id = b.id),
       (select count(distinct r.raw_row->>'source') from source_of_sales_import_rows r where r.batch_id = b.id)
from source_of_sales_import_batches b where b.id = :batch;
```

February read 2,243 vs 2,615 rows and **two** distinct row sources; March–June read one source and
matched exactly, which is what made them safe to re-run.
