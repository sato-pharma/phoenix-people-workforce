import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isEmployeePortalOwnedRoute } from "../src/lib/employee-portal/routes.ts";

/**
 * Guard against drift between the mobile bottom nav and the canonical portal
 * navigation. The bottom nav keeps its own curated, priority-ordered hrefs; this
 * test ensures every one of them is (a) an employee-portal owned route and
 * (b) still present in the sidebar/layout nav, so a route rename can't silently
 * leave the bottom bar pointing at a dead link.
 */
function extractHrefs(source: string): string[] {
  const objectHrefs = Array.from(source.matchAll(/href:\s*"([^"]+)"/g)).map((match) => match[1]);
  const jsxHrefs = Array.from(source.matchAll(/href="([^"]+)"/g)).map((match) => match[1]);
  return [...objectHrefs, ...jsxHrefs].filter((href) => href.startsWith("/"));
}

export function runEmployeePortalBottomNavTests() {
  const bottomNavSource = readFileSync(
    "src/components/employee-portal/employee-portal-bottom-nav.tsx",
    "utf8",
  );
  const layoutSource = readFileSync(
    "src/components/employee-portal/employee-portal-layout.tsx",
    "utf8",
  );

  const bottomNavHrefs = [...new Set(extractHrefs(bottomNavSource))];
  assert.ok(bottomNavHrefs.length >= 3, "bottom nav should declare navigable hrefs");

  // The bottom nav must be mobile-only and never take over the desktop sidebar.
  assert.match(bottomNavSource, /lg:hidden/, "bottom nav must be hidden on lg+ (sidebar territory)");
  // Safe-area handling must remain so the bar clears the iOS home indicator.
  assert.match(
    bottomNavSource,
    /env\(safe-area-inset-bottom\)/,
    "bottom nav must pad for the iOS safe area",
  );

  const layoutHrefs = new Set(extractHrefs(layoutSource));

  for (const href of bottomNavHrefs) {
    assert.ok(
      isEmployeePortalOwnedRoute(href),
      `bottom nav href ${href} must be an employee-portal owned route`,
    );
    assert.ok(
      layoutHrefs.has(href),
      `bottom nav href ${href} must also exist in the employee portal sidebar/layout nav (keep in sync)`,
    );
  }
}
