---
name: portal-medrep-achievement-max-target-dedup-bug
description: "NSM/DSM/CEO med-rep performance inflates achievement when a rep has >1 row per territory/period/product (sums sales, MAX target)"
metadata: 
  node_type: memory
  type: project
  originSessionId: f195e388-0f96-4209-b2f2-c6f6cde9e7e4
  modified: 2026-07-23T12:16:06.053Z
---

`buildTeamPerformanceForScope` in `src/lib/employee-portal/service.ts` (~line 4326-4388) —
behind `getDsmTeamPerformance` (DSM team view + NSM "Medical Reps Performance" line view) and
`getCompanyMedRepPerformance` (CEO company rollup) — computes achievement by **summing sales per
row** but **de-duplicating target with "take max"** per `canonical::territory::period::product`
(`maxTargetByKey`, and `globalMaxTargetByKey` = `territory::period::product` for the line total).

This is INCONSISTENT with the admin Sales dashboard `getSalesDashboard` (`src/lib/sales/service.ts`),
which **sums** targets (`sumTargetValues`). So the same rep can show different achievement on the
admin dashboard vs the portal.

**Failure mode:** when a rep legitimately has >1 row for the same (territory, period, product) —
e.g. two Retail blocks for one area — sales sum but target keeps only the larger block, so
achievement inflates (~2x). Confirmed 2026-07-17 with a Pedia S1 upload: rep PD-0005 "Alex Center"
(Momen ElHaddad, DSM B-74) had two Retail blocks; correct = 664,692 / 972,500 = **68.3%**, portal
showed ~**133%**. Normal reps are unaffected because target sits only on the Retail row (Stores/
Discount = 0), so max == sum for them. The "max" dedup was meant to absorb a target echoed across
the Retail/Stores/Discount rows of one product — it does not distinguish that from two genuinely
additive rows.

**Fix options:** (A) data — pre-aggregate the sheet to one row per rep/territory/period/product
(sum duplicate blocks) so every surface agrees; safe, no code change. (B) code — sum targets to
match `getSalesDashboard`; durable but touches DSM/NSM/CEO reporting, needs review + a blast-radius
check that no other line relies on the echoed-target dedup. High-stakes (employee performance /
possibly incentive). See [[sos-dashboard-rebuild-2026-07-02]], [[ceo-field-sales-parity]].

**UPDATE 2026-07-23 — FIXED (PR #1083):** option (B) landed. `addDistinctTargetValue`/
`sumDistinctTargetValues` in `src/lib/employee-portal/service.ts` now sum the DISTINCT target
values per key (dedup via a cent-rounded Set) — never a naive sum-with-duplicates (double-counts
an echoed target) and never a max (collapses genuinely-different additive targets). Covered by
`tests/portal-target-dedup.test.ts`. Verified live via test suite 2026-07-23. This was cited to
the owner as a concrete example of the "same employee, different numbers in different reports"
class of bug during the [[locationiq-geocode-provider]] session's data-consistency discussion.
