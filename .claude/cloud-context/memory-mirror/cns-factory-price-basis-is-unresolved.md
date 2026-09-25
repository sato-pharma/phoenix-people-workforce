---
name: cns-factory-price-basis-is-unresolved
description: "The CNS ex-factory price basis is OPEN — the owner reverted an Xfactory.xlsx application on 2026-08-11; do not change any factory_price without an explicit fresh ruling"
metadata: 
  node_type: memory
  type: project
  originSessionId: ff721f65-99c8-4ef2-92f2-305a08d0d465
  modified: 2026-08-12T06:18:07.062Z
---

**OWNER RULING 2026-08-11: Tebofortine Forte 80 at 111.375 IS CORRECT.** So the live Tebofortine
prices (111.375 / 81.00 / 60.75) stand, the system's **July 2026 CNS of 8,066,152.47 is the correct
figure**, and his manual sheet's 7,291,091 is the one carrying stale prices. Independently confirmed
by his own `Xfactory.xlsx`: EDA 25% then 10% → 165 × 0.675 = 111.375 exactly.

**Still open: Conviban ×4 and Rispadex ×2**, where his sheet is 6.25% ABOVE the live values
(28.08 vs 26.325 etc. — his sheet implies public × 0.72, i.e. 20%+10%, while both the live master and
Xfactory use ×0.675, i.e. 25%+10%). Worth 48,977.78 on July. `Xfactory.xlsx` agrees with the LIVE
values, so the same logic that settled Tebofortine settles these too — but he has not said so.

**Do not change `source_of_sales_products.factory_price` without an explicit, fresh ruling.** This
was chased hard on 2026-08-11: a change was applied, reverted, and the previous months' prices
restored, all in one session.

**Current live state — restored 2026-08-11 to the prices that produced Jan–Jun's closings**, at the
owner's instruction ("reapply what u always used in the previous months") after his own 17:02/17:07
Product Master imports were rolled back: Tebofortine 111.375 / 81 / 60.75, Conviban 34.425 / 35.4375
/ 26.325 / 33.75, Rispadex 34.425 / 22.275, **Tebofortin 240 max 150.90**, Saginko 111.15, Osteosat
and Tigogrow 0 (inactive).

**July 2026 CNS = 8,066,152.47 on 105,152 units.** His manual closing sheet says **7,291,091** — a
gap of 775,061.47 that is NOT reconciled. Verified restore: all seven months Jan–Jul reproduce their
pre-import figures to 0.00.

**Note the one place this differs from `Xfactory.xlsx`:** that sheet gives Tebofortin 240 max as
142.105263 (240 × 0.6175... actually 210/240 pattern), while the months actually closed on 150.90.

**Three price bases exist and none has been ruled authoritative:**

1. **Product Master** (`source_of_sales_products`, the closing's actual input) — live values above.
2. **`Xfactory.xlsx`** (`C:\Users\satoh\Downloads`, owner-supplied). Its `Calculation` tab derives
   ex-factory = public × (1−d1) × (1−d2), **no VAT step**: EDA 0.25 then 0.10 (×0.675, so 165 →
   111.375); Royafloxacin less **2 EGP first**; Lacto 0.12/0.07 (330 → 270); Saginko / Osteosat /
   Tigogrow ×0.6175 (180 → 111.15) which does NOT match its own stated NFSA 0.20/0.12. Applying it
   put July CNS at 8,060,576.61 — the owner then said to revert, and it was reverted in full.
3. **`marketing_products` / `sales_product_codes`** — these are the Product Master values **÷ 1.14**
   for Tebofortine (111.375→97.69, 81→71.05, 60.75→53.28), i.e. an ex-VAT variant.

**Why the gap keeps landing on ~820k:** Tebofortine is **83% of the CNS line** (6.7M of 8.1M), so
its VAT basis alone moves the total by ~824k. Every "the closing is 10% high" investigation
converges there.

**What reproduced his 7,291,091 almost exactly (239 EGP off)** was a mix none of the three sources
holds: Tebofortine ex-VAT **plus** Conviban/Rispadex at the HIGHER prices **plus** Tebofortin 240 max
at 150.90. So his manual sheet disagrees with every stored basis, in offsetting directions.

**How to apply.** Ask before touching any price. Changing one restates **every month** (no period
scoping — see [[closing-retail-value-is-units-times-factory-price]]) and CNS 2026-07 is **LOCKED**,
while prices live on a table the lock triggers do not guard. Backups from that session, both with
anon/authenticated revoked: `xfactory_backup_20260811.sos_products_pre` (pre-Xfactory, and the
rollback source) and `mp_price_align_backup_20260811.marketing_products_pre`.

**Still applied, NOT reverted:** 10 CNS rows in `marketing_products` were aligned to the Product
Master earlier that session with the owner's approval, and remain aligned. Its non-CNS rows still
differ: Saginko 126.72 vs 111.15, Lacto Advanced 1 & 2 225.06 vs 270.00, Royafloxacin 60.70 vs 60.75.
