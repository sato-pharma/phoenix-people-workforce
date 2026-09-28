---
name: monthly-closing-audit-2026-08-04
description: "Monthly Closing was deep-audited on the owner's 'I do not trust the numbers': the ENGINE is exact to the piastre at every level (raw import rows == fact_rollup == the sheet, retail + direct == master, delta 0.00) — a low month is short of distributor INPUTS, not miscalculated, so verify the inputs before hunting a calc bug. Records the durable rulings and mechanisms: region grouping is organogram-driven only via CLOSING_ORGANOGRAM_REGION_LINES (anti_infective only — adding a line restates its subtotals, ask first), the isDirect net-zero-redistribution trap, Head Office is not closeable, achievement is additive across channels, and an unstamped direct order counts in no month."
metadata:
  node_type: memory
  type: project
  originSessionId: 03cc2804-3d96-4252-be34-4b96ec5c0d6f
  modified: 2026-09-26T01:41:08.778Z
---

## The verdict — the engine is exact, a low month is short of INPUTS

Owner: *"I do not trust the numbers in the Monthly Closing."* Two independent passes proved **nothing is
miscalculated**: an independent SQL recompute == `phx_monthly_closing_matrix` + `phx_monthly_closing_direct`
== the sheet to the piastre on all four lines (the two RPCs are disjoint — no double count); and at
sub-aggregate level, raw `source_of_sales_import_rows` == `fact_rollup` on every line-month, **the
distributor files' own value column == the closing's value with delta 0.00**, only `validated` batches
exist, and there is zero leakage through unknown areas, missing/inactive/mispriced products or orphan
targets.

🔴 **So when a month looks low, the cause is almost always that distributor files have not been sent —
NOT a data-entry backlog and not a broken engine** (owner confirmed for July 2026: the distributors simply
hadn't sent ~14 of 18 files). **Verify the input coverage before hunting a calc bug.** A distributor's
"Net" column is its own selling value; units match the closing but EGP differs **by design** — the closing
re-values every row at factory price.

## 🔴 The one real number bug that hid — always build a THIRD check

`applyStoreSplitToMatrix` skipped every area flagged `isDirect`, but that flag marks BOTH the synthetic
"Direct orders (company)" pseudo-area (areaCode `DIRECT`) AND real areas that absorbed hand-mapped direct.
For those real areas the money left its origin and never arrived, so a **net-zero redistribution silently
moved the grand total.** Fixed by identifying the synthetic row by **`areaCode`**, never by the flag (as
`monthly-closing-export` already did). **Pedia and CNS both tied at 0.00 and hid it completely — only Anti
Infective combines organogram regrouping + direct + stores. LESSON: two lines agreeing proves nothing;
always build a third, independent check.**

## 🔴 Region grouping is organogram-driven, and gated to Anti Infective only

The closing groups areas into regions by the **organogram** (seat model), and sales AND targets travel
with an area — so a regrouping moves two regions in opposite directions. This is consulted through
`CLOSING_ORGANOGRAM_REGION_LINES` (**`anti_infective` only**), read BEFORE `loadLineOperationalRegions` at
BOTH call sites (loaded month + empty skeleton) so the area grouping and the direct allocation — which read
the same map — can never disagree. 🔴 **Adding a line to that set restates its region subtotals — ask the
owner first.** (`git log -S` finds no commit that ever added this constant before this work, despite an
older memory note claiming it existed — verify such claims against the log.)

## Head Office is NOT closeable

The closing strips `LA003`/`LA004`/`SS001`, which *is* the Head Office line, so HO's "closing" is a
near-zero figure against real money. HO is excluded in `selectClosingLines` (pure + exported, so it is
executable, not just described); every closing surface inherits it, `?line=Head Office` falls back to a
real line, and the picker is exactly `["Anti Infective","CNS","Pedia"]`. 🔴 **`sos-report-delivery`
DELIBERATELY keeps HO** (`includeHeadOffice: true`) — it asks "is every line published", and dropping HO
would relax a scheduled email's gate. Consequence worth remembering: that email is gated on Head Office
being published, which **can never happen, so it can never fire.**

## Durable owner rulings and design facts

- **Achievement is ADDITIVE across channels** — no channel carries its own target, so retail and direct
  both divide by the same whole-month target, and retail Ach% + direct Ach% = the master's Ach%. All
  contribution columns read **Contr%** (a bare `%` beside "Ach %" gets misread as a second achievement).
- **Retail + Direct = master, difference 0.00** on every line, filtered or not. A filtered master that
  still carries area-less direct names it "Direct outside this filter" so the Difference stays 0.
- 🔴 **An unstamped direct order counts in NO month** until Finance (Ahmed El Maraghy) stamps one — do not
  nag, and **booking one into a reported month restates that month AND trips the July hand-map guard**,
  reverting the per-area layout. A booked area/unit reversal **stays as booked**, made visible on the
  Closing Corrections page (`/sales/closing-corrections`) rather than silently re-applied.
- **The screen matrix is UNSPLIT while the download is store-SPLIT — the owner's design, undocumented on
  screen.** The Total tab's per-area grid is PRE-split while the Closing Matrix is POST-split; only the
  Store Split tabs bridge them. Do not "fix" screen and download to agree.
- **Known, pre-existing, owner-to-review:** several صيدلية-named customers (صيدلية تكنوفارم ايجيبت,
  صيدلية الجمعيه التعاونية…) are classified as STORES and therefore split — a long-standing rule the Store
  Split Detail tab merely made visible for the first time.

## Traps that cost real time

- **Excel formula references (`D10`, `D11`) look exactly like area codes to a regex** — verify before
  reporting a filter leak.
- **Source-inspection and totals checks cannot see a wrong SENTENCE** — a workbook's "no customer identity"
  note was only found by BUILDING the workbook and reading it. Verify the emitted artifact, not the source.
- **A test that asserts on SOURCE TEXT never runs the code** — extract the rule as a pure exported function
  so the test executes it (a coverage gate is right to flag the source-text assertion).
- **`grep -c` exits 1 when the count is 0**, silently killing an `&&` chain — a zero count reads as a gate
  failure when it is the good news.
- **A test fixture missing one required field passes at runtime and fails only typecheck.**
- **`gh pr update-branch` puts the merge commit on the REMOTE** — merge `origin/<branch>` locally FIRST or
  the next push is rejected non-fast-forward.

Related: [[july-2026-direct-sheet-incomplete-3-of-8-regions]] · [[direct-order-sales-month-is-finance-owned]] ·
[[store-sales-split-evenly-across-city-areas]] · [[direct-order-pricing-rule-locked]] ·
[[closing-matrix-inclusion-rule]] · [[manual-closing-audit-sos-source-gap]]
