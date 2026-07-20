import assert from "node:assert/strict";

import { deriveOfficialLine } from "../src/lib/sales/territory/root-scope.ts";

// Guards the one pure piece of the Territory Drilldown module's new hard-lock resolution
// path: picking the viewer's single official line out of resolveSalesAccessScope's
// allowedLineNames. Every DB-backed step (employees.area_id -> public.areas ->
// au.sos_area_crosswalk -> source_of_sales_areas) is exercised by the Phase 1 production
// audit and by browser verification, not here — this pins the fail-closed contract that
// doesn't need a database to prove.
export function runTerritoryRootScopeTests() {
  assert.equal(
    deriveOfficialLine(new Set(["Anti Infective"])),
    "Anti Infective",
    "a single resolved line is returned as-is",
  );
  assert.equal(deriveOfficialLine(null), null, "null allowedLineNames fails closed to null, never 'all lines'");
  assert.equal(deriveOfficialLine(new Set()), null, "an empty set (unresolved line) fails closed to null");
  assert.equal(
    deriveOfficialLine(new Set(["CNS", "Pedia"])),
    null,
    "more than one line is ambiguous for this module and fails closed rather than picking one",
  );
}
