import assert from "node:assert/strict";

import type { EmployeeDirectoryRow } from "../src/lib/employees/employee-directory.ts";
import {
  buildCrmIdentityMaps,
  normalizeCrmName,
  resolveEmployeeHrId,
  type CrmResolutionRow,
} from "../src/lib/crm/identity.ts";
import { CRM_DOUBLE_VISIT_TYPE_CODES, isCrmDoubleVisitRow } from "../src/lib/crm/reads.ts";

/** Minimal directory row — the identity maps only read crmId / crmUsername / hrId. */
function emp(hrId: string, crmId: string | null, crmUsername: string | null): EmployeeDirectoryRow {
  return { crmId, crmUsername, hrId } as unknown as EmployeeDirectoryRow;
}

export function runCrmIdentityTests() {
  // normalizeCrmName: trim + lowercase + collapse whitespace runs (a stray double space in the
  // CRM's own display text must not split the same person).
  assert.equal(normalizeCrmName("  Alex   East / P  "), "alex east / p");
  assert.equal(normalizeCrmName(""), null);
  assert.equal(normalizeCrmName(null), null);

  const employees: EmployeeDirectoryRow[] = [
    emp("B-1", "100", "Alex East / P"),
    emp("B-2", "200", "Sara Ali / F"),
    // Two employees share a display name → that username is ambiguous and must be dropped.
    emp("B-3", null, "Dup Name"),
    emp("B-4", null, "Dup Name"),
  ];
  const resolutions: CrmResolutionRow[] = [{ crmId: 100, mappedHrId: "B-99", status: "mapped" }];
  const maps = buildCrmIdentityMaps(employees, resolutions);

  // Ambiguous username excluded; unique ones kept.
  assert.equal(maps.hrIdByCrmUsername.has("dup name"), false, "ambiguous username dropped, never guessed");
  assert.equal(maps.hrIdByCrmUsername.get("sara ali / f"), "B-2");
  assert.equal(maps.hrIdByManualOverride.get("100"), "B-99");

  // Tier 1 — manual override wins over everything, even a valid crm_id match.
  assert.equal(resolveEmployeeHrId(100, "Alex East / P", maps), "B-99", "manual override wins");

  // Tier 2 — crm_id match (no override). Works with NO name (the check-in path).
  assert.equal(resolveEmployeeHrId(200, "Sara Ali / F", maps), "B-2", "crm_id match");
  assert.equal(resolveEmployeeHrId(200, null, maps), "B-2", "crm_id resolves even without a name (check-in path)");

  // Tier 3 — unique crm_username fallback when crm_id is unknown.
  assert.equal(resolveEmployeeHrId(999, "Sara Ali / F", maps), "B-2", "unique username fallback");

  // Ambiguous username → null (safety: never manufacture a wrong mapping).
  assert.equal(resolveEmployeeHrId(null, "Dup Name", maps), null, "ambiguous username → unresolved");

  // Check-in path with no crm_id match and no name → null (no username to fall back on).
  assert.equal(resolveEmployeeHrId(888, null, maps), null, "no id match + no name → unresolved");

  // Double-visit predicate: the single shared definition (Regular 0 / Campaign -8 with a real partner).
  assert.deepEqual([...CRM_DOUBLE_VISIT_TYPE_CODES], [0, -8], "only Regular(0)/Campaign(-8) count");
  assert.equal(isCrmDoubleVisitRow({ double_crm_id: 5, visit_type: 0 }), true);
  assert.equal(isCrmDoubleVisitRow({ double_crm_id: 5, visit_type: -8 }), true);
  assert.equal(isCrmDoubleVisitRow({ double_crm_id: 0, visit_type: 0 }), false, "double_crm_id 0 is no partner");
  assert.equal(isCrmDoubleVisitRow({ double_crm_id: null, visit_type: 0 }), false, "no partner");
  assert.equal(isCrmDoubleVisitRow({ double_crm_id: 5, visit_type: -11 }), false, "meeting is not fieldwork");
  assert.equal(isCrmDoubleVisitRow({ double_crm_id: 5, visit_type: null }), false, "null visit_type");
}
