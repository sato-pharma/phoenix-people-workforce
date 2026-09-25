---
name: manual-closing-audit-sos-source-gap
description: "Audit of owner's manual closing workbooks — engine is correct, but SoS source is missing IBNSINA for Anti/Pedia; blocks their cutover"
metadata: 
  node_type: memory
  type: project
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
  modified: 2026-08-05T22:31:50.100Z
---

Owner uploaded the real manual monthly-closing workbooks to `C:\Users\satoh\Downloads\CLOSING\` (Jan + Feb 2026, 3 lines: CNS, Pedia, Anti-Infective) and asked for a full audit to explain the automatic-vs-manual gap. More months to come.

**Manual workbook pipeline (per line):** `Data` (raw per-pharmacy sell-out, tagged Retail/**Stores**, with Distributor) → `Total` (pivot, applies factory price → value, splits Retail/Stores/Discount) → `STORE Calculation` (takes ONE bulk sell-in number per product and spreads it across areas by each area's retail-value share — a MODELED sell-in, not real data; e.g. Jan CNS Tebofortine Forte 80 Stores = 12,970) → `Formula`/`Sales Closing` (rep×product achievement). Also `Dist Analysis`, `Ranking`.

**The gap has TWO causes, on different sides:**
1. **Manual is inflated** by the modeled "Stores" sell-in (mainly CNS: Jan +22,718 u) + "Discount" bulk deals (Feb Pedia Ivyronc 20,000 u / 280,000). The automatic (sell-out) correctly excludes these.
2. **Automatic is starved of source data for Anti & Pedia** 🔴 — the SoS import has **NO IBNSINA rows** for those lines (only distributor "overseas" + Direct), while the manual pulls IBNSINA directly. So auto captures ~50% (Anti) / ~73% (Pedia) of real sell-out. CNS has full coverage incl. IBNSINA → reconciles.

**Proofs (units):** CNS Jan auto 57,429 ≈ manual Retail 56,388 (product-level match, e.g. Tebofortine 40mg 15,634 vs 15,688). Manual-vs-SoS distributor match: CNS manual IBNSINA 24,847 ≈ SoS "Ibn sina" 28,653; manual P.O.S 25,013 ≈ SoS "overseas" 24,983. Anti manual IBNSINA 4,011 = SoS absent; Pedia manual IBNSINA 2,620 = SoS absent.

**Key data-quality notes:** SoS distributor **"overseas" is really the manual's "P.O.S"** (mislabel). SoS distributor labels are inconsistent month-to-month (`Ibn sina` / `Ibn Sina-Sato` / `Ibn Sina Tender`; `Marcyrl` appears only Feb, ~47k u ≈ that month's bulk/stores order). Confidential LA003/LA004/SS001 correctly sit in the SoS "Head Office" line bucket (~149k u Jan) and are excluded — NOT the missing Anti/Pedia volume.

🟢 **UPDATE 2026-08-06 — the IBNSINA gap is CLOSED for Anti Infective.** Re-audited July 2026 Anti
against the owner's manual `Jul-2026 Sales Closing Anti-Infective Final.xlsx`: the SoS import now
carries IBNSINA (as distributor `IS-S`, 734 rows) alongside `PS`/overseas (1,031) and `EP-PHS` (5),
and **retail units match the manual EXACTLY: 4,897 = 4,897**, across 1,483 pharmacy×product pairs of
which only 6 differ (all from a blank pharmacy code in the manual that Phoenix filled in). Retail
value differs by only 80.75 EGP, and that is entirely the Royafloxacin price (Phoenix 60.75 vs
manual 60.70 × 1,615 units). **The retail channel is now safe to cut over for Anti Infective.** The
whole remaining gap is DIRECT orders — see [[july-2026-direct-sheet-incomplete-3-of-8-regions]].
Re-verify Pedia and CNS separately before assuming the same for them.

**Cutover implication (as of 2026-07-31, superseded for Anti above):** CNS automatic is trustworthy today. **Do NOT cut over Anti & Pedia** until the SoS import ingests IBNSINA (and EGD/EPDA) sell-out for those lines and distributor names are normalized. The fix is upstream in the SoS import, NOT in the attribution engine (engine is proven correct). See [[area-unification-42-areas-design]], [[sos-brick-authoritative-geography]], [[la003-la004-confidential-products]].

**Reusable auditor:** `scratchpad/audit_month.py` reads `CLOSING/*.xlsx` → `_AUDIT.txt` + `_manual_by_product.csv` + `_manual_by_distributor.csv` (manual Retail/Stores/Discount by product and by distributor). Re-run as new months are uploaded.

## Full methodology (merged 2026-07-31 from `manual-closing-methodology-deep-audit`)

Owner's "rakam wahed" (2026-07-17): tab-by-tab reverse-engineering of all 18 cumulative workbooks
(6 snapshots × 3 lines) in `Downloads\CLOSING\New folder`. **Deliverable:
`Downloads\CLOSING\MANUAL-CLOSING_Methodology_Deep-Audit.md`** (every equation + RAR inventory +
owner rulings).

**The machine, identical on all 3 lines:** `Data` (ONE month at a time, replaced monthly, 100%
pasted values; manual mapping row→Area+DM+canonical product; Type=Retail/Stores/Discount) →
`Total` (Table15: `SUMIFS(Data by Sys/PRODUCT/Type)`, Value = units × **hand-typed price**, Target
Units typed) → hidden `Formula` (paste-values pivot by Area) → live month tab (`SUMIFS(Formula by
AREA name)` — rep name is just text) → **paste-frozen at the next closing.** Jan–May tabs have
ZERO formulas, so history is untraceable. Q1/Q2/S1 are cell sums of month tabs; `Ranking` tabs are
pasted values. Hidden `STORE Calculation`: **one hand-typed bulk (D3)** × area-share-of-retail-value
→ modeled Stores rows. Hidden `Dist Analysis` (Pedia/Anti): hand-typed units per distributor × price.

🔴 **Manual prices ≠ Phoenix master** (Jun): Tebo40 71.05 vs 81 · Forte80 97.69 vs 111.375 · drops
53.28 vs 60.75 · Saginko 111.15 vs 126.72 · Lacto Adv 270 vs 225.06 · Ivyronc Stores 14 vs Retail
30.375. Discount rows are deal-specific (46–55.2 Roya; 192–270 Lacto), some priced None → value 0.
**So manual VALUE never matches system value even at identical units.** 9 hand-entry points are
listed in doc §3 (mapping, channel inclusion — Jun manual drops tenders/chimipharm/IS-T, merges
Hospital→EGD, replaces Marcyrl with the Stores model — prices, targets, stores bulk, discount
deals, rep names, rankings, the freeze).

Census scripts/outputs in scratchpad: `census_deep2.py`, `census_{CNS,Anti,Pedia}.txt`,
`census_STRUCTURE_all18.txt`. See [[field-sales-3way-report-spec]] for the Apr-files owner ruling.
