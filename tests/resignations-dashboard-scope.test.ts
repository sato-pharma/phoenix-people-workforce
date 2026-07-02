import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

export function runResignationsDashboardScopeTests() {
  const serviceSource = readFileSync("src/lib/resignations/service.ts", "utf8");

  // (a) access stays optional-with-safe-default, matching the resignEmployeeAndOpenVacancy
  // idiom elsewhere in this file (access ?? systemAccessContext), not a required param.
  assert.match(
    serviceSource,
    /export async function getResignationsDashboardData\(access\?:\s*AccessContext\)/,
    "getResignationsDashboardData must keep access?: AccessContext (optional-with-safe-default)",
  );
  assert.match(
    serviceSource,
    /import\s*\{[^}]*systemAccessContext[^}]*\}\s*from\s*["']@\/lib\/auth\/permissions["']/,
    "service.ts must import systemAccessContext from @/lib/auth/permissions",
  );

  // (b) locate the function body and confirm it defaults to systemAccessContext, applies a
  // company-wide bypass for system/company scope + Super Admin/CEO, and otherwise actually
  // filters with canSeeEmployee (not the raw, possibly-undefined `access`).
  const fnStart = serviceSource.indexOf("export async function getResignationsDashboardData");
  assert.ok(fnStart >= 0, "could not locate getResignationsDashboardData in service.ts");
  const nextFnStart = serviceSource.indexOf("\nexport async function", fnStart + 1);
  const fnBody = serviceSource.slice(fnStart, nextFnStart > 0 ? nextFnStart : serviceSource.length);

  assert.match(
    fnBody,
    /const scopedAccess = access \?\? systemAccessContext;/,
    "getResignationsDashboardData must default to systemAccessContext when access is omitted",
  );
  assert.match(
    fnBody,
    /isCompanyResignationReader\(scopedAccess\)/,
    "getResignationsDashboardData must gate the unscoped branch through isCompanyResignationReader",
  );
  assert.match(
    fnBody,
    /canSeeEmployee\(scopedAccess,\s*employee\)/,
    "the non-company-reader branch must filter with canSeeEmployee(scopedAccess, employee)",
  );
  assert.doesNotMatch(
    fnBody,
    /canSeeEmployee\(access,\s*employee\)/,
    "must not filter with the raw (possibly-undefined) access — use scopedAccess",
  );

  // (c) isCompanyResignationReader mirrors contracts/service.ts's isCompanyContractReader:
  // system/company scope or Super Admin/CEO see everything; no bare role checks are skipped.
  assert.match(
    serviceSource,
    /function isCompanyResignationReader\(access: AccessContext\) \{[\s\S]{0,300}access\.scope === "system"[\s\S]{0,300}access\.scope === "company"[\s\S]{0,300}access\.role === "Super Admin"[\s\S]{0,300}access\.role === "CEO"/,
    "isCompanyResignationReader must allow system/company scope and Super Admin/CEO roles",
  );

  // (d) every previously-silent call site now threads a real access context through.
  const callSites: Array<{ file: string; pattern: RegExp }> = [
    { file: "app/api/resignations/route.ts", pattern: /getResignationsDashboardData\(access\)/g },
    { file: "app/(admin)/resignations/page.tsx", pattern: /getResignationsDashboardData\(access\)/ },
    { file: "app/api/resignations/[id]/workflow/route.ts", pattern: /getResignationsDashboardData\(access\)/ },
    { file: "app/api/resignations/[id]/dates/route.ts", pattern: /getResignationsDashboardData\(access\)/ },
    { file: "app/api/approvals-hub/hub-data/route.ts", pattern: /getResignationsDashboardData\(viewAccess\)/ },
    { file: "src/lib/admin/command-center.ts", pattern: /getResignationsDashboardData\(accessContext\)/ },
    { file: "src/lib/ceo/command-center.ts", pattern: /getResignationsDashboardData\(access\)/ },
  ];

  for (const { file, pattern } of callSites) {
    const source = readFileSync(file, "utf8");
    assert.match(source, pattern, `${file} must call getResignationsDashboardData with its resolved access context`);
  }

  // (e) the GET call site in app/api/resignations/route.ts is used twice (GET + POST) —
  // confirm both call sites were updated, not just one.
  const resignationsRouteSource = readFileSync("app/api/resignations/route.ts", "utf8");
  const matches = resignationsRouteSource.match(/getResignationsDashboardData\(access\)/g) ?? [];
  assert.equal(matches.length, 2, "both GET and POST in app/api/resignations/route.ts must pass access");

  // (f) action-center's call sites already passed access before this fix — regression sentinel
  // that they still do, so the two working sites aren't silently regressed.
  const actionCenterSource = readFileSync("src/lib/action-center/service.ts", "utf8");
  assert.match(
    actionCenterSource,
    /getResignationsDashboardData\(access\)/,
    "src/lib/action-center/service.ts must keep passing access to getResignationsDashboardData",
  );
}
