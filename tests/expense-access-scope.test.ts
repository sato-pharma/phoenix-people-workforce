import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { buildManagerMap, collectHierarchy } from "../src/lib/outstation/expenses.ts";
import { normalizeHrId } from "../src/lib/auth/permissions.ts";

// A fake org: NSM-1 → {GPM-1, OTHER-1}; GPM-1 → {PM-1}; PM-1 → {MR-1, MR-2}.
// Only hrId + managerHrId are read by buildManagerMap, so a partial row is enough.
const fakeDirectory = {
  employees: [
    { hrId: "NSM-1", managerHrId: null },
    { hrId: "GPM-1", managerHrId: "NSM-1" },
    { hrId: "OTHER-1", managerHrId: "NSM-1" },
    { hrId: "PM-1", managerHrId: "GPM-1" },
    { hrId: "MR-1", managerHrId: "PM-1" },
    { hrId: "MR-2", managerHrId: "PM-1" },
  ],
} as unknown as Parameters<typeof buildManagerMap>[0];

function key(id: string) {
  return normalizeHrId(id) as string;
}

export async function runExpenseAccessScopeTests() {
  const managerMap = buildManagerMap(fakeDirectory);

  // --- GPM sees the full downward chain (PM + the PM's reports), excludes siblings ---
  const gpmDescendants = collectHierarchy(managerMap, "GPM-1");
  assert.ok(gpmDescendants.has(key("PM-1")), "GPM must see the PM reporting to her");
  assert.ok(gpmDescendants.has(key("MR-1")), "GPM must see reps under her PM");
  assert.ok(gpmDescendants.has(key("MR-2")), "GPM must see reps under her PM");
  assert.ok(
    !gpmDescendants.has(key("OTHER-1")),
    "GPM must NOT see a sibling who reports to the same NSM",
  );
  assert.ok(
    !gpmDescendants.has(key("NSM-1")),
    "GPM must NOT see her own manager",
  );
  // collectHierarchy returns descendants only; the resolver adds self separately.
  assert.ok(!gpmDescendants.has(key("GPM-1")), "collectHierarchy excludes the root itself");

  // --- PM sees only her direct + indirect reports ---
  const pmDescendants = collectHierarchy(managerMap, "PM-1");
  assert.deepEqual(
    [...pmDescendants].sort(),
    [key("MR-1"), key("MR-2")].sort(),
    "PM must see exactly her two reps",
  );

  // --- A manager with zero reports (an MR) gets an empty descendant set → self only ---
  const leafDescendants = collectHierarchy(managerMap, "MR-1");
  assert.equal(leafDescendants.size, 0, "a rep with no reports sees no descendants (self only)");

  // --- Source invariant: PM/GPM/TM are routed to HIERARCHY scope, matrix untouched -----
  const src = readFileSync("src/lib/outstation/expenses.ts", "utf8");
  assert.match(
    src,
    /PORTAL_HIERARCHY_EXPENSE_ROLES[\s\S]*"Product Manager"[\s\S]*"Group Product Manager"[\s\S]*"Training Manager"/,
    "PM/GPM/TM must be in the portal-hierarchy expense role set",
  );
  assert.match(
    src,
    /PORTAL_HIERARCHY_EXPENSE_ROLES\.has\(accessContext\.role\)\s*\?\s*"HIERARCHY"/,
    "portal-hierarchy roles must resolve to the HIERARCHY (self + descendants) scope",
  );
}
