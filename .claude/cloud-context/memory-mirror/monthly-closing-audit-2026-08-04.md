---
name: monthly-closing-audit-2026-08-04
description: "Monthly Closing deep audit + the 2026-08-05 workbook wave. Verdict: the ENGINE is exact at every level; July is short of INPUTS. Records 7 shipped PRs, every owner ruling, and the traps that cost real time."
metadata: 
  node_type: memory
  type: project
  originSessionId: 03cc2804-3d96-4252-be34-4b96ec5c0d6f
  modified: 2026-08-05T10:49:53.536Z
---

Owner: "I do not trust the numbers in the Monthly Closing." Audited 2026-08-04, deepened and
rebuilt 08-05. Production `ozucdzovmcqvepbozvqf`.

## THE VERDICT — the engine is exact, the inputs are short

**Nothing is miscalculated.** Two independent passes:

1. **Aggregate:** independent SQL recompute == `phx_monthly_closing_matrix` + `phx_monthly_closing_direct`
   == the sheet, to the piastre, on all 4 lines for 2026-07 (Pedia 869,211.00 + 534,713.65 · Anti
   462,905.55 + 93,554.00 · CNS 1,484,178.10 · HO 546.00). No double count (the two RPCs are
   disjoint; June Direct batch 2,122,106.29 = Pedia 1,797,513.79 + Anti 324,592.50 exactly).
2. **Sub-aggregate (08-05):** raw `source_of_sales_import_rows` == `fact_rollup` on all 8
   line-months (rows, units, effective units); **the distributor files' own value column ==
   the closing's value, delta 0.00 on every line both months**; only `validated` batches exist (no
   duplicates, no stuck uploads); zero leakage through unknown areas, missing/inactive/mispriced
   products, or orphan targets; the July direct hand-map ties per PRODUCT (all 6 exact).

**July looks low because 14 of 18 distributor files have not been sent** (owner confirmed 08-05:
*not* a data-entry backlog — the distributors haven't sent them). June-scale of the gap ≈ 11.1M.
The two "PAS" files the owner holds are Ibn Sina-Sato June (1,066 rows/4,268u) and July
(952 rows/2,691u) — both already uploaded, reconciled ROW-EXACT, nothing new in them. Their "Net"
column is the distributor's selling value; units match, EGP differs by design (closing re-values at
factory price).

## SHIPPED 2026-08-04/05 — all live and verified

| PR | What | Live |
| --- | --- | --- |
| #1734 | **Source Coverage** tab + amber banner: which source files fed this month vs last, and what is missing | `314bc34b` |
| (other session) | store-split cells reverting on Excel recalc | merged 08-05 |
| #1742 | **Closing Corrections** page (`/sales/closing-corrections`) | `3da64eb2` |
| #1743 | **Retail / Direct channel tabs**, additive Ach%, Contr% labels | `0210ea89` |
| #1746 | empty Direct section must give the RIGHT reason | `6cf1250c` |
| #1752 | 🔴 **store split skipped real direct-absorbing areas** — a REAL number bug | `83a32c1a` |
| #1756 | Head Office + "IGNORE" sentinel out of the closing | `d3e87888` |
| #1760 | **Dashboard** tab 1 (EN/AR), **Store Split Detail**, Direct tab follows the filter | `d0b94f74` |

### The one real number bug (#1752) — and why it hid
Anti Infective 2026-07's downloaded master read **534,122.68 instead of 556,459.55** (−22,336.87,
with a fractional 5,824.5 units vs 6,047). `applyStoreSplitToMatrix` skipped every area flagged
`isDirect`, but that flag marks BOTH the synthetic "Direct orders (company)" pseudo-area (areaCode
`DIRECT`) AND — in July — REAL areas that absorbed hand-mapped direct (Kafr El-Sheikh 1, Menoufia 2,
Minia). For those the money left its origin and never arrived, so a **net-zero redistribution moved
the grand total**. Fixed by identifying the synthetic row by `areaCode`, as `monthly-closing-export`
already did. **Pedia and CNS both tied at 0.00 and hid it completely — only Anti Infective combines
organogram regrouping + direct + stores. LESSON: two lines agreeing proves nothing; always build a
third.**

### Workbook shape now (16 tabs)
Dashboard (tab 1, clickable + EN/AR) · Closing Matrix (master = total) · Retail Sales (no direct) ·
Direct Sales (no retail, incl. customer-by-customer) · Source Coverage · Target vs Achievement ·
Direct Orders (July) · Store Split · Store Split Detail · Distributor Comparison · Rankings & Mix ·
Gaps & White-Space · Summary & Insights · Data · Total · (Confidential when revealed) · hidden Calc.

- **Retail + Direct = master, difference 0.00** on every line, filtered or not.
- **Achievement is ADDITIVE**: no channel has its own target, so both divide by the same whole-month
  target — retail Ach% + direct Ach% = the master's (Pedia 07: 18.5% + 11.4% = 29.8%).
- All contribution columns read **Contr%** (a bare % beside "Ach %" was read as a second achievement).
- **The Direct tab was the ONLY tab that ignored the reader's filter** (a Delta-1 export listed
  GZ/D2/UE/OT at full value; every other tab was already correct — audited tab by tab). Now scoped
  to the matrix's surviving regions; the retail tab's quoted direct is narrowed identically; a
  filtered master that still carries area-less direct names it as "Direct outside this filter" so
  the Difference stays 0.

