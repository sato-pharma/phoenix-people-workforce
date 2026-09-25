---
name: office-brick-share-rpc-has-no-line-filter
description: "phx_office_brick_share(p_period) returns EVERY line's rows — blending them into one Office area share misplaced 76% of CNS July's office units, and the old per-product code hid this by being line-correct by accident"
metadata: 
  node_type: memory
  type: project
  originSessionId: cfb1b008-82c7-4a44-b3f1-382f5e0f94a9
  modified: 2026-08-12T12:52:32.778Z
---

`phx_office_brick_share(p_period)` and `phx_office_region_share(p_period)` are keyed on the
**period only** — no line filter (verified live in `pg_proc` 2026-08-10):

```sql
where b.status = 'validated' and b.period = p_period and r.invoice_period = p_period
  and r.distributor_code <> 'Office'
  and coalesce(r.is_direct, false) = false
  and coalesce(btrim(r.brick_id), '') <> ''    -- brick_share only
```

One Office upload also carries products from **every line at once**, and
`computeOfficeAllocation` loops all of them. So anything that aggregates that list into a single
blended weight spreads one line's office units by another line's geography.

**Measured on July 2026 CNS:** all-lines denominator **56,497,710 EGP** against CNS's own
**4,129,568**. **32,704 of 42,838 units (76%)** land in a different area — Menoufia 1 takes 8,676
CNS units instead of 792; Nasr City 795 instead of 4,243.

**Why it was easy to ship:** the pre-2026-08-10 code weighted each product by **its own** sales, and
a product only ever sells on its own line — so it was line-correct **by accident**. PR #2015's
blended share (correct per the owner's rule) silently dropped that property. `check:harden` was
green because `tests/office-allocation.test.ts` fed a single-line synthetic share; nothing had two
lines in it. Caught only by replicating the merged code against production before re-stamping.

**How to apply:** partition `brickShare` by the product's official line and build one
`OfficeAreaWeights` per line — `buildOfficeAreaWeightsByLine` in
[office-allocation.ts](src/lib/sales/office-allocation.ts). A line with no non-Office sales of its
own must fall to NATIONAL, never borrow another line's bricks. The regression test is two lines
where CNS sells only in A1 and Pedia only in A2 at 20x value; on the broken code the headline
assertion fires with *"expected ~100, got 4.761905"* (= 400/8400).

**Why:** it also generalises — **any period-scoped RPC feeding a per-line calculation is suspect
here.** `phx_office_region_share` has the same shape and the same absent filter.

**CLOSED — fixed and live.** `5aea06eb` *"fix(closing): build the Office area weights per LINE, not
per period (#2016)"* is on `origin/main`; `buildOfficeAreaWeightsByLine` exists in
`src/lib/sales/office-allocation.ts` (re-verified against `origin/main` 2026-08-12). Kept for the
generalisation above, not as an open item — which is why it now lives in
`MEMORY-ARCHIVE.md` rather than the index.

See [[owner-office-allocation-rule-value-share]] for the rule itself and
[[railway-merge-is-the-production-deploy]] — this shipped to production before it was caught, though
no data was written because the rule only runs at upload time.
