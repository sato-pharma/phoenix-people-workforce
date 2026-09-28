---
name: sos-monthly-closing-is-the-only-sales-truth
description: "OWNER'S #1 GOLDEN RULE: the Monthly Closing module is the ONLY source of truth for any SALES *and* any TARGET figure, everywhere in the system (targets confirmed 2026-09-27). The same person's same month must read identically in every place in his account, and equal the PUBLISHED closing. Weekly Sales excluded; Marketing ROI is the one legitimate exception. ALSO: a PUBLISHED closing is FROZEN - never correct a month people have already seen; apply every fix from the current month forward."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a86a1018-7cfd-4213-bb15-478c4eefca91
  modified: 2026-09-26T21:12:00.834Z
---

**Stated by the owner 2026-08-13 as his number-one golden rule, to be kept at the top of memory and
never trimmed or forgotten.**

## TARGETS TOO, AND EVERYWHERE — reaffirmed 2026-09-27

**"Your source of truth to calculate any sales any targets is the monthclosing module. Lock this
golden rule everywhere in system."** His words, in full.

The rule was always "any sales figure"; he has now made **targets** explicit and equal in weight.
The Monthly Closing module is the single source of truth for **both halves of every achievement**:
the sales *and* the target it is divided by. No surface may read a target from its own table,
its own period convention, or a live re-derivation that can diverge from the closing — Sales vs
Target, overviews, portal landings, command centres, incentive achievement, Employee 360, and the
Business Review all included. An achievement shown anywhere must equal what the closing produces for
that person and month.

**What triggered the reaffirmation:** on the Business Review, CNS areas showed 150%+ achievement two
months into a six-month semester. Traced to source, it was NOT a review bug — a large **August
`Office` (stores) pool** spread across every area by the locked office-allocation golden rule lifted
all areas ~2×, and August is a PUBLISHED month. The review was faithfully reflecting the closing.
The lesson he drew: since the closing is the only truth, every surface must read *it* — and it must
carry the target basis too, so a partial-window or per-page target can never inflate an achievement.
See [[owner-office-allocation-rule-value-share]], [[never-fix-a-published-and-announced-month]].

There are exactly **two trusted sources of sales**: the **Source of Sales module** and the
**Direct Orders module**. Both push their sales into **Monthly Closing, per brick**. That closing is
the single canonical sales figure.

**Therefore: any sales figure shown anywhere in the system, for any user, must be pulled from the SoS
Monthly Closing.** Sales vs Target, overviews, portal landings, command centers, incentive
achievement, Employee 360 — all of them read the same closing. No page may re-derive sales from its
own query, its own table, or its own period convention.

**The invariant, in his words:** *never a mismatch of sales for the same person in two places in his
account.* If July is 70% in Monthly Closing, then July is **exactly** 70% everywhere else in that
person's account. Not 69.8%, not a different period basis that happens to look close.

**Scope confirmed 2026-08-13: EVERY surface, no per-engine exemptions.** Asked specifically whether
the vs-target engine's *covered-actual ÷ target* basis could count as its own truth alongside
closing, he answered "not only sales vs target but any other". So there is no surface that gets to
keep its own sales math on the grounds that its engine is different — vs-target included. An engine
whose number cannot be made to equal the closing figure is a thing to fix, not a variant to
document. The only two carve-outs are the ones below; do not invent a third.

## A PUBLISHED CLOSING IS FROZEN — owner rule, 2026-08-27

**"ONCE PUBLISHED AND PEOPLE NOTICED NEVER CHANGE NUMBERS START FROM AUG."** His words, in full.

When a closing has been published and people have already seen their numbers, those numbers are
**final — even when they are wrong**. A discovered defect is fixed **from the current month forward**,
never by re-deriving a month people have read. This is not in tension with the golden rule above: the
invariant is that every surface agrees with the closing, and the closing is whatever was published.

**Why:** a rep who was shown 70% and is later shown 68% has no way to tell a correction from an
error, and the platform loses the argument either way. Trust in a stable number outranks accuracy in
a revised one. He has already had to defend these figures to the people they pay.

**How to apply:**
- Before ANY data repair on sales, check whether the month was published. `monthly_closing_locks`
  (where `unlocked_at is null`) is the mechanical signal; the trigger
  `phx_reject_write_to_locked_closing()` raises `23514` and rolls the whole statement back.
