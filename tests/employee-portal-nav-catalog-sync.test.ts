import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// M12: the employee portal has two independent, hand-maintained nav sources:
//   1. the REAL nav — resolveEmployeePortalNavVisibility + buildEmployeePortalSections
//      (src/components/employee-portal/employee-portal-layout.tsx), which is what an employee
//      actually sees, driven by role-visibility booleans; and
//   2. the Modules Control CATALOG — the "employee-portal" block of
//      src/config/system-navigation.ts, which src/lib/employee-portal/module-curation.ts reads
//      (post-#1005) to decide, by href, whether an admin-configured curation hides a destination.
//
// Because curation matches by href against the catalog, a portal page in the REAL nav but ABSENT
// from the catalog is silently UN-curatable — it stays always-visible no matter what an admin
// configures. #1005 made this a documented, graceful degradation rather than a crash, but the two
// lists can still drift with no signal.
//
// This guard does NOT force the (risky) full consolidation of the two lists — some pages SHOULD be
// permanently always-visible (an admin must not be able to hide an employee's own payslips), so they
// are intentionally kept out of the catalog. Instead it PINS the current classification: every real-
// nav portal href must be either present in the catalog (curatable) or explicitly listed below as
// intentionally uncuratable. A NEW portal page added to the layout without a conscious decision then
// fails CI, and a stale allowlist entry (no longer rendered) is also caught.

// Portal destinations intentionally NOT curatable via Modules Control (absent from the catalog by
// design). Two groups: (a) always-visible core pages an admin must never be able to hide, and
// (b) role-specific tabs that predate the catalog and were never added to it. Adding a new portal
// page? Either add it to the system-navigation.ts employee-portal catalog (to make it curatable) or
// list it here (to keep it always-visible) — this test forces that choice.
const KNOWN_UNCURATABLE = new Set<string>([
  // Always-visible core employee pages
  "/employee-portals/payslips",
  "/employee-portals/profile",
  "/employee-portals/excuses",
  "/employee-portals/vacation-request",
  "/employee-portals/vacation-report",
  "/employee-portals/incentive",
  // Role-specific / performance tabs never added to the Modules Control catalog
  "/employee-portals/dsms-performance",
  "/employee-portals/med-reps-performance",
  "/employee-portals/team-performance",
  "/employee-portals/team-calendar",
  "/employee-portals/fingerprint-analytics",
  "/employee-portals/plans/calendar",
  "/employee-portals/training-manager/coaching",
]);

function extractPortalHrefs(source: string): string[] {
  const objectHrefs = Array.from(source.matchAll(/href:\s*"([^"]+)"/g)).map((m) => m[1]);
  const jsxHrefs = Array.from(source.matchAll(/href="([^"]+)"/g)).map((m) => m[1]);
  return [...new Set([...objectHrefs, ...jsxHrefs])].filter((href) => href.startsWith("/employee-portals"));
}

export function runEmployeePortalNavCatalogSyncTests() {
  const layoutSource = readFileSync("src/components/employee-portal/employee-portal-layout.tsx", "utf8");
  const catalogSource = readFileSync("src/config/system-navigation.ts", "utf8");

  const realNavHrefs = extractPortalHrefs(layoutSource);
  assert.ok(realNavHrefs.length >= 20, "the real portal nav should declare its destinations");

  // The catalog block is scoped to just the employee-portal section seeds so an admin-shell href
  // that happens to share a path can't accidentally satisfy the check.
  const catalogBlock = catalogSource.slice(
    catalogSource.indexOf("employeePortalNavigationSectionSeeds"),
  );
  const catalogHrefs = new Set(extractPortalHrefs(catalogBlock));

  // (1) Every real-nav portal destination must be classified: curatable (in the catalog) OR
  //     explicitly always-visible (in KNOWN_UNCURATABLE). A new page added without a decision fails.
  const unclassified = realNavHrefs.filter((href) => !catalogHrefs.has(href) && !KNOWN_UNCURATABLE.has(href));
  assert.deepEqual(
    unclassified,
    [],
    `these portal pages are rendered by the real nav but are neither in the Modules Control catalog ` +
      `nor listed as intentionally uncuratable — add each to system-navigation.ts's employee-portal ` +
      `catalog to make it curatable, or to KNOWN_UNCURATABLE to keep it always-visible: ${unclassified.join(", ")}`,
  );

  // (2) The allowlist must not rot: every KNOWN_UNCURATABLE entry must still be a real rendered
  //     destination (or in the catalog — a page can graduate to curatable). Otherwise it's stale.
  const realNavSet = new Set(realNavHrefs);
  const staleAllowlist = [...KNOWN_UNCURATABLE].filter((href) => !realNavSet.has(href) && !catalogHrefs.has(href));
  assert.deepEqual(
    staleAllowlist,
    [],
    `these KNOWN_UNCURATABLE entries are no longer rendered by the portal nav — remove them: ${staleAllowlist.join(", ")}`,
  );

  // (3) module-curation.ts must still be the single consumer that matches curation by href against
  //     this catalog (the mechanism this guard protects). If that wiring changes, revisit this test.
  const curationSource = readFileSync("src/lib/employee-portal/module-curation.ts", "utf8");
  assert.match(curationSource, /getNavigationSections\("employee-portal"\)/, "module-curation reads the employee-portal catalog");
}
