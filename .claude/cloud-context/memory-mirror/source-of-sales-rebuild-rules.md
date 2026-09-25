---
name: source-of-sales-rebuild-rules
description: "Confirmed business rules + validated master/POS data for rebuilding the /sales/import (Source of Sales) mapping engine."
metadata: 
  node_type: memory
  type: project
  originSessionId: 855cb7f2-5b6e-4c41-9c7c-f91e5219c5de
---

User is redesigning the `/sales/import` ("Source of Sales") module ([[command-center-perf-on2-sales]] is a different sales page). Three LOCKED rules govern how uploaded distributor sheets are processed:

1. **IDs in, names from DB.** From each uploaded row read ONLY: `Product ID`, `Brick ID`, `Area ID`, `Region ID`, `Distrub ID` (+ Qty, B.Qty, Invoice Date). Every name + the full hierarchy (brick→block→area→region) + line/family/price come from the system master tables by mapping on those IDs. NEVER read product/brick/block/area/region NAME columns from the sheet. Today's parser does the opposite (prefers uploaded text) — must be inverted.
2. **Value is computed; sheet Value totally neglected.** Ignore the sheet's `Value`/`Net` column entirely (no read, no reconciliation). `row value = (Qty + B.Qty) × factory_price` from the product master. Bonus/free units DO count toward value. Negatives (credit notes) net naturally.
3. **Sum same ID across distributors.** Dashboard rollups group by ID alone (Brick ID / Area ID / Region ID / Product ID), so the same brick from PS + IS sheets sums into one total. Rule 1 makes keys canonical so this merges correctly. Scope = per selected month (confirm if all-time also wanted).

**Single source of truth = `F:\Phoenix Workforce\phoenix-workforce\Source of sales area database.xlsx`** (geographic only). Discard old seeded region/area data + hardcoded refs. Sheets: Region Master(7: CA,GZ,UE,AB,D1,D2,OT), Area Master(42, cols Area Code|Region Code|Area Name), Block Master(148, cols Block Code|Area Code — **blocks have NO name**, name=code), Brick Master(360, cols Brick ID|Brick Name(Arabic)|Block Code|Area Code|Region Code). Brick IDs look like `B108-1`. Validated clean: unique keys, no blanks, full referential + hierarchy integrity (after user fixed B111-73→AB3, B89-24→D26; D27 removed). Some Area cells are formulas w/ cached results — read formula result.

Products master is SEPARATE (existing `source_of_sales_products`, 21 seeded) — not in the xlsx.

**Sample POS files** (real, April 2026): PS/Overseas `C:\Users\satoh\OneDrive\Desktop\Areas Database\Source of Sales\customer sales - Copy.XLSX` (sheet "Data", 10,692 rows, IDs in cols 17-21); IS/Ibn Sina `...\ibnsina 4.xlsx` (sheet "Sheet1", 6,501 rows, IDs in cols 26-30; brick col = "Brick ID2"; Distrub is a formula =IS). **Coverage validated 100%**: every Product/Brick/Area/Region ID in both real sheets exists in the masters, zero blanks, zero unmapped → "block unmapped IDs" rule is safe.

Open decisions before build: confirm unmapped-ID = hard block; brick's DB chain authoritative on conflict; Rule 3 month-scope. DB schema gap: `source_of_sales_blocks.block_name` is NOT NULL but master has no block names → seed name=code. Status: design validated, NOT yet coded (user said wait). See [[supabase-dual-project-schema]], [[admin-shell-design-rules]] for build constraints.
