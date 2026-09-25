---
name: sales-territory-scope-build
description: "Authoritative per-manager region scope (sales_manager_region_scope) drives weekly+monthly sales visibility; region-scoped roles fail-closed; SHIPPED PR #357."
metadata: 
  node_type: memory
  type: project
  originSessionId: ed35b8f5-5eb6-4d42-9da0-50c378aeda1e
---

SHIPPED to prod 2026-06-20 (PR #357, squash 307ac6b4, migration applied+verified, prod 200). Fixes role visibility in BOTH weekly + monthly sales so every role sees only its territory.

**Policy (owner-confirmed):** NSM → his line; RSM → his regions; DM → his region; MR → his region (true AREA deferred — only ~39% of HR area names match SoS areas, so area-scoping would hide most reps; region matches ~81%); PM/GPM → only their products.

**Mechanism:** new table `sales_manager_region_scope` (hr_id canonical-lowercase → SoS region_code; RLS-on no-policies = server-only, mirrors weekly_sales_product_scope). It's the AUTHORITATIVE territory map — replaces fuzzy region-name matching AND the old hardcoded "Pedia RSM → AB,D1,D2" special case. Seeded for active managers only (RSM pd-0001 → AB+D1+D2; each DM → his region). Resigned/terminated DMs (b-180, b-101) deliberately NOT seeded. Reader `getManagerRegionScope(hrKey)` in weekly/access.ts (null = no rows → auto fallback). NSM/PM/GPM get no rows.

**Code:** weekly/access.ts territory tier uses explicit map first, else `resolveRegionCodesForNames` (now exported). monthly-closing-portal.ts: new `scopeMatrixToRegions` filters the closing matrix region rows + recomputes grandTotal (national-direct/company totals dropped); `resolvePortalClosingScope` resolves region codes for DM/RSM/MR; **Medical Rep ADDED to PORTAL_CLOSING_ROLES** (had no monthly view before). FAIL-CLOSED guard: a region-scoped role (DM/RSM/MR, NOT NSM) with no explicit row AND no resolvable region sees NOTHING (empty set), never falls open to whole line. SoS region codes: AB=Alex-BHR, CA=Cairo, D1=Delta(1), D2=Delta(2), GZ=Giza, UE=Upper Egypt, OT=Others. Unit test: tests/monthly-closing-region-scope.test.ts.

**Follow-ups:** (1) build HR-area→SoS-area crosswalk then move MR region→area; (2) when Cairo's 3rd DM seat is filled, add him to the table. Related: [[la003-la004-confidential-products]], [[sos-brick-authoritative-geography]], [[job-title-not-a-permission-source]].