- **A lock refusing your write is the rule working, not an obstacle to route around.** Do not propose
  an unlock to "finish the job", and do not treat a still-broken published month as pending work.
- The fix belongs in the CODE PATH that produced the defect, so the next upload is right. That is
  what "start from Aug" means — preventive, not retrospective.
- Worked example: 2026-07 CNS carries 112 customers / EGP 47,385 that reached no rep. It stays that
  way permanently; the cause was fixed in the importer instead. See
  [[main-store-otms-is-a-real-area-outside-the-organogram]].
- The one thing that is always allowed: a change that moves **zero numbers**. Filling a blank brick
  whose area was already correct is bookkeeping, not a revision — but prove `area_before = area_after`
  row by row before calling it that.

**Two carve-outs, both deliberate:**

- **Weekly Sales is excluded from this rule.** He named it explicitly. It is distributor sell-out
  (units + stock, de-cumulated), a different question from "what did this person sell", and it is not
  a sales-truth source. See [[weekly-sales-has-no-area-grain]].
- **Marketing ROI is the one legitimate exception.** It pulls its sales from the **pharmacy codes
  submitted in the request**, not from the person's territory rollup. Its denominator is the promoted
  products at those specific pharmacies, so it will not and should not match a rep's closing figure.
  This is correct, not a bug — do not "fix" it into agreement.

**Why:** real employees' incentive money is computed from these numbers. Two different percentages
for the same person and month destroys trust in the whole platform faster than a wrong number does —
he cannot defend a figure he cannot reproduce. This is why it outranks convenience or per-page
caching.

**How to apply:**
- Before building or changing ANY surface that renders a sales figure, find which engine it reads.
  If it is not the closing / vs-target engine, that is the bug — fix the source, not the display.
- The known offenders as of the 2026-08-13 audit: `sales_records` / `v_employee_portal_sales` is a
  **second, legacy pipeline** (~11K rows vs SoS's ~306K) still feeding `/sales/monthly-dashboard`,
  Employee 360, the portal MR hero card, and the exec KPI tiles on `/admin`, `/admin/ceo-command-center`
  and `/admin/sfe-command-center`. It can and does publish different numbers for the same rep and
  month than the SoS engine does. Retiring it is the work this rule implies.
  - ✅ **DONE — re-verified 2026-09-05. That retirement is COMPLETE; do not go looking for it again.**
    Every one of the four named surfaces now reads the closing, through `dashboard-canonical.ts`
    (wired into `admin/service.ts`, so the exec KPI tiles too), `employee-360/sales-canonical.ts`
    and `employee-portal/portal-sales-canonical.ts`. Proof is a grep for real QUERY calls rather
    than mentions — `.from("sales_records")` / `readAllSupabaseRows(..., "sales_records")` — which
    survives only in `src/lib/sales/service.ts`, and only for the legacy import queue
    (`listSalesHistory`/`listSalesQueue` behind `/sales/import`), duplicate detection and a delete
    guard. **`v_employee_portal_sales` is read by NOTHING** — a fully orphaned view.
    **`getSalesBatchDetail` is a dead export** with no caller.
  - 🔴 **The table is KEPT ON PURPOSE — never "finish the job" by dropping it.** It holds 11,267
    rows, **Jan–Jun 2026 only** (SoS runs to Aug), and `assertSalesBatchHoldsNoFrozenRecords` blocks
    deleting them because it is *"the only record of what H1 2026 was actually paid on"* and
    production has no PITR. Its staleness is therefore harmless rather than a defect: nothing
    renders a figure from it, so it cannot disagree with the closing about anybody.
- Three incompatible period conventions coexist and each produces a different achievement % for one
  rep: **current calendar month** (portal MR hero, via `v_employee_portal_sales`), **declared
  semester** (Incentive tab), and **cumulative since 2026-07** (DSM/NSM/RM manager keycards, labelled
  "this period"). Under this rule they must resolve to the closing's basis.
- `getSalesDashboard({})` is **cumulative across all active batches** while
  `loadSourceOfSalesDashboard(null, …)` is **one month** — the CEO and SFE command centers currently
  show both side by side on one screen.
- Related: [[portal-performance-sourced-from-sos-targets]] (performance pages were already moved onto
  the SoS + targets engine in PR #1962 — that migration is the pattern to follow, and it is unfinished),
  [[owner-office-allocation-rule-value-share]], [[closing-retail-value-is-units-times-factory-price]],
  [[semester-1-incentive-three-layers]].
