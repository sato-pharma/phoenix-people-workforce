import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isEmployeePortalOwnedRoute } from "../src/lib/employee-portal/routes.ts";

/**
 * Guard against drift between the portal nav registry (which feeds the mobile
 * bottom nav and the profile quick-navigation customizer) and the canonical
 * sidebar/layout nav. Every registry href must be (a) an employee-portal owned
 * route and (b) still present in the layout nav, so a route rename can't silently
 * leave the bottom bar pointing at a dead link.
 */
function extractHrefs(source: string): string[] {
  const objectHrefs = Array.from(source.matchAll(/href:\s*"([^"]+)"/g)).map((match) => match[1]);
  const jsxHrefs = Array.from(source.matchAll(/href="([^"]+)"/g)).map((match) => match[1]);
  return [...objectHrefs, ...jsxHrefs].filter((href) => href.startsWith("/"));
}

export function runEmployeePortalBottomNavTests() {
  const registrySource = readFileSync(
    "src/components/employee-portal/employee-portal-nav-registry.ts",
    "utf8",
  );
  const bottomNavSource = readFileSync(
    "src/components/employee-portal/employee-portal-bottom-nav.tsx",
    "utf8",
  );
  const layoutSource = readFileSync(
    "src/components/employee-portal/employee-portal-layout.tsx",
    "utf8",
  );

  const registryHrefs = [...new Set(extractHrefs(registrySource))];
  assert.ok(registryHrefs.length >= 5, "nav registry should declare navigable hrefs");

  const layoutHrefs = new Set(extractHrefs(layoutSource));

  // Intentional cross-surface destinations: routes the portal nav surfaces that live on
  // the ADMIN shell. These are full-page links, not portal-owned (so isEmployeePortalOwnedRoute
  // is correctly false — the layout must NOT client-side nav into the admin shell). They are
  // exempt from the ownership check but still subject to the dead-link guard below.
  const crossSurfaceAdminRoutes = new Set<string>();

  for (const href of registryHrefs) {
    assert.ok(
      isEmployeePortalOwnedRoute(href) || crossSurfaceAdminRoutes.has(href),
      `registry href ${href} must be an employee-portal owned route (or an allowlisted cross-surface admin link)`,
    );
    assert.ok(
      layoutHrefs.has(href),
      `registry href ${href} must also exist in the employee portal sidebar/layout nav (keep in sync)`,
    );
  }

  // The bottom nav must remain mobile-only, safe-area aware, and preference-driven.
  assert.match(bottomNavSource, /lg:hidden/, "bottom nav must be hidden on lg+ (sidebar territory)");
  assert.match(
    bottomNavSource,
    /env\(safe-area-inset-bottom\)/,
    "bottom nav must pad for the iOS safe area",
  );
  assert.match(
    bottomNavSource,
    /useBottomNavPreference/,
    "bottom nav must honor the user's pinned-shortcut preference",
  );
}
