---
name: anti-infective-canonical-line-name
description: "OUTDATED IN PART (contradiction sweep 2026-10-02) — current: The anti-infective line DISPLAY spelling is 'Anti Infective' (both words capitalized) everywhere — owner's 2026-07-18 choice, applied to code + prod (see `anti-infective-canonicalization`). Older text follows: Canonical line label is \"Anti infective\" everywhere (lines.name renamed); lines.code stays anti_inf; SMI ROI dashboard Line resolves from requester HR_ID"
metadata: 
  node_type: memory
  type: project
  originSessionId: 6ceaecc2-d940-4a0e-9524-7fa7adc6fef0
---

2026-06-21: "Unassigned everywhere in the ROI dashboard" (the **Sales & Marketing Intelligence** dashboard, RPC `phx_marketing_roi_customer_dashboard`) had two causes, both fixed + applied to prod:

1. **Line was Unassigned** — the RPC derived Line from `marketing_requests.line_id` (empty for ~all). Fixed to fall back to the **requester's** `employees.line_id → lines` (resolve from requester HR_ID). 109/109 → Anti infective 64 / Pedia 40 / CNS 5. Migration `20260621230000` (PR #383). Region intentionally NOT changed — it stays the target pharmacy's brick geography per [[sos-brick-authoritative-geography]].

2. **Owner: unify "Anti infective" system-wide.** `lines.name` id=1 was "Anti Inf" while everything else (marketing/SoS products, SoS import rows) used "Anti infective". Renamed `lines.name` id=1 → **"Anti infective"** (migration `20260621240000`, PR #384). CRITICAL: **`lines.code` stays `"anti_inf"`** — import line_id matching, the sales-access bridge (`bridgeEmployeeLineToOfficial` in src/lib/sales/access-scope.ts), and marketing line-scope (`marketingProductMatchesRequesterLine`, line_id-first + alias `"anti infective"→"anti inf"`) all key off code/line_id/alias, so the rename is display-only and safe. Audited: no DB fn/view references the literal 'Anti Inf'.

**Why:** the request table and the Line chart showed two spellings of the same line once Line resolved from the requester.
**How to apply:** the canonical DISPLAY line names are now "Anti infective" and "Head Office" (via line_id→lines.name). Never re-introduce "Anti Inf"/"Office" as a display value. `lines.code` keys stay "anti_inf"/"office" and alias-map keys stay tolerant — don't "clean" them.

3. **Owner: unify "Office"→"Head Office" system-wide** (PR #388, migration `20260621250000`, prod). `lines.name` id=4 "Office" → **"Head Office"** (`lines.code` stays "office"). Unlike Anti infective, code had EXACT `=== "office"` checks that needed updating: `isOfficeLine`/`isOfficeSelected` in employee-organogram-dashboard.tsx + reports/organogram-view-model.ts (now accept "office" OR "head office"), and admin `normalizeLine` gained a `"head office"→"Office"` governance alias (else the 15 office-line staff fall to "Other"). DO NOT touch the SEPARATE "Office" concepts: the `distributor_code='Office'` sales channel (phx_office_brick_share/region_share, OFFICE_DISTRIBUTOR_CODE) and the weekly-plan activity type "Office". Admin governance phoenixLines canonical stays "Office"/"Anti-Infective" internally (display-only rename, like SoS). GOTCHA: applied DB rename before code deploy → brief window where prod code didn't recognize "Head Office"; for future line renames, deploy tolerant code FIRST.

Region "Unassigned" bucket = **57 target pharmacies not brick-mapped** in `source_of_sales_customer_map` (24 requests all-unmapped); relabeled to "Unmapped pharmacy" in the SMI service (PR #384). Worklist of the 57 delivered to owner Desktop for mapping. Related parallel PR #385 fixes the ROI *report* (filter-engine) "unassigned" for departed requesters.
