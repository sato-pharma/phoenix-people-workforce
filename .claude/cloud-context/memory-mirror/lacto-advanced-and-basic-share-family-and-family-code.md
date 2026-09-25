---
name: lacto-advanced-and-basic-share-family-and-family-code
description: "Lacto Advanced (Pedia) and Lacto Basic (Head Office) had the SAME family name until 2026-08-31, when the owner had them split into 'Lacto Advanced' and 'Lacto Basic'; they still share family_code 'LA' DELIBERATELY, because that code is the direct-order multi-item allow-list — never tidy the codes to match the names"
metadata: 
  node_type: memory
  type: project
  originSessionId: 5344b79a-0aa0-46cd-ae76-929339b93a87
  modified: 2026-08-31T12:10:00.000Z
---

**OWNER RULE 2026-08-27: "Collect Lacto Advanced family."** The Pedia Lacto family means
**Lacto Advanced 1 + Lacto Advanced 2 and nothing else.** Lacto Basic must never bleed into it.

**RESOLVED IN THE DATA 2026-08-31, on the owner's instruction** — *"make lacto advance family to
avoid confusion with bother lacto"*. The family NAMES are now distinct, so the collision that made
this memory necessary no longer exists:

| Code | Product | line | family (now) | family_code |
| --- | --- | --- | --- | --- |
| LA001 | Lacto Advanced 1 | Pedia | **`Lacto Advanced`** | `LA` |
| LA002 | Lacto Advanced 2 | Pedia | **`Lacto Advanced`** | `LA` |
| LA003 | Lacto Basic 1 | **Head Office** | **`Lacto Basic`** | `LA` |
| LA004 | Lacto Basic 2 | **Head Office** | **`Lacto Basic`** | `LA` |

Applied to `public.source_of_sales_products` on production `ozucdzovmcqvepbozvqf`; the two
`marketing_products` copies (LA001/LA002) were aligned to match. Rollback pre-image:
`lacto_family_backup_20260831.source_of_sales_products_pre` (4 rows) and `.marketing_products_pre`
(2 rows) — they hold the ORIGINAL `Lacto` for all four, so both halves roll back from one place.
**Measured after: ZERO products carry the bare family `Lacto`, ZERO families span more than one
line.** Advanced was renamed first; the owner approved Basic the same day, so neither of the two
carries the ambiguous label any more.

🔒 **`family_code` is STILL `LA` on all four, and that is DELIBERATE — do not "tidy" it to match the
names.** `MULTI_ITEM_FAMILY_CODES = ["LA"]` in `src/lib/direct-orders/product-family.ts` is the
allow-list implementing the owner's 2026-08-12 ask, *"make him able to choose lacto adv 1 and lacto
adv 2 [in the same request] but this only with lacto"*. Changing the code would silently remove the
ability to put Lacto Advanced 1 + 2 on one direct order — a feature loss with no error.
`tests/direct-orders-family-basket.test.ts` pins it and fixtures all four on `familyCode: "LA"`.

**`family_code` is still not a key on its own**: `DO` maps to two different families (Dolabactin
`DO003` vs Dopaminict `DO001`/`DO002`). Group on the family NAME. Keying on `(normalized_line,
family)` remains correct and is now belt-and-braces rather than load-bearing.

**No backfill was needed and no migration exists.** `familyByCode` in
`src/lib/sales/weekly/service.ts` rebuilds product_code → family NAME from the Product Master on
every load and overwrites whatever `sales_records.family` holds, so the rename reached the NSM/DSM
and Summary workbooks live. `sales_product_codes` still reads `Lacto` for LA001/LA002 and is
harmless: **no application code and no database function reads that table** (swept 2026-08-31).

⚠ **Two other definitions of "the Lacto family" exist and were NOT changed:**
- `buildClosingFamilyLabel` (`src/lib/sales/parser.ts:84`) maps any product name starting with
  "lacto" to the literal `"Lacto Family"` — a NAME-PREFIX derivation that would weld Advanced,
  Basic and "Lacto LF" into one bucket. Harmless today (no Lacto Basic row exists in
  `sales_records`, and `v_employee_portal_sales` strips Basic by product name), but it is a second
  definition that no longer agrees with the master.
- `PRODUCT_FAMILY` (`src/lib/business-review/canonical.ts:169`) hardcodes `LA001/LA002 -> "Lacto"`,
  deliberately keyed on code and independent of the master. The CEO business review therefore still
  prints "Lacto"; `dashboard.client.tsx:462` also shortens "Lacto Advanced" to "Lacto" on purpose.

**HISTORY — the state this memory was written to warn about (verified 2026-08-27, superseded
2026-08-31).** All four rows read `family = 'Lacto'` and `family_code = 'LA'`; the ONLY
discriminator was the line. `group by family` would silently weld a Head Office product into a Pedia
sales family, and Lacto Basic is huge (243,232 units in July 2026 alone, roughly double the entire
tracked-line unit volume), so the corruption would not have looked like a rounding error — it would
have looked like Pedia had a record month. Attribution itself was clean throughout: checked across
`source_of_sales_fact_rollup` and `source_of_sales_distributor_product_rollup` for 2026-01 … 2026-08,
every LA001/LA002 row carried `official_line = Pedia`, every LA003/LA004 row `Head Office`, zero
crossings. Aliases split cleanly per distributor too (Advanced = PS 42700/42701, Basic = PS
42698/42699; the Arabic names differ by "ادفانسيد" and by price, -330ج vs -250ج).

Related: [[head-office-products-are-not-tracked-weekly-golden-rule]] (Lacto Basic is one of the Head
Office products, and HO's unmapped state is CORRECT — never "fix" it),
[[head-office-sales-are-absent-from-phx-monthly-achievement]],
[[units-of-different-products-are-never-added]],
[[sales-marketing-product-code-namespaces]].
