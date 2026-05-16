import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const salesServiceSource = readFileSync(
  new URL("../src/lib/sales/service.ts", import.meta.url),
  "utf8",
);

export function runSalesAccessScopeTests() {
  assert.match(
    salesServiceSource,
    /if \(salesScope === "TEAM"\) \{\s*const directory = await getEmployeeDirectory\(\{ pageSize: -1 \}\);\s*const managerMap = buildManagerHierarchyMap\(directory\.employees\);\s*const canonicalViewerId = normalizeHrIdForAccess\(currentHrId\);\s*const directReports = canonicalViewerId \? managerMap\.get\(canonicalViewerId\) \?\? \[\] : \[\];/m,
    "DSM sales access must stay limited to direct reports rather than traversing the full hierarchy",
  );

  assert.match(
    salesServiceSource,
    /if \(salesScope === "HIERARCHY"\) \{\s*const directory = await getEmployeeDirectory\(\{ pageSize: -1 \}\);\s*const managerMap = buildManagerHierarchyMap\(directory\.employees\);\s*const canonicalViewerId = normalizeHrIdForAccess\(currentHrId\);\s*const hierarchyHrIds = canonicalViewerId\s*\? collectHierarchyHrIdsFromMap\(managerMap, canonicalViewerId, \{ includeSelf: true \}\)\s*: new Set<string>\(\);/m,
    "RSM sales access must use explicit hierarchy traversal including the manager node",
  );

  assert.match(
    salesServiceSource,
    /if \(salesScope === "LINE"\) \{\s*const directory = await getEmployeeDirectory\(\{ pageSize: -1 \}\);\s*const viewer = directory\.employees\.find\(\s*\(employee\) => normalizeHrIdForAccess\(employee\.hrId\) === normalizeHrIdForAccess\(currentHrId\),\s*\);\s*const lineName = viewer\?\.lineName \?\? null;/m,
    "NSM sales access must derive its scope from the employee directory line before any auth fallback",
  );
}
