---
name: roi-auto-apply-single-value-guard
description: "Marketing ROI filter only auto-applies a 1-value dimension when EVERY request carries that value (fixes phantom RM chip)."
metadata: 
  node_type: memory
  type: project
  originSessionId: aebaa85c-e5f9-4fe9-9978-a415bdad5184
---

SHIPPED 2026-06-28 (PR #594, commit `5425b064` on main). The Marketing ROI Tracking filter engine's locked rule "exactly 1 option → auto-apply + hide" wrongly fired when most requests had NO value for that dimension. Symptom: "Auto-applied: Regional Manager: Hany Saad Mohamed Omar" showed in EVERY account, because `PD-0001` (Hany Saad, "Regional Sales Manager") is the org's only RM and appears in only 50/218 request chains (168 have no RM).

Fix: auto-apply a lone value ONLY when it is universal — `options.length === 1 && everyEntryHasValue`. Applied in both [[match-module-design-before-building-ui]]-style twin paths: `src/lib/marketing-requests/roi-facets.ts` (client cascade `computeFacetedDimensions`) AND `src/lib/marketing-requests/roi-report-scope.ts` (`multiselectDimension`, feeds server `autoAppliedByDimension`). Regression tests in both `marketing-roi-facets.test.ts` + `marketing-roi-report-scope.test.ts`. The genuine single-region case (DM whose whole scope is one region — every request shares it) still auto-applies.

Note: the auto-applied value is advisory only — it never narrowed the report rows (empty filters → all 218); it was a misleading chip, not data loss.
