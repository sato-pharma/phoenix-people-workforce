---
name: achievement-numerator-is-covered-actual-not-all-sales
description: "Achievement is COVERED actual over target in Business Review and the Targets pages — never all sales over target — and a percentage can only be re-aggregated by summing the parts it divides. Seven live sites had it wrong across three modules. BUT THE MONTHLY CLOSING IS THE EXPLICIT EXCEPTION: the owner ruled 2026-09-05 that the closing divides ALL sales by target. Read the exception before 'fixing' any closing surface."
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e92ac6c-8bb7-4d65-855c-6c7ae9cf22de
  modified: 2026-09-20T23:59:06.196Z
---

`au.f_monthly_achievement` grades on **covered actual**: the money sitting on a `(line, area,
product)` key that HAS a target row. `VsTargetTotals` (`src/lib/sales/vs-target.ts`) carries it as
`coveredActualValue`, commented "the only actual achievement % uses", beside `actualValue` (every
row) and `uncoveredActualValue` (sales nobody set a target for). Sales with no target are real money
and belong in the value columns — they must never lift a percentage against a denominator they were
never part of.

**The rule that makes this bite: a percentage cannot be re-aggregated — only the parts it divides
can.** Any code summing children into a parent (SKU→family, area→district, line→company, area→"my
districts") must divide `sum(covered)` by `sum(target)`. `sum(sales)/sum(target)` is silently
identical in a window where every product has a target, and badly wrong in one where something does
not — so it survives review and ships.

Found live 2026-08-23 in Business Review. Every line, area, district and rep was right (they read the
engine's own `achievementValue`); **all four re-aggregation sites were wrong**, because `sliceOf`
computed `coveredActualValue` and then dropped it, leaving no numerator for anyone downstream to
divide. Measured against prod (`ozucdzovmcqvepbozvqf`) over the default Jan–Aug 2026 window:

| | EGP |
|---|---|
| sales (all rows) | 76,155,653 |
| covered (rows with a target) | 29,516,034 |
| target | 58,255,860 |

`sales/target` = **130.73%** — what the page showed. `covered/target` = **50.67%** — what it means.
Per line the same error read Pedia 234.33% instead of 78.32%, CNS 112.64% instead of 50.87%,
Anti-Infective 153.74% instead of 38.05%. Eighty points, in the flattering direction, on the first
number of a page built to be read in front of a head of department, disagreeing with every figure
under it. It reads that badly right now only because **Mar–Jun 2026 carry ~43.5M EGP of sales and no
target row at all** ([[one-direct-order-makes-a-month-look-uploaded]] is the adjacent trap on the
other side of the same window).

**Payouts were never affected** — `payoutPercentageFor`/`bandFor` are only ever fed district and area
slices, which come straight from the engine.

**Why:** the display type (`Slice`) modelled sales, target and the percentage, but not the numerator
the percentage actually used, so correct re-aggregation was not expressible.

**How to apply:** `Slice` now carries `covered`; `tests/business-review-achievement-arithmetic.test.ts`
pins all four sites (10 mutations, 10 caught) and the workbook captions. Before writing any new
rollup of achievement anywhere in the repo, check whether the type you are summing carries its own
numerator — if it does not, add it rather than reaching for the sales column. Note
[[semester-1-incentive-three-layers]] recorded the OLD rule ("company achievement =
sum(sales)/sum(target)") as though it were correct; that line is now corrected in place.

## It was never only Business Review — three modules, seven sites

Grepping every achievement division in the repo on 2026-08-23 found the same defect in two more
places. Both are fixed in PR #2305 (branch `codex/targets-covered-achievement`).

**`foldAchievement` in `src/lib/sales/monthly-targets.ts`** — ONE fold behind BOTH Targets views
(admin `/sales/targets` and the portal Targets tab), rolling up to line, region and DM. This was the
worst of the three, because the DM grain aggregates whole untargeted product lines:

| | read | means |
|---|---|---|
| Pedia 2026-02 | 67.99% | 35.71% |
| Anti-infective 2026-07 | 85.12% | 60.41% |
| **one DM, 2026-07** | **48.5%** | **2.2%** |

Seven of twelve DMs with a July target were overstated. The 46-point one is the shape of the whole
bug: a manager reviewed on his own number looked two-thirds of the way to par while almost everything
he sold sat outside his target.

**`src/lib/analytics/service.ts`** — the Monthly Closing rep bucket at `(period, line, rep)`, feeding
three dashboards. Same formula, much smaller effect: worst 4.1 points, 0–4 rows a month, because a rep
with untargeted sales usually still holds a target for that line. Fixed anyway —
[[sos-monthly-closing-is-the-only-sales-truth]]. **That path is GONE — the whole Sales Analytics
module was retired on 2026-09-17 (`9f31a4e1b`, #3911), so this bucket is history, not somewhere to
go looking.** The three live sites above (`vs-target.ts`, `monthly-targets.ts`, the closing engine)
are the ones that still matter.

**`coveredActualValue` is NOT bounded above by `actualValue`.** Returns and credits arrive as negative
rows and can be uncovered, so an untargeted return makes covered the LARGER figure — CNS January 2026
is exactly that (covered 5,616,281 vs actual 5,615,821). Never add a `Math.min` clamp; both numbers
are right.

**Fixing the arithmetic alone leaves the page looking broken**, because the card then prints an Actual
and a Target that do not divide into the Achievement beside them. Both Targets pages now thread the
graded slice into the UI ("Graded vs target" / "Not graded (no target)", shown only when they differ;
the region and DM percentages carry the division in a `title` because those rows may not wrap).

`tests/targets-rollup-achievement.test.ts` pins all of it — 12 mutations, 12 caught, and mutation 8
found a hole in the test itself: an `includes` guard survived deleting one of the two rollup mappings
per page, so it counts occurrences now.

## 🔴 THE MONTHLY CLOSING IS THE EXCEPTION — owner ruling, 2026-09-05

**The closing divides ALL sales by target. Do NOT bring it onto covered-actual.** He was shown both
numbers for August's Anti Infective and answered: *"THE OLD CLOSING IS THE CORRECT ONE."*

The two definitions had split the Monthly Closing from the Premium Monthly Closing. Value and units
always tied exactly (5,271 units / 477,498.95 EGP — 442,520.05 distributor + 34,978.90 direct, which
`analytics.closing_by_line` confirms); only the percentage differed: **31.78% on the closing vs
29.95% on the premium**, 1.83 points on **27,529.80 EGP over 24 area × product pairs that carry no
target row**. The premium engine had been built on the false premise that covered-actual "is the
arithmetic the Closing Matrix uses" — `closingAchievement` (`monthly-closing-matrix-cells.ts`)
divides `salesValue / targetValue` at every level and always has.

Fixed the premium's way onto the closing's rule in PR #3222 (`codex/closing-ach-all-sales`), NOT the
reverse — the auditor's export is frozen and was untouched.

**The rule also lives in FOUR formulas inside the owner's `template.xlsm`**, not only in TypeScript:
the `Ach` and `Units Ach` pivot calculated fields plus the Rep Card's two divisions. A TS-only change
leaves the pivot pages on the old rule; and `scripts/build-closing-engine-template.mjs` regenerates
that binary from whatever source workbook it is handed, so a rebuild from his older copy silently
restores it. `tests/closing-achievement-follows-the-closing.test.ts` reads the shipped artifact to
catch that, and uses a **MIXED area** (one targeted product, one untargeted) — the only shape that
separates the two rules, and the shape the older premium fixture lacks entirely, which is why the
suite stayed green across the change in both directions.

**Only the numerator ever moved.** No/zero target still yields no percentage, never 0%, so an
untargeted area is still listed, counted in totals, and never ranked or scored — in both modules.

**Why both rules are right where they sit:** Business Review and the Targets pages grade a PERSON
against their own target, where untargeted money must not flatter them. The closing states a LINE's
total money against the line's total target, and its masthead has to divide as it reads (B5 ÷ D5 =
F5). Route by which question the surface answers, never by "the repo's achievement rule".

Related: [[sales-vs-target-cost-is-inside-au-monthly-attribution]],
[[never-silent-drop-count-and-flag-instead]], [[h1-2026-incentive-sales-analysis-engine]],
[[sos-monthly-closing-is-the-only-sales-truth]].

## ⚠ SALES VS TARGET MOVED TO A THIRD NUMERATOR — GRADED, 2026-09-05

Found 2026-09-08 auditing El Qema. `src/lib/sales/vs-target.ts` no longer divides covered actual.
`sealTotals` divides **`gradedActual`**, and its own comment records the change: *"They divided the
COVERED actual until 2026-09-05, which is what made this screen disagree with the Monthly Closing."*

**Graded is neither of the other two.** `addRow` keys it on the PERIOD, not the row's own target —
"a row with no target of its own still counts when the group was targeted that month". So a row on
an area carrying no target still lifts the percentage, as long as that group held some target that
month. `coveredActualValue`/`uncoveredActualValue` are still computed, but only `coverageRatio()`
reads them now.

So there are THREE numerators live, not two, and the section above names only two:

| Surface | Numerator |
|---|---|
| Business Review, Targets pages (`foldAchievement`) | covered actual |
| Monthly Closing / premium | all sales |
| **Sales vs Target (`vs-target.ts`)** | **graded actual** |

**Why it matters:** graded and all-sales coincide whenever the group holds any target for the month,
which is the normal case — so Sales vs Target now agrees with the closing almost always, and the
divergence only appears in a month a group was never targeted. A session predicting this screen from
the covered-actual rule above will read a percentage as a bug and "fix" a screen that is correct.

**How to apply:** route by SURFACE, not by "the repo's achievement rule" — and read `sealTotals`
before asserting what any of them divides. Measured case: August 2026 Pedia CA5 (Down town) carries
1,010.69 units against no target row at all; it counts in the Sales vs Target numerator and would not
have under the pre-09-05 rule. See [[a-pharmacy-is-not-a-contact]] for the adjacent
"read the field, not the name" habit.
