---
name: dv-focus-scope-leak-and-fixes
description: "Portal \"Scope Focus\" (Double Visit Focus) cross-line/cross-scope leaks — NSM company-wide bug fixed by"
metadata: 
  node_type: memory
  type: project
  originSessionId: c53ead08-442c-44a9-ae9b-bd0435c6d36b
---

The portal landing "Scope Focus" the owner referred to = the **Double Visit Focus** section (`DoubleVisitFocusSection`), fed by `getDoubleVisitPortalFocus(access)` in `src/lib/double-visit-analytics/service.ts`. Rendered for DM/RM/NSM/PM/GPM/TM (`DV_FOCUS_ROLES`). Three blocks: personal DV trend, scope-coverage roster (neglected/overdue "alarms"), probation watchlist ("alarms"). Med Reps do NOT get this section.

**2026-07-05 incident:** owner reported it "showing alarms to med reps in a different line." Root cause was NSM being hard-coded to company-wide (`all: true`) in `resolveDoubleVisitAccessScope`, so an NSM's coverage roster flagged every line's med reps.

- **Already fixed by PR #840** (merge `4efb342b`, `codex/dv-report-nsm`, merged 06:13 Cairo). Removed NSM from the `all:true` branch → NSM now scoped to `descendantHrIds` (his reporting chain). Production auto-deployed it 3s after merge (deploy `ya1i6ia9z`). The owner was seeing a stale pre-#840 deploy.
- **PR #845 (mine, `codex/dv-focus-probation-scope`, awaiting merge):** the probation watchlist (Block 3) was still built from `getProbationRows(access)` — intentionally broader than DV scope (NSM=whole line, RM=hierarchy) — WITHOUT intersecting `filterEmployeesForDoubleVisitAccess`. Fix intersects it against the DV-scoped key set so all three blocks share one scope. No-op for company-wide roles (CEO/SA/TM/MM/SFE/system). Does NOT touch the probation module's own broad scope.

Two separate scope engines to keep aligned here: DV scope (`resolveDoubleVisitAccessScope`: NSM=chain, PM/GPM=line via `sameWorkforceLine`, RM=region, all-list=CEO/SA/SFE/TM/MM) vs probation scope (`canReadProbationEmployee`: NSM/PM/GPM=isSameLine, RM=hierarchy, TM/MM/CEO=all). They drift. Related: [[probation-scope-broader-than-generic-canseeemployee]], [[double-visit-gpm-line-id-scope]], [[dv-report-vs-dv-analytics]], [[stale-checkout-verify-against-origin-main]].
