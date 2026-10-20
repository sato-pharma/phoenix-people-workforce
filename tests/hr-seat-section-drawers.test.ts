import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { hrSectionIcons } from "../src/config/sidebar-domains.ts";
import { getNavigationSections } from "../src/config/system-navigation.ts";
import {
  getSections,
  sectionDrawerRoles,
  usesSectionDrawers,
} from "../src/lib/navigation/active-path.ts";
import { groupAdminSections, sectionsAsDrawers } from "../src/lib/navigation/sidebar-domains.ts";
import {
  buildPermissionLookup,
  permissionMatrix,
  type NavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * The HR seats' drawer rail (owner, 2026-10-16: "premium polish the appearance tiles titles
 * buttons", scoped to "her and hr operation only never touch admin sidebar").
 *
 * Two halves, both pinned. The two HR seats draw each section of their `/hr` rail as its own
 * drawer, with a tile on every row — and no other role, in any mode, gets anything new. Before it,
 * both seats read their whole rail inside one drawer titled "More", because the admin domain map
 * knows only admin section ids.
 */
const ROLES = Object.keys(permissionMatrix) as PhoenixRole[];
const MODES: NavigationMode[] = ["admin", "employee-portal", "hr"];

const railFor = (role: PhoenixRole, mode: NavigationMode = "hr") =>
  getSections(getNavigationSections(mode), mode, buildPermissionLookup(permissionMatrix, role), role);

const hrefs = (sections: readonly { items: readonly { href: string }[] }[]) =>
  sections.flatMap((section) => section.items.map((item) => item.href));

export function runHrSeatSectionDrawersTests() {
  // ── 1. Exactly the three HR seats, exactly the /hr shell ───────────────────────────────────
  // The HR Operations Specialist (HR Administration) joined the other two on 2026-10-20.
  assert.deepEqual([...sectionDrawerRoles].sort(), ["HR Administration", "HR Operations", "HR Resourcing"]);
  for (const role of ROLES) {
    for (const mode of MODES) {
      const expected =
        mode === "hr" && (role === "HR Resourcing" || role === "HR Operations" || role === "HR Administration");
      assert.equal(
        usesSectionDrawers(mode, role),
        expected,
        `${role} in ${mode}: drawer rail ${expected ? "expected" : "must never apply"}`,
      );
    }
  }
  assert.equal(usesSectionDrawers("hr", undefined), false, "no role, no drawer rail");

  // ── 2. Each seat: one drawer per section, every row kept, nothing under "More" ─────────────
  for (const role of sectionDrawerRoles) {
    const rail = railFor(role);
    const drawers = sectionsAsDrawers(rail);
    assert.deepEqual(
      drawers.map((drawer) => drawer.id),
      rail.map((section) => section.id),
      `${role}: one drawer per section, in rail order`,
    );
    assert.deepEqual(
      drawers.map((drawer) => drawer.name),
      rail.map((section) => section.label),
      `${role}: each drawer is titled with its section heading`,
    );
    assert.deepEqual(
      hrefs(drawers.flatMap((drawer) => drawer.groups.flatMap((group) => group.sections))),
      hrefs(rail),
      `${role}: the drawers draw exactly the rows getSections allowed, once each`,
    );
    assert.ok(
      drawers.every((drawer) => drawer.groups.every((group) => group.heading === "")),
      `${role}: no heading is printed twice under its own drawer title`,
    );
    assert.equal(drawers.some((drawer) => drawer.id === "more"), false, `${role}: nothing falls through to "More"`);

    // The fault the drawers replace, so this file fails if the domain map ever learns HR ids and
    // the reason for the drawer rail quietly changes underneath it.
    assert.deepEqual(
      groupAdminSections(rail).map((domain) => domain.id),
      ["more"],
      `${role}: the admin domain map still reads the /hr rail as one "More" drawer`,
    );

    // ── 3. Every drawer has its own icon, distinct from every row icon on that seat ──────────
    const rowIcons = new Set(rail.flatMap((section) => section.items.map((item) => item.icon)));
    for (const drawer of drawers) {
      assert.ok(hrSectionIcons[drawer.id], `${role}: "${drawer.name}" (${drawer.id}) has no drawer icon`);
      assert.equal(rowIcons.has(drawer.icon), false, `${role}: "${drawer.name}" reuses one of its rail's row icons`);
    }
    assert.equal(
      new Set(drawers.map((drawer) => drawer.icon)).size,
      drawers.length,
      `${role}: no two drawers share an icon`,
    );
  }

  // ── 4. The admin rail is untouched: same domains, same rows, for every role ────────────────
  for (const role of ROLES) {
    const admin = railFor(role, "admin");
    assert.equal(usesSectionDrawers("admin", role), false);
    assert.deepEqual(
      hrefs(groupAdminSections(admin).flatMap((domain) => domain.groups.flatMap((group) => group.sections))).sort(),
      hrefs(admin).sort(),
      `${role}: the admin rail still draws through the domain map`,
    );
  }

  // ── 5. The renderer takes the drawer branch only on that predicate ─────────────────────────
  const sidebar = readFileSync(new URL("../src/components/layout/sidebar.tsx", import.meta.url), "utf8");
  assert.match(
    sidebar,
    /const sectionDrawers = useDomains && usesSectionDrawers\(mode, currentRole\);/,
    "the drawer rail is decided by usesSectionDrawers and nothing else",
  );
  assert.match(sidebar, /hideIcon=\{useDomains && !sectionDrawers\}/, "admin domain rows still drop their icon box");
  assert.match(sidebar, /tiled=\{sectionDrawers\}/, "rows are tiled only on the drawer rail");
  assert.match(
    sidebar,
    /if \(sectionDrawers\) \{\s*return sectionsAsDrawers\(/,
    "the drawer rail is built by sectionsAsDrawers, the admin rail by groupAdminSections",
  );
}
