---
name: achievement-numerator-is-covered-actual-not-all-sales
description: "Achievement has THREE live numerators, routed by SURFACE, never by 'the repo's achievement rule': Business Review + the Targets pages grade on COVERED actual, the Monthly Closing/premium divides ALL sales by target (owner ruling 2026-09-05, 'THE OLD CLOSING IS THE CORRECT ONE'), and Sales vs Target (vs-target.ts sealTotals) divides GRADED actual (keyed on the period, not the row's own target). The arithmetic rule that ties them: a percentage cannot be re-aggregated — a rollup must sum the numerator it divides, never sum(sales)/sum(target)."
metadata:
  node_type: memory
  type: project
  originSessionId: 1e92ac6c-8bb7-4d65-855c-6c7ae9cf22de
  modified: 2026-09-26T00:42:27.270Z
---

## The three numerators — route by SURFACE

| Surface | Numerator | Where |
|---|---|---|
| Business Review, both Targets pages | **covered actual** | `foldAchievement` (`monthly-targets.ts`), `vs-target.ts` `coveredActualValue` |
| Monthly Closing / Premium Closing | **all sales** | `closingAchievement` (`monthly-closing-matrix-cells.ts`) — `salesValue / targetValue` |
| Sales vs Target | **graded actual** | `vs-target.ts` `sealTotals` (since 2026-09-05) |

**Route by which question the surface answers, never by "the repo's achievement rule," and read the
code before asserting what any of them divides.** Business Review and Targets grade a PERSON against
their own target, so untargeted money must not flatter them. The closing states a LINE's total money
against the line's total target, and its masthead must divide as it reads (B5 ÷ D5 = F5). Sales vs
Target grades on **graded** actual, which is keyed on the **period, not the row's own target** — a row on
an area with no target of its own still counts as long as its group held *some* target that month.

Graded and all-sales coincide whenever the group holds any target for the month (the normal case), so
Sales vs Target agrees with the closing almost always; the divergence appears only in a month a group was
never targeted. A session predicting a screen from the covered-actual rule alone will read a correct
percentage as a bug and "fix" a screen that is right.

## Covered actual — the rule and the arithmetic

`au.f_monthly_achievement` grades on **covered actual**: money on a `(line, area, product)` key that HAS
a target row. `VsTargetTotals` carries it as `coveredActualValue` beside `actualValue` (every row) and
`uncoveredActualValue` (sales nobody targeted). Untargeted sales are real money and belong in the value
columns — they must never lift a percentage against a denominator they were never part of.

🔴 **A percentage cannot be re-aggregated — only the parts it divides can.** Any rollup of children into a
parent (SKU→family, area→district, line→company, area→"my districts") must divide **`sum(covered)` /
`sum(target)`**. `sum(sales)/sum(target)` is silently identical in a window where every product has a
target and badly wrong (in the flattering direction) where something does not — so it passes review and
ships. This was live across the Business Review rollups and `foldAchievement` because the display type
modelled sales/target/percentage but not the *numerator the percentage used*, so correct re-aggregation
wasn't expressible. **Before writing any new achievement rollup anywhere, check whether the type you are
summing carries its own numerator — if not, ADD it rather than reaching for the sales column.** Pinned by
`tests/business-review-achievement-arithmetic.test.ts` and `tests/targets-rollup-achievement.test.ts`.

- 🔴 **`coveredActualValue` is NOT bounded above by `actualValue`.** Returns/credits arrive as negative
  rows and can be uncovered, so an untargeted return can make **covered the LARGER** figure. **Never add
  a `Math.min` clamp — both numbers are right.**
- **Fixing the arithmetic alone leaves the page looking broken** (Actual and Target no longer divide into
  the Achievement beside them), so both Targets pages thread the graded slice into the UI ("Graded vs
  target" / "Not graded (no target)", shown only when they differ).
- **Payouts were never affected** — `payoutPercentageFor`/`bandFor` are only ever fed district/area
  slices, which come straight from the engine.

## 🔴 The Monthly Closing is the EXCEPTION — owner ruling 2026-09-05

**The closing divides ALL sales by target. Do NOT bring it onto covered-actual.** Shown both numbers for
August's Anti Infective, the owner answered *"THE OLD CLOSING IS THE CORRECT ONE."* The premium engine had
wrongly assumed covered-actual "is the arithmetic the Closing Matrix uses"; the fix moved the premium onto
the closing's rule, NOT the reverse (the auditor's frozen export was untouched).

🔴 **The closing rule also lives in FOUR formulas inside the owner's `template.xlsm`** — the `Ach` and
`Units Ach` pivot calculated fields plus the Rep Card's two divisions. A TS-only change leaves the pivot
pages on the old rule, and `scripts/build-closing-engine-template.mjs` regenerates that binary from
whatever source workbook it is handed, so a rebuild from an older copy silently restores it.
`tests/closing-achievement-follows-the-closing.test.ts` reads the shipped artifact and uses a **MIXED
area** (one targeted product, one untargeted) — the only shape that separates the two rules, and the
shape older premium fixtures lack, which is why the suite could stay green across a change in either
direction.

**In every module, only the numerator ever moves** — no/zero target still yields **no percentage, never
0%**, so an untargeted area is still listed, counted in totals, and never ranked or scored.

## The retired path — don't go looking there

The old Monthly Closing rep bucket in `src/lib/analytics/service.ts` had the same defect, but the whole
Sales Analytics module was **retired 2026-09-17**, so that bucket is history. The three live surfaces are
`vs-target.ts`, `monthly-targets.ts` and the closing engine. Note [[semester-1-incentive-three-layers]]
once recorded the OLD rule ("company achievement = sum(sales)/sum(target)") as correct — corrected in
place.

Related: [[sos-monthly-closing-is-the-only-sales-truth]], [[one-direct-order-makes-a-month-look-uploaded]],
[[sales-vs-target-cost-is-inside-au-monthly-attribution]], [[never-silent-drop-count-and-flag-instead]],
[[h1-2026-incentive-sales-analysis-engine]], [[a-pharmacy-is-not-a-contact]].
