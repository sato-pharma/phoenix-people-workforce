import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const portalServiceSource = readFileSync(
  new URL("../src/lib/employee-portal/service.ts", import.meta.url),
  "utf8",
);

export function runEmployeePortalAccessScopeTests() {
  assert.match(
    portalServiceSource,
    /function scopePortalVacancyRows(?:<[\s\S]*?>)?\(/,
    "Employee portal must expose a shared vacancy scoping helper for workforce roles",
  );

  assert.match(
    portalServiceSource,
    /if \(isLineWorkforceRole\(role\)\) \{[\s\S]*?if \(isHierarchyWorkforceRole\(role\)\) \{[\s\S]*?if \(isTeamWorkforceRole\(role\)\) \{/m,
    "Portal vacancy scoping must handle NSM line access, RSM hierarchy access, and DSM team access explicitly in one helper",
  );

  assert.match(
    portalServiceSource,
    /const isRsm = currentRole === "Regional Sales Manager";\s*if \(!isDsm && !isNsm && !isRsm\) return null;/m,
    "Portal vacancy view must allow the RSM layer instead of excluding it from the detailed access path",
  );

  assert.match(
    portalServiceSource,
    /const scopedRows = scopePortalVacancyRows\(\{\s*currentUser,\s*directory,\s*employee: currentEmployee,\s*rows: vacancyRows,\s*\}\);/m,
    "Portal detailed vacancies must reuse the shared scope helper so RSM and NSM access stay aligned",
  );

  assert.match(
    portalServiceSource,
    /roleView: isNsm \? "nsm" : isRsm \? "rsm" : "dsm"/,
    "Portal vacancy role view must distinguish the new RSM layer explicitly",
  );
}
