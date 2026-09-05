import assert from "node:assert/strict";

import { adminSidebarDomains } from "../src/config/sidebar-domains.ts";
import { adminNavigationSections } from "../src/config/system-navigation.ts";
import { getSections } from "../src/lib/navigation/active-path.ts";
import { groupAdminSections } from "../src/lib/navigation/sidebar-domains.ts";
import {
  buildPermissionLookup,
  permissionMatrix,
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
    const gated = getSections(adminNavigationSections, "admin", buildPermissionLookup(permissionMatrix, role), role);
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

  // ── 5. the headings that render BLANK, pinned by identity ───────────────────
  //
  // Assertion 3 requires every CONFIGURED heading to be non-empty. That is not the same question as
  // which headings a viewer actually SEES, because groupAdminSections blanks any heading whose text
  // repeats one of its own rows — "Automated Payroll" standing above a single row called "Automated
  // Payroll" is noise, so the heading is dropped.
  //
  // The outcome is EMERGENT and ROLE-DEPENDENT: the same group renders headed for one role and blank
  // for another, purely because the colliding row is gated away from the second. `money / Automated
  // Payroll` blanked for the Super Admin and rendered for the CEO for exactly that reason. Nothing
  // measured it, so a grouping edit could add a blank band — or turn a labelled one blank for a
  // single seat — and no check would say a word.
  //
  // Every list is EMPTY, and that is the assertion. When this pin was written on 2026-09-04 five
  // headings blanked on the Super Admin's rail and his People domain read as two unlabelled bands
  // above a third that had a heading. The owner's heading pass renamed the five collisions and
  // merged the two hiring groups (see the header of src/config/sidebar-domains.ts), so no heading
  // blanks for anybody now. Blanking stays in groupAdminSections as the fallback it was meant to be;
  // this is what stops it becoming the layout again.
  //
  // Pinned by identity rather than by count, so a heading that started blanking and one that stopped
  // cannot cancel out. A row LABEL change can trip this as easily as a heading change — renaming a
  // row to match the band above it is exactly the collision the pass removed.
  const BLANK_HEADINGS_BY_ROLE: Record<string, string[]> = {
    "SFE Manager": [],
    "Finance Manager": [],
    "Financial Advisor": [],
    "HR Advisory": [],
    "HR Operations": [],
    CEO: [],
    "Super Admin": [],
  };

  // The heading a group was CONFIGURED with, so a blanked one can still be named in the failure.
  const configuredHeading = new Map<string, string>();
  for (const domain of adminSidebarDomains) {
    for (const group of domain.groups) {
      for (const sectionId of group.sectionIds) {
        configuredHeading.set(`${domain.id}::${sectionId}`, group.heading);
      }
    }
  }

  let rolesMeasured = 0;
  for (const [role, expected] of Object.entries(BLANK_HEADINGS_BY_ROLE)) {
    const gated = getSections(
      adminNavigationSections,
      "admin",
      buildPermissionLookup(permissionMatrix, role as PhoenixRole),
      role as PhoenixRole,
    );
    const blanks: string[] = [];
    let headingsRendered = 0;
    for (const domain of groupAdminSections(gated)) {
      for (const group of domain.groups) {
        headingsRendered += 1;
        if (group.heading) continue;
        const configured =
          group.sections
            .map((section) => configuredHeading.get(`${domain.id}::${section.id}`))
            .find(Boolean) ?? "?";
        blanks.push(`${domain.id}/${configured}`);
      }
    }
    rolesMeasured += 1;
    // Every expected list is empty, so an empty rail would satisfy the comparison below by having
    // nothing to compare. This is what stops that reading as a pass.
    //
    // The floor was 8 until 2026-09-05, when every hub row was replaced by the modules behind it.
    // A band that existed only to hold a hub row whose page had nothing for that role now
    // disappears instead of rendering — 31 role/hub pairs, Payroll Management for every sales role
    // and Attendance for eleven roles among them — so band counts fell even as the rails gained
    // rows: 6 Financial Advisor, 10 HR Advisory, 11 HR Operations, 12 Finance Manager,
    // 16 SFE Manager, 20 CEO, 24 Super Admin.
    //
    // They rose again the same day, in the rebalance the owner picked out of the navigation review
    // workbook: ten oversized hubs now split into several bands each, so the same rows are drawn
    // under more headings. Re-measured: 7 Financial Advisor, 14 HR Advisory, 14 HR Operations,
    // 14 Finance Manager, 23 SFE Manager, 29 CEO, 43 Super Admin. The floor stays at 5 — it is
    // there to catch a COLLAPSED rail, not to pin a shape that moves whenever a band is added.
    assert.ok(
      headingsRendered >= 5,
      `${role}: measured ${headingsRendered} rendered heading bands — the rail collapsed, so the blank-heading check below has nothing to say`,
    );
    assert.deepEqual(
      blanks.sort(),
      [...expected].sort(),
      `${role}: the set of admin-rail headings that render blank changed. A heading blanks when it ` +
        `repeats one of its own visible rows, so this moves when a group is re-headed, a section is ` +
        `moved between groups, or a row label changes. Confirm the new shape is intended, then update ` +
        `BLANK_HEADINGS_BY_ROLE.`,
    );
  }
  // Anti-vacuity: the map must still cover every admin-shell role. Without this a role could be
  // dropped from it and its blanks would stop being watched with the assertion still green.
  assert.equal(rolesMeasured, 7, `expected 7 admin-shell roles pinned, measured ${rolesMeasured}`);
}
