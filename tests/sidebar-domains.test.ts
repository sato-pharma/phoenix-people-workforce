import assert from "node:assert/strict";

import { adminSidebarDomains } from "../src/config/sidebar-domains.ts";
import { adminNavigationSections } from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import { groupAdminSections } from "../src/lib/navigation/sidebar-domains.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * The admin rail's domain layer, pinned where it can actually go wrong.
 *
 * The layer itself is presentation — it groups sections that `getSections` has already gated — so
 * the interesting failures are not "wrong permissions" but "a row quietly stopped being drawn".
 * That failure is invisible in review and invisible in production: the page still renders, CI is
 * green, and a module simply becomes unreachable from the sidebar. AGENTS.md has the general form
 * of it — a feature can ship green, deploy cleanly, and be reachable by nobody.
 *
 * So the assertions below are about CONSERVATION, per role, not about appearance.
 */
const ROLES = Object.keys(permissionMatrix) as PhoenixRole[];

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role][resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function hrefsOfSections(sections: readonly { items: readonly { href: string }[] }[]): string[] {
  return sections.flatMap((section) => section.items.map((item) => item.href)).sort();
}

export function runSidebarDomainsTests() {
  // ── 1. the map covers every admin section, exactly once ──────────────────────
  // A section missing from the map still renders — groupAdminSections puts it under "More" rather
  // than dropping it — but it renders away from its siblings, which is a silent demotion. This is
  // the assertion that makes adding a section to the seeds also a decision about where it lives.
  const placed = new Map<string, string>();
  for (const domain of adminSidebarDomains) {
    for (const group of domain.groups) {
      for (const id of group.sectionIds) {
        const where = `${domain.id} / ${group.heading}`;
        assert.equal(
          placed.get(id),
          undefined,
          `Section "${id}" is placed twice: ${placed.get(id)} and ${where}. The second placement ` +
            `renders nothing (groupAdminSections consumes a section at its first match), so the ` +
            `rows would silently sit in the wrong domain.`,
        );
        placed.set(id, where);
      }
    }
  }

  const realIds = new Set(adminNavigationSections.map((section) => section.id));
  const unplaced = [...realIds].filter((id) => !placed.has(id));
  assert.deepEqual(
    unplaced,
    [],
    `These admin sections are not placed in any domain, so they would render at the bottom under ` +
      `"More" instead of beside their siblings: ${unplaced.join(", ")}. Add each to a group in ` +
      `src/config/sidebar-domains.ts.`,
  );

  const phantom = [...placed.keys()].filter((id) => !realIds.has(id));
  assert.deepEqual(
    phantom,
    [],
    `src/config/sidebar-domains.ts names section ids that do not exist in ` +
      `adminNavigationSectionSeeds: ${phantom.join(", ")}. A renamed section leaves its old id ` +
      `here doing nothing, and the rows move to "More" with no error.`,
  );

  // ── 2. domain and heading identity ───────────────────────────────────────────
  const domainIds = adminSidebarDomains.map((domain) => domain.id);
  assert.equal(new Set(domainIds).size, domainIds.length, "domain ids must be unique");
  for (const domain of adminSidebarDomains) {
    const headings = domain.groups.map((group) => group.heading);
    assert.equal(
      new Set(headings).size,
      headings.length,
      `Domain "${domain.id}" repeats a heading: ${headings.join(", ")}. Two identical headings in ` +
        `one domain read as one section split in half.`,
    );
    for (const heading of headings) {
      assert.ok(heading.trim().length > 0, `Domain "${domain.id}" has a blank heading`);
    }
  }

  // ── 3. no row lost, no row duplicated — for every role ───────────────────────
  // The one that matters. Whatever getSections hands over must come back out of the grouping,
  // once each. Run across all roles because the input differs per role, and an id that only a
  // Finance Manager ever sees is exactly the kind that goes unplaced without anyone noticing.
  for (const role of ROLES) {
    const gated = getSections(adminNavigationSections, "admin", lookupForRole(role), role);
    const domains = groupAdminSections(gated);

    const before = hrefsOfSections(gated);
    const after = hrefsOfSections(domains.flatMap((d) => d.groups.flatMap((g) => g.sections)));
    assert.deepEqual(
      after,
      before,
      `${role}: the domain grouping changed which rows the admin rail draws. ` +
        `${before.length} rows in, ${after.length} out.`,
    );

    // Every domain rendered must hold something. An accordion that opens onto nothing reads as a
    // permission fault rather than as "you have nothing here".
    for (const domain of domains) {
      assert.ok(
        domain.rowCount > 0,
        `${role}: domain "${domain.id}" rendered with no rows — it should have been omitted.`,
      );
      for (const group of domain.groups) {
        assert.ok(
          group.sections.length > 0,
          `${role}: group "${domain.id} / ${group.heading}" rendered with no sections.`,
        );
      }
    }

    // Nothing should reach the fallback in a green repo; assertion 1 is what normally catches it,
    // but a role-specific section id would slip past that and land here.
    const more = domains.find((domain) => domain.id === "more");
    assert.equal(
      more,
      undefined,
      `${role}: ${more?.groups.map((g) => g.heading).join(", ")} fell through to "More".`,
    );
  }
}
