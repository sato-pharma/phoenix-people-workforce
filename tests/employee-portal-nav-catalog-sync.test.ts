import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// M12: the employee portal has two independent, hand-maintained nav sources:
//   1. the REAL nav — resolveEmployeePortalNavVisibility + buildEmployeePortalSections
//      (src/components/employee-portal/employee-portal-layout.tsx), which is what an employee
//      actually sees, driven by role-visibility booleans; and
//   2. the nav CATALOG — the "employee-portal" block of src/config/system-navigation.ts, returned
//      by getNavigationSections("employee-portal").
//
// The catalog no longer drives curation — Modules Control and src/lib/employee-portal/
// module-curation.ts were retired — but it is NOT decorative, and two live consumers read it:
//   · the command palette (src/components/layout/command-palette.tsx) builds Cmd/Ctrl+K from it,
//     so a portal page absent from the catalog cannot be reached by search; and
//   · DocumentTitleSync (src/components/layout/document-title-sync.tsx) takes the browser tab
//     title from it, so an absent page shows the bare brand instead of its own label.
//
// Both degrade silently, which is why the two lists drifting apart needs a test rather than a
// bug report. This guard does NOT force the (risky) full consolidation of the two lists — some
// pages have always been deliberately absent from the catalog. Instead it PINS the current
// classification: every real-nav portal href must be either present in the catalog or explicitly
// listed below. A NEW portal page added to the layout without a conscious decision then fails CI,
// and a stale allowlist entry (no longer rendered) is also caught.

// Portal destinations deliberately absent from the catalog. Two groups: (a) core employee pages,
// and (b) role-specific tabs that predate the catalog and were never added to it. Adding a new
// portal page? Either add it to the system-navigation.ts employee-portal catalog (so it is
// searchable and titled) or list it here — this test forces that choice.
const KNOWN_CATALOG_OMISSIONS = new Set<string>([
  // Always-visible core employee pages
  "/employee-portals/payslips",
  "/employee-portals/profile",
  "/employee-portals/excuses",
  "/employee-portals/vacation-request",
  "/employee-portals/vacation-report",
  "/employee-portals/incentive",
  // Role-specific / performance tabs never added to the nav catalog
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

  // (1) Every real-nav portal destination must be classified: present in the catalog OR explicitly
  //     listed in KNOWN_CATALOG_OMISSIONS. A new page added without a decision fails.
  const unclassified = realNavHrefs.filter((href) => !catalogHrefs.has(href) && !KNOWN_CATALOG_OMISSIONS.has(href));
  assert.deepEqual(
    unclassified,
    [],
    `these portal pages are rendered by the real nav but are neither in the employee-portal nav ` +
      `catalog nor listed as deliberate omissions — add each to system-navigation.ts's ` +
      `employee-portal catalog so it is searchable and titled, or to KNOWN_CATALOG_OMISSIONS: ` +
      `${unclassified.join(", ")}`,
  );

  // (2) The allowlist must not rot: every KNOWN_UNCURATABLE entry must still be a real rendered
  //     destination (or in the catalog — a page can graduate to curatable). Otherwise it's stale.
  const realNavSet = new Set(realNavHrefs);
  const staleAllowlist = [...KNOWN_CATALOG_OMISSIONS].filter((href) => !realNavSet.has(href) && !catalogHrefs.has(href));
  assert.deepEqual(
    staleAllowlist,
    [],
    `these KNOWN_CATALOG_OMISSIONS entries are no longer rendered by the portal nav — remove them: ${staleAllowlist.join(", ")}`,
  );

  // (3) The catalog must still reach a live consumer. Curation was retired, so this pins the two
  //     that remain — lose both and the catalog is dead weight and this guard guards nothing.
  const paletteSource = readFileSync("src/components/layout/command-palette.tsx", "utf8");
  assert.match(paletteSource, /getNavigationSections\(/, "the command palette still builds from the nav catalog");
  const titleSource = readFileSync("src/components/layout/document-title-sync.tsx", "utf8");
  assert.match(titleSource, /getNavigationSections\(/, "DocumentTitleSync still builds from the nav catalog");
}
