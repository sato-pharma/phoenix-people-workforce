---
name: sato-sector-distributors-ep-bk-ep-phs
description: "SATO's own ERP exports onboarded as SoS distributors EP-BK (EPDA-BULK / wholesale) + EP-PHS (EPDA-Pharmacies); raw normalizer profiles, month-first dates, top products are the confidential LA003/LA004/SS001."
metadata: 
  node_type: memory
  type: project
  originSessionId: 6bab79b9-e117-4ab5-aa83-6246a10d25ab
---

Onboarded 2026-06-30 (PR #632, merged + deployed to prod) — two SATO direct-sales sectors as **monthly Source-of-Sales distributors**:

- **EP-BK / "EPDA-BULK"** — ساتو قطاع الجملة (wholesale). File `ساتو قطاع الجملة.xlsx`.
- **EP-PHS / "EPDA-Pharmacies"** — ساتو قطاع الصيدليات (pharmacies/retail). File `ساتو قطاع الصيدليات.xlsx`.

Both are **SATO's own ERP export** (NOT a third-party distributor), byte-identical 12-col layout:
`who_me, inv_no, inv_date, req_type, cust_code, cust_name, class_code, class_name, is_bonus, qnt, customer_type, cust_address`. Source folder: `C:\Users\satoh\OneDrive\Desktop\Khaled Bedair\New folder\sato 4-2026\sato 4-2026\` (also has `مركز تموين مستشفيات` hospital sector — not yet onboarded).

**Profiles** (`src/lib/sales/normalizer/profiles.ts`, RAW_DISTRIBUTOR_PROFILES): raw — product via alias dict by `class_code`(code)/`class_name`(name, primary); geography via the customer→brick map by `cust_code` (NO brick/territory col); value **recompute**; `bonusColumns:["is_bonus"]` (is_bonus=1 = free goods, skipped); **sales only** (req_type always 1). **`dateFormat:"month-first"`** — `inv_date` is US-style M/D/YYYY (5/31/2026 = 31 May), the ONLY month-first distributor (all others day-first); verified decisively (pharmacy file: 902 rows day>12 in 2nd position). Headers identical between the two → auto-detect can't distinguish them; operator picks the sector from the dropdown (recognition runs against the picked profile).

**GOTCHA — top products are the confidential codes.** class_name→Phoenix: لاكتو 1 لبن→**LA003** (Lacto Basic 1), لاكتو 2 لبن→**LA004** (Lacto Basic 2), ساتو سليم→**SS001** (Satoslim) — these 3 are exactly `RESTRICTED_PRODUCT_CODES` (CEO/Super-Admin only, Head Office line); plus لاكتو ادفانسيد 1/2→LA001/LA002 (Pedia), ساجنكو→SA001 (Saginko, Anti-infective). Most EP-BK/EP-PHS volume is the restricted Lacto Basic. See [[la003-la004-confidential-products]] and [[company-org-structure-head-office]].

**Wiring for a RAW monthly distributor = 2 mandatory steps** (everything else is automatic — batches/rows/fact+presence rollups/detection/dropdown registry/profile viewer/reset-recovery): (1) RAW_DISTRIBUTOR_PROFILES entry; (2) a row in `source_of_sales_distributors` via migration (dropdown + the `source_of_sales_import_batches.distributor_code` FK — case-sensitive, so codes MUST be UPPERCASE: stored `EP-PHS`, not `EP-PHs`). Weekly wiring skipped (owner: "SoS only, never split to another sales module"). No ROI rollup row added.

**Recognition probe (read-only, no DB write):** `node --experimental-strip-types --experimental-specifier-resolution=node --experimental-loader ./tests/alias-loader.mjs scripts/analyze-distributor-file.ts <CODE> "<path.xlsx>"` — drives the real engine vs live masters; proves headers recognized. Both verified: all headers OK; EP-PHS skipped its 3 free-goods rows.

Product/customer mapping is the **in-system lazy step** done after deploy (EP-BK: 4 products + 28 customers; EP-PHS: 6 products + 635 customers) via the on-screen unmapped panel — now with the address-enriched "Export unmapped (XLSX)" (PR #625) to help assign bricks.

History: the earlier "EPDA Bulk" codes EP-R/EP-S were removed 2026-06-28 as mistakes (migration `20260628100000`); EP-BK/EP-PHS are the clean, non-colliding replacements. See [[sofico-upload-template-recognition]] (distributor onboarding pattern) and [[source-of-sales-rebuild-rules]].
