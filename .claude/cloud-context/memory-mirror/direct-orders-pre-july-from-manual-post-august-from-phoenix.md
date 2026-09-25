---
name: direct-orders-pre-july-from-manual-post-august-from-phoenix
description: "Pre-July 2026 Direct orders are taken static/as-is from the MANUAL closing (manual wins over Phoenix's own import); from August Direct comes ONLY from Phoenix, finance-confirmed to correct brick/area/region/value"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e908adcc-abd2-4e16-9fb1-92d5cb0eeff1
  modified: 2026-08-13T21:49:45.468Z
---

Owner rule, stated 2026-08-13 while training on monthly closings. Governs how the **Direct** channel
(direct orders — [[owner-sheet-vocabulary-stores-is-office-upa-is-a-channel]]; Direct lives on Pedia
and Anti-Infective, never CNS) is sourced across the July/August boundary.

- **Jan–June 2026 (pre-July):** Direct orders were taken **static from another source**. When
  uploading these months to Phoenix, **take Direct AS-IS from the manual closing** — Phoenix's Direct
  for a given line×month must equal the manual closing's Direct rows, exactly. **The manual wins**
  over Phoenix's own pre-July Direct import, even when Phoenix's rows look more complete.
- **July 2026:** the cutover month. Owner trailed off describing it — confirm exact handling when we
  reach July (do NOT assume).
- **August 2026 onward:** Direct comes **ONLY from the Phoenix system**. After **finance confirms the
  date** on a direct order, it must attribute to the **correct brick → correct area → correct region,
  with the correct value** ([[direct-order-sales-month-is-a-finance-step-not-a-bug]],
  [[direct-order-pricing-rule-locked]]). Pre-July "as-is, no brick/value" and post-Aug "system,
  fully attributed" are two different regimes — do not blend them.

**Why:** the pre-July manual is the real historical source of truth for Direct. Phoenix's own Direct
import for those months is unreliable — the 2026-07-30 static import of Jan Anti-Infective Direct only
covered Delta + Giza regions, missing every Cairo (Ain Shams) and Upper Egypt (Minia, Qena) direct
order (800 units across 3 reps), while over-counting Heba/Giza (400 vs the manual's 200). So Phoenix's
pre-July Direct rows are NOT authoritative; the manual is.

**How to apply (pre-July reconciliation):** for each pre-July line×month, **REPLACE** Phoenix's Direct
rows (`source_of_sales_import_rows` where `distributor_code='DIRECT'` / `is_direct=true`,
`invoice_period`, `official_line`) with the manual closing's Direct rows — one row per manual Direct
line (Area + DM + product + units). **Value is REQUIRED, not null** — the closing sums the row `value`; set value (=
units×factory_price anyway, [[closing-retail-value-is-units-times-factory-price]]). Then refresh the
closing rollup so the Monthly Closing reflects it. Do NOT preserve Phoenix "extra" Direct rows over
the manual, and do NOT naively add (Salim/Heba/Dina already exist → blind add double-counts).
Worked example lives in [[closing-reconcile-per-customer-product-not-area-pre-july]].

**Insert mechanics (pinned after getting them wrong once):** `row_number` is NOT NULL and
`UNIQUE(batch_id,row_number)` — assign fresh numbers above the batch max (Jan used 101-119). `id` is
identity, omit it. Insert the manual rows FIRST, then delete the old Phoenix rows by explicit id
(never by `is_direct=true` — that nukes the new rows too). Populate canonical `area_code`+`region_code`
from the manual Area (SoS area codes == au codes); `brick_id`/`client_code`=null, `bonus_qty`/`discount`=0,
`is_direct=true`, `validation_state='valid'`; `raw_row`=the manual line for trace. All Anti-Inf Direct
sat in ONE batch (`7763cd21...`) so one `phx_refresh_sos_fact_rollup` sufficed.

**Jan Anti-Inf — DONE 2026-08-14:** 23 rows -> 19 (2,044 -> 2,641 u / EGP 189,319.95). Achievement
actual 9,516 -> 10,113 (50.2% by value). Residual to the manual's 10,395 = IBNSINA-POS 169 + EPDA 10 +
Sagenkgo retail 103 = 282 (separate from Direct, decide next).
