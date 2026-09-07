import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { employeePortalNavigationSections } from "@/config/system-navigation.ts";
import {
  HOME_ENTRY,
  PORTAL_NAV_REGISTRY,
  PROFILE_ENTRY,
} from "@/components/employee-portal/employee-portal-nav-registry.ts";

/**
 * Pending-count badges on the mobile bottom bar.
 *
 * The portal sidebar has badged its approval queues for months; the bottom bar carried none, for
 * any of them. On a phone that bar IS the navigation, so a queue with nothing on its tab is a queue
 * nobody is told about — the exact failure the sidebar badges exist to prevent, on the surface where
 * it costs most. Owner, 2026-09-07: "add the badge to the mobile bottom bar too."
 *
 * The registry keeps a MIRRORED copy of each destination's `navBadge`, the same way it mirrors
 * `permission`. This test is what stops the copy drifting — in BOTH directions, because a badge
 * added to a nav row and forgotten in the registry shows up as one surface counting while the other
 * stays silent, which reads as "nothing is waiting" rather than as a bug.
 */

/** Every portal nav row that declares a badge, by href. The seeds are the authority. */
function seedBadgeByHref(): Map<string, string> {
  const byHref = new Map<string, string>();
  for (const section of employeePortalNavigationSections) {
    for (const item of section.items) {
      if (item.navBadge) byHref.set(item.href, item.navBadge);
    }
  }
  return byHref;
}

export function runEmployeePortalBottomNavBadgesTests() {
  const seeds = seedBadgeByHref();
  const registry = [...PORTAL_NAV_REGISTRY, HOME_ENTRY, PROFILE_ENTRY];
  const registryByHref = new Map(registry.map((entry) => [entry.href, entry]));

  // ── 1. The authority is not empty ───────────────────────────────────────────
  // Without this, every loop below passes vacuously if the seeds stop declaring badges or the
  // shape this test reads them out of changes — a green run proving nothing at all.
  assert.ok(
    seeds.size >= 5,
    `expected the portal nav seeds to declare several badges, found ${seeds.size} — has the shape changed?`,
  );

  // ── 2. Every badged nav row carries the same badge in the registry ──────────
  // This is the direction that goes wrong silently: a new badge lands on the sidebar row, nobody
  // touches the registry, and the bottom bar shows nothing for a queue that is counting elsewhere.
  {
    const missing: string[] = [];
    const disagreeing: string[] = [];
    for (const [href, badge] of seeds) {
      const entry = registryByHref.get(href);
      // A destination the bottom bar deliberately does not offer at all is not a drift — it has no
      // tab to carry a badge. Only a destination the bar CAN show is covered here.
      if (!entry) continue;
      if (!entry.navBadge) missing.push(`${href} (nav row has "${badge}", registry has none)`);
      else if (entry.navBadge !== badge) {
        disagreeing.push(`${href} (nav row "${badge}" vs registry "${entry.navBadge}")`);
      }
    }
    assert.deepEqual(
      missing,
      [],
      "a nav row's badge is missing from the bottom-bar registry — that queue counts in the sidebar and is silent on a phone",
    );
    assert.deepEqual(disagreeing, [], "the registry and the nav row disagree about which badge a destination carries");
  }

  // ── 3. And nothing in the registry invents a badge of its own ───────────────
  {
    const invented = registry
      .filter((entry) => entry.navBadge && seeds.get(entry.href) !== entry.navBadge)
      .map((entry) => `${entry.href} (registry "${entry.navBadge}", nav row "${seeds.get(entry.href) ?? "none"}")`);
    assert.deepEqual(
      invented,
      [],
      "the bottom bar must not badge a destination the navigation itself does not badge — the seeds are the authority",
    );
  }

  // ── 4. The Awareness queue is one of them ───────────────────────────────────
  // The destination that prompted this, named rather than left to the loops: it is the one a
  // regression would most plausibly drop, being the newest, and "the loop passed" would not say so.
  {
    const awareness = registryByHref.get("/employee-portals/market-awareness/inbox");
    assert.ok(awareness, "4: Awareness Approvals must still be a bottom-bar destination");
    assert.equal(
      awareness.navBadge,
      "market-awareness-approvals-pending",
      "4: Awareness Approvals must carry its badge on the bottom bar",
    );
  }

  // ── 5. The bar renders it through the ONE shared badge pump ─────────────────
  {
    const bottomNav = readFileSync(
      "src/components/employee-portal/employee-portal-bottom-nav.tsx",
      "utf8",
    );
    assert.match(
      bottomNav,
      /import \{ ApprovalNavBadge \} from "@\/components\/layout\/nav-badge";/,
      "5: the bar must reuse the shared badge switch — no second mechanism, no second poll",
    );
    assert.match(
      bottomNav,
      /<ApprovalNavBadge compact navBadge=\{item\.navBadge\} \/>/,
      "5: every tab must offer its own badge, so a future badge needs no edit here",
    );
  }

  // ── 6. The COMPACT dot, never the count pill ────────────────────────────────
  // Six tabs share a 375px bar and every label is already wrapped to fit it. A pill takes its width
  // out of the label, and the golden rule forbids both shrinking the type and truncating it.
  {
    const bottomNav = readFileSync(
      "src/components/employee-portal/employee-portal-bottom-nav.tsx",
      "utf8",
    );
    assert.ok(
      !/compact=\{false\}/.test(bottomNav),
      "6: the bar must never render the count pill — it would eat a label that cannot be shrunk",
    );
    assert.match(
      bottomNav,
      /<span className="relative flex h-\[19px\] w-\[19px\] shrink-0 items-center justify-center">/,
      "6: the dot is absolutely positioned and needs a relative wrapper sized to the ICON, or it anchors to the whole tab",
    );
    const navBadge = readFileSync("src/components/layout/nav-badge.tsx", "utf8");
    assert.match(
      navBadge,
      /absolute -right-0\.5 -top-0\.5/,
      "6: the compact badge must stay absolutely positioned — a badge in flow would widen every tab's layout floor",
    );
  }

  // ── 7. The bar sits inside the portal shell, which is what squares the dot ──
  // The compact badge is written `rounded-full`. globals.css zeroes the radius for everything
  // inside `.employee-portal-shell`, so the dot renders SQUARE like the rest of the portal — but
  // only because the bar is a DESCENDANT of that root. It is fixed-positioned, so its place in the
  // DOM is easy to move without noticing that the square-edge rule travels with it.
  {
    const layout = readFileSync(
      "src/components/employee-portal/employee-portal-layout.tsx",
      "utf8",
    );
    const shellStart = layout.indexOf('className="employee-portal-shell');
    assert.ok(shellStart > 0, "7: the portal shell root must still be here");
    const bottomNavAt = layout.indexOf("<EmployeePortalBottomNav", shellStart);
    assert.ok(
      bottomNavAt > shellStart,
      "7: the bottom bar must render INSIDE .employee-portal-shell, or its badge keeps round corners",
    );
    const globals = readFileSync("app/globals.css", "utf8");
    assert.match(
      globals,
      /\.employee-portal-shell \[class\*="rounded"\]/,
      "7: the sweep that squares the dot must still exist",
    );
  }
}