### Head Office is NOT closeable (#1756)
Its closing showed **546.00 against a real 50,965,312.08** with zero targets — the closing strips
LA003/LA004/SS001, which IS that line. Excluded in `selectClosingLines` (pure + exported, so it is
executable, not just described); every closing surface inherits it and `?line=Head Office` falls
back to a real line. **`sos-report-delivery` deliberately keeps it** (`includeHeadOffice: true`): it
asks "is every line published", and dropping it would relax a scheduled email's gate. The "IGNORE"
sentinel is dropped for everyone. Picker is now exactly `["Anti Infective","CNS","Pedia"]`.
(Side note worth its own task: that email is gated on Head Office being published, which can never
happen — so it can never fire.)

## 🔴 REGION GROUPING — the owner's second catch (#1764, live `1a5b8ab1`)
He said "Pedia alex-bhr / d2 / d1 look wrongly calculated" and was right on two of three. The
closing grouped areas by the **organogram** (the seat model) on EVERY line, not just Anti Infective.
Pedia moved 4 areas — **Kafr El-Sheikh 1 (D16) was being counted inside Alex-Behira**:

| region | sheet showed | truth (geography) |
| --- | --- | --- |
| AB | 186,580.13 / 20.3% | **178,503.75 / 24.1%** |
| D1 | 291,702.60 / 36.4% | **301,128.97 / 30.7%** |
| D2 | 254,271.38 / 28.4% | unchanged — never regrouped |

Sales AND targets travel with an area, so the two regions moved in OPPOSITE directions. CNS moved 7
(Down town→Giza, Fayoum→OT). **`CLOSING_ORGANOGRAM_REGION_LINES` never existed — `git log -S` finds
no commit that ever added it**, though a memory note claimed it did. It exists now (`anti_infective`
only) and is consulted BEFORE `loadLineOperationalRegions` is fetched, at BOTH call sites (loaded
month + empty skeleton), so the area grouping and the direct allocation — which read the same map —
cannot disagree. **Adding a line to that set restates its region subtotals: ask first.**

**🔴 Found while verifying, NOT fixed: CNS July targets cover only 6 of its 49 selling areas** —
the entire 2,498,649.72 sits on AB1–AB5 + D16, so CNS reads AB 14.1%, D1 92.6% and "—" everywhere
else. Pedia has 36 areas targeted, Anti Infective 30. A target-upload gap; needs the owner's call.

## Owner rulings 2026-08-05
- GZ4 ±400u reversal: **stays as booked**, but visible on the Closing Corrections page.
- Pedia July targets: **uploaded** (4,706,257.54, 144 cells, zero orphans).
- The 5 approved direct orders (177,124.80): **"skip"** — they count in NO month until Ahmed El
  Maraghy stamps one. Do not nag. Booking any into 2026-07 would restate a reported month AND trip
  the July hand-map guard, reverting the per-area layout.
- Head Office: **remove from the closing entirely** (chose this over a warning banner).

## Traps this cost real time on
- 🔴 **`gh pr update-branch` puts a merge commit on the REMOTE** — the local branch is then behind
  and the next push is rejected *non-fast-forward*. Merge `origin/<branch>` locally FIRST. Hit twice.
- 🔴 **A test that asserts on SOURCE TEXT never runs the code.** SonarQube's coverage gate caught it
  and was right; the rule was extracted as a pure exported function so the test executes it.
  (Sonar sits at 79.7% vs an 80% new-code threshold — advisory, not one of the 5 required checks.)
- 🔴 **`grep -c` exits 1 when the count is 0**, silently killing an `&&` chain — it looked like a
  gate failure when it was the good news that there were no conflict markers.
- 🔴 A test fixture missing one required field **passes at runtime and fails only typecheck**.
- 🔴 `sos-ui-truth` pinned a local variable NAME, not behaviour, and broke on a rename.
- 🔴 **Source-inspection and totals checks cannot see a wrong SENTENCE** — CNS's "no customer
  identity" note was only found by BUILDING the workbook and reading it.
- Excel formula references (`D10`, `D11`) look exactly like area codes to a regex — verify before
  reporting a filter leak.

## Still open
- **Store-vs-pharmacy classification**: several صيدلية-named customers are treated as STORES and
  therefore split (صيدلية تكنوفارم ايجيبت, صيدلية الجمعيه التعاونية…). Pre-existing rule, but the
  new Store Split Detail tab makes it visible for the first time — owner asked to review.
- `monthly_closing_publications` is EMPTY → the portal Monthly Closing shows "Awaiting publish".
- Total tab's per-area grid is PRE-split while the Closing Matrix is POST-split; only the Store
  Split tabs bridge them.
- The screen matrix is unsplit while the download is split (owner's design, undocumented on screen).

Related: [[july-2026-direct-sheet-incomplete-3-of-8-regions]] · [[direct-order-sales-month-is-finance-owned]] ·
[[store-sales-split-evenly-across-city-areas]] · [[direct-order-pricing-rule-locked]] ·
[[closing-matrix-inclusion-rule]] · [[manual-closing-audit-sos-source-gap]]
