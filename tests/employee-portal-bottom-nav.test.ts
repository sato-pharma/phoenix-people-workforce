import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BOTTOM_BAR_REFERENCE_WIDTH,
  BOTTOM_BAR_TABS,
  bottomBarWordBudgetPx,
  FALLBACK_LABEL_FONT_FAMILY,
  SIDEBAR_LABEL_SNAPSHOT_PATH,
} from "../src/config/sidebar-metrics.ts";
import { isEmployeePortalOwnedRoute } from "../src/lib/employee-portal/routes.ts";
import {
  HOME_ENTRY,
  MAX_BOTTOM_NAV_CUSTOM,
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
  // New labels are constrained by width as well, though NOT the way this comment first claimed:
  // there is no per-tab allowance to divide 375px into. Each <li> is `flex-1` with the default
  // `min-width: auto`, so a narrow tab hands its unused share to a wide one and the only thing the
  // viewport must hold is the SUM of the six floors — which is why a 60px "Direct Order" renders
  // perfectly beside a 29px "Home". The real check is the width sweep at the end of this function.
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

  // ── the wrap itself, pinned ──────────────────────────────────────────────────
  //
  // Everything above measures a bar whose labels WRAP: the floors in the snapshot are longest
  // words, not whole labels. Re-add `whitespace-nowrap` and each real floor silently becomes the
  // full label again while this sweep keeps certifying the shorter one — a guard measuring a layout
  // the app no longer has, which is the same shape of failure tests/sidebar-label-font-sync.test.ts
  // exists to catch on the two rails. So pin the three classes the model depends on.
  const labelSpan = bottomNavSource
    .split("\n")
    .find((line) => line.includes("<span className=") && line.includes("leading-tight"));
  assert.ok(
    labelSpan,
    "could not find the bottom-bar label span in employee-portal-bottom-nav.tsx — re-point this " +
      "matcher rather than deleting it, or the width sweep goes back to measuring whatever it likes",
  );
  assert.ok(
    !labelSpan.includes("whitespace-nowrap"),
    "the bottom-bar label must WRAP — on `whitespace-nowrap` the worst-case six tabs floored at " +
      "367px and scrolled a 360px phone sideways. Every floor in the snapshot is a longest word, so " +
      "this class would make the width sweep certify a bar that no longer exists.",
  );
  assert.ok(
    !labelSpan.includes("truncate"),
    "the bottom-bar label must never ellipsise — that is a standing owner rule, and it would also " +
      "hide an overflow from the width sweep instead of failing it",
  );
  assert.ok(
    labelSpan.includes("h-[26px]"),
    "the bottom-bar label box must stay a fixed two lines tall (26px — a wrapped label measures " +
      "scrollHeight 26 against a 25px box, so two 12.5px line boxes are a pixel short) — without it " +
      "a tab whose label wraps " +
      "is taller than its neighbours and `justify-center` puts every icon at a different height",
  );

  // ── the bar must fit the narrowest mainstream phone, whole ───────────────────
  //
  // The owner's golden rule is that a screen never scrolls sideways, and this bar broke it
  // silently. Six tabs is the ceiling and each <li> floors at its own content, so the constraint is
  // the SUM of those floors. On `whitespace-nowrap` the worst case summed to 367px — it cleared a
  // 375px iPhone by 8px and overflowed a 360px Android, the most common width there is. The label
  // now wraps, which drops each floor to the longest WORD; this sweep is what stops the next long
  // label quietly spending the headroom that bought back.
  //
  // Measured, not modelled: widths come from the snapshot `pnpm run ui:measure-sidebar-labels`
  // writes in real Chromium at the bar's own 10px/900, in two faces, because the stack draws with the
  // first family a phone can see and one width only describes the machine that took it. The bar has
  // to fit in both: the script's face and Arial, where a phone with none of the earlier families
  // lands. A label with no entry FAILS rather than being skipped, so adding one cannot bypass the check.
  assert.equal(
    BOTTOM_BAR_TABS,
    2 + MAX_BOTTOM_NAV_CUSTOM,
    "the width model assumes Home + MAX_BOTTOM_NAV_CUSTOM + Profile — raising the pin limit without " +
      "re-deriving BOTTOM_BAR_TABS leaves the sweep measuring a narrower bar than the one that ships",
  );

  // The label box reserves exactly two lines. Words never break, so a three-word label is the one
  // shape that would overflow it vertically rather than horizontally — invisible to a width sweep.
  const tooManyWords = allEntries.filter((entry) => entry.label.split(" ").filter(Boolean).length > 2);
  assert.deepEqual(
    tooManyWords.map((entry) => `${entry.label} (${entry.href})`),
    [],
    "a bottom-bar label may be at most two words — the span is a fixed two lines tall and words do not break",
  );

  type BarFloors = Record<string, number>;
  const snapshot = JSON.parse(readFileSync(SIDEBAR_LABEL_SNAPSHOT_PATH, "utf8")) as {
    "bottom-bar"?: BarFloors;
    fallback?: { "bottom-bar"?: BarFloors };
  };
  const faces: [string, BarFloors | undefined][] = [
    ["the measuring machine's face", snapshot["bottom-bar"]],
    [FALLBACK_LABEL_FONT_FAMILY, snapshot.fallback?.["bottom-bar"]],
  ];

  const budget = bottomBarWordBudgetPx();
  for (const [face, floors] of faces) {
    assert.ok(
      floors && Object.keys(floors).length > 0,
      `${SIDEBAR_LABEL_SNAPSHOT_PATH} holds no "bottom-bar" map in ${face} — run pnpm run ui:measure-sidebar-labels`,
    );

    const unmeasured = allEntries
      .filter((entry) => typeof floors[entry.label] !== "number")
      .map((entry) => entry.label);
    assert.deepEqual(
      [...new Set(unmeasured)],
      [],
      `every bottom-bar label needs a measured floor in ${face} — run \`pnpm run ui:measure-sidebar-labels\` after adding or renaming one`,
    );

    // Worst case: the two fixed ends plus the four widest floors anything could be pinned to.
    const widestFour = allEntries
      .map((entry) => ({ label: entry.label, px: floors[entry.label] }))
      .sort((a, b) => b.px - a.px)
      .slice(0, BOTTOM_BAR_TABS - 2);
    const worstBar = [
      { label: HOME_ENTRY.label, px: floors[HOME_ENTRY.label] },
      ...widestFour,
      { label: PROFILE_ENTRY.label, px: floors[PROFILE_ENTRY.label] },
    ];
    const needed = worstBar.reduce((sum, tab) => sum + tab.px, 0);
    assert.ok(
      needed <= budget,
      `the worst-case bottom bar needs ${needed}px of label in ${face} but only ${budget}px fits at ` +
        `${BOTTOM_BAR_REFERENCE_WIDTH}px (${needed - budget}px over) — ` +
        `${worstBar.map((tab) => `${tab.label} ${tab.px}`).join(" | ")}. Shorten a label or merge two ` +
        `tabs; do NOT shrink the type or reach for an ellipsis, both are owner rules.`,
    );
  }

  // Pin the arithmetic the assertion above rests on, so narrowing the reference or growing the
  // chrome cannot quietly make the sweep generous.
  assert.equal(bottomBarWordBudgetPx(360), 304, "360px less the ul's px-1 and six tabs of chrome");
}
