---
name: a-shared-codes-address-is-looked-up-by-code
description: "An import row's `client_address` is resolved BY CODE when `client_address_source` is set, so under a shared distributor code BOTH pharmacies wear ONE address — and it was about to put an Alexandria pharmacy's new map row in Tanta"
metadata:
  node_type: memory
  type: project
---

`source_of_sales_import_rows.client_address_source` says where the address came from. When it reads
`marketing_pharmacy_reference` the address was looked up **by distributor + client code**, not by
pharmacy — so on a code two pharmacies share, every row of BOTH of them carries the SAME address,
whichever pharmacy the reference happens to hold. When it is **NULL the address came off the sheet
row itself** and belongs to that pharmacy.

**It is not a cosmetic field when you are splitting a code**, because the address is the evidence you
reach for to decide the new code's brick. Measured on production 2026-10-10, EP-PHS `22199283`:

| Pharmacy | `client_address_source` | Address |
| --- | --- | --- |
| احمد فايد - الفلكى $ (Alexandria) | `marketing_pharmacy_reference` | طنطا ش على ابن ابى طالب … |
| احمد فايد - الفلكى $ (Alexandria) | NULL (the sheet) | ش المعهد الدينى من ش اديب معقد الفلكى |
| رانيا عبد الحافظ - طنطا | either | طنطا ش على ابن ابى طالب … |

A `max(client_address)` over all its rows handed the Alexandria shop a **Tanta** address, which read
as a flat contradiction of the brick chosen for it from neighbour votes. Three of twelve new map rows
took the wrong pharmacy's address that way (`22198743-2`, `22199171-2`, `22199283-2`) before the
`client_address_source is null` filter put each one back. Two of the three *also* confirmed their
brick once corrected — `زناره مركز تلا شبين الكوم` for تلا, `كوم الضبع مركز الباجور` for الباجور.

**How to apply:** when reading a pharmacy's address out of import rows, always filter
`client_address_source is null`. The reference-sourced copy answers "what does this CODE point at",
never "where is this shop". Related:
[[a-code-split-gives-the-new-code-to-the-unlocked-pharmacy]],
[[shared-distributor-codes-are-165-not-two]].
