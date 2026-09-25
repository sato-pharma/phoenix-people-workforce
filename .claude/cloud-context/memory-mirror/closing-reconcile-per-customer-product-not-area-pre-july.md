---
name: closing-reconcile-per-customer-product-not-area-pre-july
description: "Manual monthly closings before July 2026 do NOT have unified areas — reconcile them against Phoenix per customer x per product (Pharmacy Code x Product x units), never per area"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e908adcc-abd2-4e16-9fb1-92d5cb0eeff1
  modified: 2026-08-13T20:14:49.566Z
---

Owner rule, stated 2026-08-13 while training on monthly closings: area unification only
**started in July 2026**. Every manual closing for **Jan–Jun 2026** was built before areas were
unified, so its Area column does NOT line up with Phoenix's (today's) geography.

**Why:** comparing a pre-July manual closing to Phoenix **by area** produces large false
differences that are pure noise — the same trap the July CNS work order hit
([[cns-factory-price-basis-is-unresolved]] context). The area rows disagree even when the sales are
identical.

**How to apply:** to reconcile any pre-July manual closing against Phoenix, aggregate **per customer
× per product** — i.e. `Pharmacy Code × Product × Sales Units` from the manual's `Data` sheet vs
`source_of_sales_import_rows` grouped by `client_code × product` for that `invoice_period` +
`official_line`. Pharmacy/item codes are per-distributor, so key on `(distributor, pharmacy code)`,
not the bare code ([[sos-always-todays-geography-rule]] explains SoS always attributes to today's
geography anyway). Line and per-product totals are also safe; only **area** breakdown is unreliable
pre-July. The owner's overriding goal here is to make the **upcoming** monthly closings fast by
codifying this into a repeatable playbook.

**Product exclusions (owner rulings — do NOT count these in the closing total):**
- **Heal Quick** — excluded from the Anti-Infective line closing (owner, 2026-08-13). It appears in
  the manual `Data`/`Total` sheets but must be dropped. Assume excluded wherever it appears unless
  the owner says it counts on a given line. (Jan Anti-Inf: 10,956 raw − 561 Heal Quick = **10,395**.)

**Channels / distributors (owner, 2026-08-13):**
- **Office** allocation exists **only on the CNS line**. Do NOT expect or look for Office on Pedia
  or Anti-Infective. (Office = his "Stores" distributor, [[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]].)
- **Direct** (the direct-orders channel) appears on **Pedia and Anti-Infective**. In the manual it is
  the `Data` sheet rows where **Distributor = "Direct"**: they carry **Sales Units but no value**, and
  **no pharmacy code**. Isolate Direct by filtering that Distributor column.
- To reconcile a line, split by channel first, then match the coded (retail) channels per customer ×
  product and reconcile Direct as its own bucket. **Distributor name map (verified Jan Anti-Inf, units
  matched exactly):** manual **IBNSINA → Phoenix IS-S** (Ibn Sina), manual **POS → Phoenix PS**
  (Pharma Overseas), manual **Direct → Phoenix DIRECT**. Manual also has **IBNSINA-POS** and **EPDA**
  buckets that had **no matching Phoenix distributor** in Jan — a real source of gap, not noise.
- The `Total` sheet's **`Type of Sales`** column = **Retail** vs **Stores**; **Stores = the
  store-split** allocation (fractional units). Owner will teach the store-split rule later.

**Worked example — Jan Anti-Infective (Heal Quick excluded): manual 10,395 vs Phoenix 9,516, gap +879:**
Ibn Sina 4,011 = 4,011 (exact); Pharma Overseas (POS/PS) +103 on Sagenkgo; **Direct +597** (manual
2,641 vs Phoenix 2,044 — the headline gap); IBNSINA-POS +169 and EPDA +10 have no Phoenix bucket.
Coded per-customer sales matched almost to the unit (1,777 of 1,841 cells exact).

Manual-closing file shape (his "Final" workbooks, e.g. `F:\Sales Closing\<Mon>\...Final.xlsx`):
sheets `Sales Closing` (rep×product achievement pivot), **`Data`** (per-pharmacy per-product raw —
the reconciliation grain), `Total` (DM×area×product with factory price + fractional store-split
allocations), `Formula`, `Ranking`, `Dist Analysis`, `STORE Calculation`. His line naming:
**"Line 2" = Anti-Infective**. Related: [[sos-monthly-closing-is-the-only-sales-truth]].
