---
name: h1-2026-incentive-sales-analysis-engine
description: "The H1-2026 incentive sales-analysis engine lives OUTSIDE the repo, and why its grain must stay area x LINE"
metadata: 
  node_type: memory
  type: project
  originSessionId: c645bb6e-3a43-44eb-bfcd-d8542450a490
  modified: 2026-08-12T07:44:25.919Z
---

Built 2026-08-12 at the owner's instruction, deliberately **outside** the Phoenix repo:
`C:\Users\satoh\Downloads\incentive-analysis\` (`engine.py`, `analysis.py`, `fraud.py`,
`quality.py`, `workbook.py`) → writes `H1-2026 Sales Analysis.xlsx`, **5 tabs: Summary,
then ONE TAB PER LINE (CNS / Pedia / Anti Infective), then Fraud Flags.** He rejected an
18-tab first version, asked for 2-3, then asked for a tab per line — the register stays
single with a Line column. Re-run with `python engine.py`; it never writes to the source.
Phase 2 (his salaries → incentive) lands on each line tab's semester rows, which already
carry live 2026-curve formulas.

**His rule, and the single most important fact here: NEVER merge an area across lines.**
The grain is **area × line** = 135 territories, not 58 areas. "Down town CNS" and
"Down town Pedia" are different people with different targets. The first build merged them
and got it wrong in both directions:

- It **manufactured** a fake 221.6% for Fayoum (→ 220% payout, the 150% cap) by dividing
  Fayoum's CNS sales by its Pedia-only target. Split by line: Fayoum Pedia is an honest
  112.7%, and Fayoum CNS + Anti Infective simply have no target. **Nothing is past the cap
  once split.**
- It **suppressed** real earned incentive. Paying territories went 4 → 18. Gharbia (Mahalla)
  Pedia is 146.9% (210.6% payout) but read 85.1% merged → zero. Menoufia 1 Pedia 143.2%
  (199.6%) read 58.8% → zero. Merging costs reps money as often as it invents it.

Two more findings a later session must not re-derive:

**34.8% of all units — 239,895 of 689,168 across 2,072 rows — have no pharmacy name and no
code.** Mostly Stores (183,072) plus 46,649 Retail and 10,174 Discount. Any customer-level
metric MUST filter these out: collapsing them into one fallback id invented a pharmacy
holding 36% of an area and turned 52 of 59 areas "Critical". They are volume, not a customer.

**22 territories carry no target at all and 16 have target coverage under 80% of what they
sell**, so their achievement is arithmetic rather than performance. The workbook shows the
payout twice — reported and targeted-products-only — with the EGP difference.

Also: the two source sheets disagree by line and month (Anti Infective Jan+Feb −11,786
units, CNS Feb +50,121, Pedia Feb −20,437); CNS targets are identical Apr=May=Jun for all
41 CNS areas; customer base fell 11.0% Jan→Jun (13,885 → 12,360); 76 territories declining
against 30 growing; company achievement 59.96%, which pays nothing.

**Why:** he asked for the analysis engine first and salaries second, so these achievement
figures will be paid on.

**How to apply:** before the salary phase, get his ruling on whether a territory whose
target covers only part of what it sells is paid on reported or targeted-only achievement.
Both columns are already in the workbook. And never re-aggregate to area level to "simplify"
a view — see [[sos-always-todays-geography-rule]] for the neighbouring per-line trap in
`au.line_area_map`.
