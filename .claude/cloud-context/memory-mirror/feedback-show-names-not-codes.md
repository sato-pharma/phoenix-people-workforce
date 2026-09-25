---
name: feedback-show-names-not-codes
description: "Owner preference — always show human-readable names in UI and chat, never raw codes/IDs."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 785df647-44c8-4011-856b-d15dd74cd4d8
---

Owner instruction (2026-07-13): **never show codes, always show names.** Applies to UI surfaces AND my chat replies.

- Area → show the area NAME (e.g. "Alex East", "Down town"), not the code (AB1, CA5).
- Region → region NAME (e.g. "Alex-BHR", "Delta 1", "Upper Egypt"), not the code (AB, D1, GZ, OT, UE, UE-1, UE-2).
- Product → product NAME, not the code (CO001, TE002, LA001).
- Person (rep / DM / manager) → employee NAME, not the HR-ID (B-135, CN-0001). Show "vacant" when the seat has no occupant.
- Line → line NAME (CNS / Pedia / Anti-infective) is already a name; fine.

**Why:** codes are meaningless to the people reading the screens; names are what they recognize.

**How to apply:** resolve codes → names in the app/read layer before display (area names from `au_v_line_area_map`/canonical_areas, region names from the fixed 9-region map, product names from `source_of_sales_products`, employee names from `employees`). First applied to the Targets/achievement page ([[area-unification-42-areas-design]]); apply the same everywhere going forward (organogram, closing, employees, reports). Codes may still be used internally as keys/joins — just never surfaced to the user.
