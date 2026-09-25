---
name: an-owner-ruling-only-binds-at-confidence-100
description: "A customer-map row that records an owner ruling is IGNORED across area boundaries unless confidence = 100 - the distributor's own district text wins instead, and the monthly self-heal overwrites the ruling. Also: how to test whether a mapping sheet is right, using the distributor district at a measured ~97% baseline - and why a LOW score on a SELECTED batch is evidence and never a verdict, the owner having overruled a 0-of-14 district reading on 2026-09-11 (those 24 are settled, source owner-ruling-shortlist-2026-09-11)."
metadata: 
  node_type: memory
  type: project
  modified: 2026-09-10T22:19:34.395Z
  originSessionId: ec7309b3-ed45-4b41-97ed-735c08530940
---

**`confidence = 100` is the ONLY thing that makes a mapping absolute.** `resolveBrick()` in
`src/lib/sales/normalizer/resolvers.ts` keeps a same-area guard on every stored mapping: when the
stored brick sits in a DIFFERENT area from the one the distributor's sheet names, **the sheet wins**.
The single exception is a row at `confidence = 100`, which `crosswalks.ts` loads into
`ownerVerifiedCustomerKeys`. `mapping.ts` and `customer-map.ts` then also SKIP those rows in the
monthly self-heal, so an unprotected ruling is overwritten by the next upload as well.

Algorithmic scores cap at 95, so 100 is a deliberate owner-only sentinel.

Measured on production 2026-09-10: of 2,961 customer-map rows whose source or `mapped_by` recorded an
explicit owner ruling, only **482 carried confidence 100**. The other 2,479 were being ignored
wherever they crossed an area line, worth **473,259 EGP** of tracked sales across Jan-Aug. Stamped
that night at the owner's instruction, plus 211 sheet-verified rows measurably being overridden.

## How to test whether a mapping sheet is right

Compare each customer's mapped area against the **distributor's own sales district text**, resolved
through `source_of_sales_territory_aliases` then `source_of_sales_area_aliases`, using
`normalizeAliasKey` semantics (lowercase, drop tatweel, fold `أإآا→ا` and `ى→ي`, every
non-alphanumeric run to ONE space, keep spaces, do NOT fold `ة`). **`phx_normalize_arabic` is the
wrong normaliser here** - it strips whitespace and folds `ة`, and manufactures false hits.

🔴 **The baseline is ~97%, and you MUST measure it as a positive control before believing a low
reading.** Measured 2026-09-10: 97.2% nationally, 97.7% within the same areas as the sheet under
test, PS 98.7%, IS 94.2%. Two sheets written that night scored **4.3%** and **0.0%**; without the
control those numbers read as a broken check, and with it they were a real defect - the sheets were
reverted. A near-zero reading across a broad population is a join on the wrong key, and the tell is
one district scattering into four areas.

⚠ **Do NOT read a low score on a SELECTED population as the same signal.** Rows chosen because two
feeds already disagreed, or that the owner has personally ruled on, sit near 79% by the mapper skill's
own backtest, and a twin-propagation that moves the losing side onto the ruled brick makes its own
district text disagree BY CONSTRUCTION. [[territory-is-not-geography]] is the companion rule.

🔴 **Measured instance, 2026-09-11 — the district test scored 0 of 14 on a selected batch and the
OWNER OVERRULED IT, twice.** 24 cross-region moves from an address shortlist were put to him; 14 of
them carried a distributor district, and **every one contradicted the move, the district matching the
area the customer was being moved AWAY from**. That was reported to him as decisive and the batch was
reverted. He answered *"follow the sheet they are correct"* and they were re-applied, now stamped
`source = 'owner-ruling-shortlist-2026-09-11'`, `mapped_by = 'owner-ruling'`, **confidence 100**.

Three of the 24 had overwritten his OWN earlier rulings (`owner-ruling15-2026-07-28`,
`owner-ruling-pedia-area-2026-08-09`, a `sheet-verified` row); he superseded all three deliberately.
Sadat City, كفر داوود and البتانون sit in Menoufia on a map while their distributor files them under
Alex-BHR and Giza — and **he ruled the map right and the district wrong**, which is the whole of
[[territory-is-not-geography]] pointing the other way for once.

**So: 0-of-N against a selected population is NOT proof.** It is the ⚠ above, arriving in the
strongest form it can take. Put it to him as evidence, never as a verdict, and never revert his batch
on it — **these 24 are SETTLED**; a district sweep that flags them is reading a decision, not a
defect. The guard now holds any re-map of them because the source begins `owner-`.

**How to apply:** after the owner rules on a mapping, stamp `confidence = 100` or the ruling will not
survive the month. When auditing a bulk sheet, run the control first. And when a brick already
carries a large `confidence = 100` population sharing one distributor district, **that population IS
the ruling** - do not escalate a new row that matches it. See also
[[sos-owner-standing-rules-from-session-369dd08d]] and [[a-case-duplicate-line-map-row-doubled-a-whole-line]].
