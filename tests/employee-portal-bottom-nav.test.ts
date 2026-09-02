import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isEmployeePortalOwnedRoute } from "../src/lib/employee-portal/routes.ts";
import {
  HOME_ENTRY,
  PORTAL_NAV_REGISTRY,
  PROFILE_ENTRY,
} from "../src/components/employee-portal/employee-portal-nav-registry.ts";

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
    // HR Forms: the same Talent-Acquisition-only class, and it is the least mobile page in
    // the module — a long statutory data-entry form whose only output is paper. Nobody prints four
    // contracts and three duplex Form 1s from a phone. Desk work by definition.
    "/employee-portals/hiring-pack",
    // Job Offers: the same Talent-Acquisition-only class as HR Forms, and the same kind of
    // work. One tab designs an A4 letter block by block against a live page preview, one sets the
    // cost-of-living figure every salary is derived from, and one sends a binding offer to a
    // candidate's inbox. The offers list renders as cards on a phone so the page works there; it is
    // simply not something anyone should reach for from a bottom-nav shortcut.
    "/employee-portals/offers",
    // Inbound Intake Health: same Talent-Acquisition-only class again, and it is a wide read-only
    // table (a 30-day funnel plus the dead-letter list). Desk work, not a phone shortcut.
    "/employee-portals/intake-health",
    // Missing Contact Details: the same Talent-Acquisition-only class, and reviewing a proposed
    // email against the CV it came from is desk work. The page still renders cards on a phone —
    // it is simply not a bottom-nav shortcut.
    "/employee-portals/contact-review",
    // Manager CV Engagement: the silent NSM oversight report (who opened / answered / ignored the
    // CVs sent to them). A wide read-only table — desk work, same class as Inbound Intake Health
    // above, not a phone bottom-nav shortcut. Renders cards on a phone; simply not pinnable.
    "/employee-portals/recruitment-engagement",
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
  // ── Two tabs must never read the same ────────────────────────────────────────
  //
  // The bar renders `label` (the short one) while the customizer that picks the tabs renders
  // `fullLabel`. So a person pinned two entries that looked different where they chose them and
  // got two tabs reading identically: measured before this guard, four labels covered eight
  // hrefs — "Coaching" x3, plus "Vacation", "Excuses" and "Expenses" twice each. Nothing caught
  // it, because the React key is `${label}-${href}` and the hrefs do differ.
  //
  // Uniqueness is asserted over the WHOLE registry rather than over some co-visible subset: the
  // flags are independent booleans resolved per viewer, several entries carry no flag at all and
  // are therefore always offered, and any combination of four can be pinned. There is no subset
  // worth reasoning about.
  //
  // New labels are constrained by width as well: the bar is six tabs at most (Home + four pinned
  // + Profile) and at 375px that is ~49px of text per tab at 10px/900. Re-measure with the probe
  // in scripts/measure-sidebar-labels.ts rather than guessing a short form.
  const allEntries = [HOME_ENTRY, PROFILE_ENTRY, ...PORTAL_NAV_REGISTRY];
  assert.ok(allEntries.length >= 50, `the sweep must see the whole registry, saw ${allEntries.length}`);

  for (const field of ["label", "fullLabel"] as const) {
    const byText = new Map<string, string[]>();
    for (const entry of allEntries) {
      byText.set(entry[field], [...(byText.get(entry[field]) ?? []), entry.href]);
    }
    for (const [text, hrefs] of byText) {
      assert.equal(
        hrefs.length,
        1,
        `${field} "${text}" is used by ${hrefs.length} portal nav entries -> ${hrefs.join(" , ")}`,
      );
    }
  }
}
