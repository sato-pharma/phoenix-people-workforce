import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  canViewMarketingCoverageReport,
  canViewMarketingCoverageReportInAdminShell,
} from "../src/lib/marketing-requests/coverage-report-access.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Source-guard: the coverage report has THREE role sets (viewer / company-wide /
// admin-shell), all centralized in coverage-report-access.ts. This test pins two
// things that unit tests on the functions alone can't: (1) the wiring files
// actually IMPORT the centralized predicates rather than re-declaring their own
// role arrays (the classic way two lists silently drift apart), and (2) the
// runtime behavior of every wired call site agrees with the centralized source.
// ─────────────────────────────────────────────────────────────────────────────

export function runMarketingCoverageReportRoleParityTests() {
  // ── admin-access.ts must import the centralized admin-shell predicate, not
  //    hand-roll its own Set<string>(["Super Admin", "CEO"]) a second time.
  const adminAccessSource = readFileSync("app/(admin)/admin/marketing-requests/admin-access.ts", "utf8");
  assert.match(
    adminAccessSource,
    /canViewMarketingCoverageReportInAdminShell/,
    "admin-access.ts must call the centralized canViewMarketingCoverageReportInAdminShell, not its own role list",
  );

  // ── employee-portal navigation.ts must import the centralized viewer predicate
  //    for the coverage-report tab, not the narrower marketingRequestRoles set
  //    ROI Tracking uses (which excludes Finance Manager / Financial Advisor).
  const navigationSource = readFileSync("src/lib/employee-portal/navigation.ts", "utf8");
  assert.match(
    navigationSource,
    /canUseEmployeePortalMarketingCoverageReport[\s\S]*?canViewMarketingCoverageReport\(/,
    "canUseEmployeePortalMarketingCoverageReport must delegate to the centralized canViewMarketingCoverageReport",
  );

  // ── page-guards.ts must route the "coverage-report" page through that same
  //    portal predicate.
  const pageGuardsSource = readFileSync("src/lib/employee-portal/page-guards.ts", "utf8");
  assert.match(
    pageGuardsSource,
    /"coverage-report"[\s\S]*?canUseEmployeePortalMarketingCoverageReport/,
    "page-guards.ts must route the coverage-report page through canUseEmployeePortalMarketingCoverageReport",
  );

  // ── Runtime agreement: every admin-shell-eligible role must also pass the
  //    broader viewer check (an admin-shell role can never be rejected by the
  //    portal-side gate it might fall back to).
  for (const role of ["CEO", "Super Admin"]) {
    assert.equal(canViewMarketingCoverageReportInAdminShell(role), true);
    assert.equal(canViewMarketingCoverageReport(role), true, `${role} passes the admin-shell gate, so it must also pass the general viewer gate`);
  }

  // ── A role NOT in the viewer set must be rejected by both gates identically.
  assert.equal(canViewMarketingCoverageReport("Employee"), false);
  assert.equal(canViewMarketingCoverageReportInAdminShell("Employee"), false);
}
