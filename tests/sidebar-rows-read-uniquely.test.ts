import assert from "node:assert/strict";

import {
  phoenixRoles,
  buildPermissionLookup,
  permissionMatrix,
  type NavigationMode,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";
import { getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections, usesFlatSidebar } from "../src/lib/navigation/active-path.ts";

/**
 * ONE READABLE ROW PER PAGE in the sidebar — the rail's half of what
 * tests/command-palette-items.test.ts asserts for Cmd/Ctrl+K.
 *
 * Two distinct defects live here and only the first was ever guarded:
 *
 *   1. A duplicate HREF. React keys every rail row by `item.href` (sidebar.tsx), every collapsed
 *      rail icon by `rail-${href}`, and every section by `section.id` — so a repeat is a duplicate
 *      key, which is what threw on every admin page load until #2897. `getSections` runs
 *      `dedupeSectionsByHref` unconditionally, which is why this passes today; the assertion is
 *      what keeps that call wired, because deleting it looks harmless and fails only for the one
 *      role that sees both copies.
 *
 *   2. A duplicate LABEL over two different hrefs, which no dedupe can catch and nothing caught.
 *      Found by sweeping: for the Super Admin alone, "Probation" appeared twice — /admin/ceo-probation
 *      in his own Probation section and /admin/probation-tools under People Management. Same
 *      shape as the marketing pair renamed in #2900: several hrefs are deliberately listed with
 *      mutually-exclusive role gates, and `navigationItemVisible` waives the `roles` half of that
 *      for the system administrator, so both copies reach him and read identically. The section
 *      heading is not a fix — the collapsed rail shows the label alone as a tooltip, and the
 *      sidebar search filters on the label across every section.
 *
 * The sweep is the point rather than the two hrefs: a duplicate is one config line away at any
 * time, and the symptom (a console warning in dev, a silently misrendered row in production, where
 * React does not warn at all) is one nobody reads.
 */
export function runSidebarRowsReadUniquelyTests() {
  const modes: NavigationMode[] = ["admin", "employee-portal", "hr"];
  let sweptCombinations = 0;
  let widestSidebar = 0;

  for (const role of phoenixRoles) {
    const lookup = buildPermissionLookup(permissionMatrix, role);
    for (const mode of modes) {
      const sections = getSections(getNavigationSections(mode), mode, lookup, role);
      const rows = sections.flatMap((section) => section.items);
      sweptCombinations += 1;
      widestSidebar = Math.max(widestSidebar, rows.length);
      const where = `${role} / ${mode}`;

      // 1a — the row key.
      const hrefCounts = new Map<string, number>();
      for (const row of rows) hrefCounts.set(row.href, (hrefCounts.get(row.href) ?? 0) + 1);
      assert.deepEqual(
        [...hrefCounts].filter(([, count]) => count > 1).map(([href]) => href),
        [],
        `${where}: an href renders twice in the sidebar, so React sees two children with the same key`,
      );

      // 1b — the section key, and the collapse state, which is stored per section id.
      const idCounts = new Map<string, number>();
      for (const section of sections) idCounts.set(section.id, (idCounts.get(section.id) ?? 0) + 1);
      assert.deepEqual(
        [...idCounts].filter(([, count]) => count > 1).map(([id]) => id),
        [],
        `${where}: two sections share an id, so they collide on key={section.id} and collapse together`,
      );

      // 2 — two rows a person cannot tell apart. Inside one section first, since there the
      // heading cannot even in principle disambiguate them.
      for (const section of sections) {
        const inSection = new Map<string, string[]>();
        for (const row of section.items) {
          inSection.set(row.label, [...(inSection.get(row.label) ?? []), row.href]);
        }
        for (const [label, hrefs] of inSection) {
          assert.equal(
            hrefs.length,
            1,
            `${where}: "${label}" appears ${hrefs.length}x in "${section.label || section.id}" -> ${hrefs.join(" , ")}`,
          );
        }
      }

      // ...then across sections, because the collapsed rail's tooltip and the sidebar search both
      // show the label with no heading attached.
      const acrossSections = new Map<string, string[]>();
      for (const section of sections) {
        for (const row of section.items) {
          acrossSections.set(row.label, [
            ...(acrossSections.get(row.label) ?? []),
            `${section.label || section.id}:${row.href}`,
          ]);
        }
      }
      for (const [label, placements] of acrossSections) {
        assert.equal(
          placements.length,
          1,
          `${where}: "${label}" labels ${placements.length} different pages -> ${placements.join(" | ")}`,
        );
      }

      // A heading has to name one module. Skipped for the flat sidebar, where getSections blanks
      // every heading on purpose (see flatSidebarRoles) and "" is therefore expected to repeat.
      if (!usesFlatSidebar(role)) {
        const headings = new Map<string, string[]>();
        for (const section of sections) {
          headings.set(section.label, [...(headings.get(section.label) ?? []), section.id]);
        }
        for (const [heading, ids] of headings) {
          assert.equal(ids.length, 1, `${where}: heading "${heading}" is used by ${ids.length} sections -> ${ids.join(" , ")}`);
        }
      }

      for (const row of rows) {
        assert.ok(row.label.trim().length > 0, `${where}: ${row.href} renders a row with no label`);
      }
    }
  }

  // Anti-vacuity. A sweep that swept nothing passes every assertion above, and `getSections`
  // returning [] for every role would do exactly that.
  assert.equal(sweptCombinations, phoenixRoles.length * modes.length, "every role x mode must be swept");
  assert.ok(widestSidebar > 40, `the widest sidebar should be dozens of rows, measured ${widestSidebar}`);

  // The pair that prompted the sweep, pinned by name: two probation hubs, two labels. Collapsing
  // them to one row would be wrong — they are different pages — so the fix was, and stays, a rename.
  const superAdmin = getSections(
    getNavigationSections("admin"),
    "admin",
    buildPermissionLookup(permissionMatrix, "Super Admin" as PhoenixRole),
    "Super Admin" as PhoenixRole,
  ).flatMap((section) => section.items);
  const labelOf = (href: string) => superAdmin.find((row) => row.href === href)?.label ?? null;
  assert.equal(labelOf("/admin/ceo-probation"), "Probation", "the CEO's executive probation entry point keeps its label");
  assert.equal(labelOf("/admin/probation-tools"), "Probation Tools", "the probation hub that carries Settings is named apart from it");
}
