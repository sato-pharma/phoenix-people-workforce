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

  // ── Reverse direction: every SIDEBAR destination must be in the registry ────────────────
  // This half was missing until 2026-07-30 and the drift it allowed was real: Weekly Sales, Sales
  // Analytics, Territory & Sales Drilldown, My Visits and Team Calendar all lived in the sidebar
  // with no registry entry, so the mobile bottom bar and the profile quick-nav grid could not reach
  // them on any device — a Regional Manager's default bottom bar contained zero sales tabs. Checking
  // only registry -> sidebar (above) can never catch that: a missing entry is not a dead link.
  const registryHrefSet = new Set(registryHrefs);
  // Fixed bottom-bar anchors: present in the layout, intentionally not user-pinnable.
  const bottomNavAnchors = new Set(["/employee-portals", "/employee-portals/profile"]);
  // Talent-Acquisition-only desktop tools plus Private Calendar (deliberately unlinked for every
  // other role). These are desktop-workflow pages, not mobile shortcuts; if one is ever wanted on
  // mobile, add it to the registry and drop it from here — do not widen this set casually.
  const desktopOnlyPortalRoutes = new Set([
    "/employee-portals/private-calendar",
    "/employee-portals/recruitment",
    "/employee-portals/cv-database",
    "/employee-portals/hiring-documents",
    // Inbound Intake Health: same Talent-Acquisition-only class again, and it is a wide read-only
    // table (a 30-day funnel plus the dead-letter list). Desk work, not a phone shortcut.
    "/employee-portals/intake-health",
    "/employee-portals/employees",
    "/employee-portals/contracts",
    "/employee-portals/resignations",
    "/employee-portals/account-activation",
    "/employee-portals/support-requests",
  ]);

  for (const href of new Set(extractHrefs(layoutSource))) {
    if (!href.startsWith("/employee-portals")) continue;
    if (bottomNavAnchors.has(href) || desktopOnlyPortalRoutes.has(href)) continue;
    assert.ok(
      registryHrefSet.has(href),
      `sidebar href ${href} is missing from PORTAL_NAV_REGISTRY, so the mobile bottom nav and the profile quick-nav grid cannot reach it — add an entry (or add it to desktopOnlyPortalRoutes with a reason)`,
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
