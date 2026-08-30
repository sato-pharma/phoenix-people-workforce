import assert from "node:assert/strict";

import {
  getSections,
  usesFlatSidebar,
  type PermissionLookup,
} from "../src/lib/navigation/active-path.ts";
import { adminNavigationSections, hubPageItemGroups } from "../src/config/system-navigation.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

// PR #1625 (2026-08-02) rebuilt the SFE Manager's sidebar: it blanked four section headings and
// removed the hub-button styling. Both live on SHARED config, so every admin role was flattened —
// on Super Admin and CEO those sections hold several rows, which left them as loose unlabelled
// buttons that could no longer be collapsed (the label doubles as the collapse key), plus five
// modules folded away into hub pages. Owner instruction 2026-08-08: leave the SFE Manager's
// sidebar exactly as it is and restore everyone else's.
//
// ── 2026-08-30: the owner reversed the ROW half of that, and only the row half ────────────────
//
// Asked directly, in the context of his own navigation ruling that Layer 1 should carry one row per
// module, he chose to collapse CRM (9 rows), Probation (5) and Marketing back into their hub
// buttons. Measured through getSections, that took his rail from 60 visual rows to 47.
//
// So this suite no longer pins the restored ROWS. It still pins everything else the 2026-08-08
// instruction covered, and those parts were never in question:
//   • the HEADINGS are back for Super Admin and CEO — that is what made the sections collapsible
//     again, and it is independent of how many rows sit under each one;
//   • the SFE Manager's sidebar did not move, on 08-08 or on 08-30;
//   • no role sees the same href twice.
//
// And it now pins the collapse itself, so the rows cannot drift back in one at a time — which is
// exactly how they arrived the first time. Read the two lists below as "what the owner last said",
// not as "what is correct": both have been reversed once, and the next reversal should edit these
// lists rather than argue with them.

function lookupForRole(role: PhoenixRole): PermissionLookup {
  const rolePermissions = permissionMatrix[role];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

// Mirrors app-shell.tsx, which no longer passes a bypass flag: getSections waives `roles` for the
// system administrator itself. It still matters here that `excludedRoles` is honoured for every
// role — that is the ONLY mechanism keeping the hub copies off Super Admin's sidebar, and it is now
// honoured alongside `permissions` rather than instead of them.
function sectionsFor(role: PhoenixRole) {
  return getSections(adminNavigationSections, "admin", lookupForRole(role), role);
}

function hrefsFor(role: PhoenixRole): string[] {
  return sectionsFor(role).flatMap((navSection) => navSection.items.map((navItem) => navItem.href));
}

function assertIncludesAll(hrefs: readonly string[], expected: readonly string[], message: string) {
  for (const href of expected) {
    assert.ok(hrefs.includes(href), `${message} — expected ${href} in sidebar`);
  }
}

function assertExcludesAll(hrefs: readonly string[], forbidden: readonly string[], message: string) {
  for (const href of forbidden) {
    assert.ok(!hrefs.includes(href), `${message} — did not expect ${href} in sidebar`);
  }
}

// What is LEFT of the 2026-08-08 restoration after the 2026-08-30 collapse. Both of these are
// still rows on Super Admin's sidebar, and both are still cards on a hub the SFE Manager uses —
// which is the arrangement, not a duplication, because he is excluded from each row by name:
//   /admin/field-workforce-compliance   a People Management row; a card on the CRM hub, where the
//                                       SFE Manager reaches it (it is judged on CRM visit activity)
//   /admin/pm-products                  its own section since 2026-08-30; a card on the Marketing
//                                       & ROI hub, where the SFE Manager reaches it
const RESTORED_ROWS = ["/admin/field-workforce-compliance", "/admin/pm-products"] as const;

// The hub buttons. The SFE Manager always had these; since 2026-08-30 Super Admin has them too,
// INSTEAD of the rows they list — never beside them.
const SFE_HUBS = ["/admin/probation-tools", "/admin/crm-tools"] as const;

// The rows the 2026-08-30 collapse removed. Nobody may have one of these AND the hub that lists it;
// Super Admin, who had every one, must now have none of them.
const COLLAPSED_INTO_HUBS = [
  // → /admin/probation-tools
  "/probation",
  "/probation/dashboard",
  "/probation/analytics",
  "/admin/probation-settings",
  // → /admin/crm-tools
  "/admin/crm",
  "/admin/reps-plans",
  "/admin/doctor-list",
  "/admin/plan-verification",
  "/admin/crm-integrity",
  "/admin/brick-coverage",
  "/admin/double-visit-analytics",
  "/admin/double-visit-data-integrity",
  // → /admin/marketing-roi
  "/admin/marketing-requests/all",
  "/admin/marketing-roi-tracker",
] as const;

export function runSidebarRoleScopedHeadingsTests() {
  // ── The flat-sidebar rule itself ───────────────────────────────────────────
  assert.equal(usesFlatSidebar("SFE Manager"), true, "SFE Manager keeps the flat sidebar");
  assert.equal(usesFlatSidebar("Super Admin"), false, "Super Admin is off the flat sidebar");
  assert.equal(usesFlatSidebar("CEO"), false, "CEO is off the flat sidebar");
  assert.equal(usesFlatSidebar(undefined), false, "an unknown role defaults to headings shown");

  // ── Headings are back for every role that is not the SFE Manager ───────────
  for (const role of ["Super Admin", "CEO"] as const) {
    const sections = sectionsFor(role);
    assert.ok(sections.length > 0, `${role} resolves at least one admin section`);
    for (const navSection of sections) {
      assert.notEqual(
        navSection.label,
        "",
        `${role} must see a heading on section "${navSection.id}" — a blank label hides the header row and disables the collapse toggle`,
      );
    }
  }

  // The sections PR #1625 blanked, named explicitly so a future edit that re-blanks one is
  // caught by name rather than by a generic "some section lost its label".
  //
  // There were four. "my-requests" ("My Requests") left the list on 2026-08-30 because the section
  // itself no longer exists: phase 4 moved its two rows — Request Vacation and Submit Excuse — into
  // the personal workspace tab strip, so a person's own leave form is no longer a heading on the
  // company navigation rail. That is a section REMOVED, not a section re-blanked, which is the
  // failure this list exists to catch; keeping it here would assert a heading on nothing. The other
  // three are untouched and still pinned by name.
  const superAdminSections = new Map(sectionsFor("Super Admin").map((s) => [s.id, s.label]));
  for (const [sectionId, expectedLabel] of [
    ["command-center", "Command Center"],
    ["workspace-marketing-requests", "Marketing & ROI"],
    ["people-management", "People Management"],
  ] as const) {
    assert.equal(
      superAdminSections.get(sectionId),
      expectedLabel,
      `Super Admin's "${sectionId}" section must be titled "${expectedLabel}"`,
    );
  }

  // ── The SFE Manager's sidebar did NOT move ─────────────────────────────────
  const sfeSections = sectionsFor("SFE Manager");
  assert.ok(sfeSections.length > 0, "SFE Manager resolves at least one admin section");
  for (const navSection of sfeSections) {
    assert.equal(
      navSection.label,
      "",
      `SFE Manager's section "${navSection.id}" must stay headless — his sidebar is the one the owner is happy with`,
    );
  }

  const sfeHrefs = hrefsFor("SFE Manager");
  assertIncludesAll(sfeHrefs, SFE_HUBS, "SFE Manager keeps his hub buttons");
  assert.ok(
    sfeHrefs.includes("/admin/sfe-command-center"),
    "SFE Manager keeps his own overview (the premium-styled row)",
  );
  assertExcludesAll(
    sfeHrefs,
    RESTORED_ROWS,
    "SFE Manager must not pick up the rows restored for the other roles",
  );

  // ── Super Admin: the two surviving restored rows, the hubs, and none of the collapsed rows ──
  const superAdminHrefs = hrefsFor("Super Admin");
  assertIncludesAll(
    superAdminHrefs,
    RESTORED_ROWS,
    "Super Admin keeps the rows the 2026-08-30 collapse did NOT touch",
  );
  assertIncludesAll(
    superAdminHrefs,
    SFE_HUBS,
    "Super Admin sees the hub buttons since 2026-08-30 — they are his route to every page the collapsed rows used to open",
  );
  assertExcludesAll(
    superAdminHrefs,
    COLLAPSED_INTO_HUBS,
    "Super Admin must not see a row the 2026-08-30 collapse folded into a hub — a hub button beside the rows it lists is the duplication both arrangements exist to avoid",
  );

  // Every collapsed page still has a route: it is a card on the hub that replaced its row. This is
  // the assertion that makes the collapse safe rather than merely tidy, and it is why the list
  // above is spelled out per href instead of counted.
  const superAdminCards = new Set(
    hubPageItemGroups.flatMap((group) => group.items.map((item) => item.href)),
  );
  for (const href of COLLAPSED_INTO_HUBS) {
    assert.ok(
      superAdminCards.has(href),
      `${href} lost its sidebar row in the 2026-08-30 collapse, so it MUST be a card on the hub that replaced it — otherwise the page is reachable by nobody except a typed URL`,
    );
  }

  // No href may appear twice on one sidebar — two rows pointing at the same page is the exact
  // failure mode `excludedRoles` on the hub copies exists to prevent.
  for (const role of ["Super Admin", "CEO", "SFE Manager"] as const) {
    const hrefs = hrefsFor(role);
    assert.equal(
      new Set(hrefs).size,
      hrefs.length,
      `${role}'s sidebar must not list the same href twice (duplicates: ${hrefs.filter((h, i) => hrefs.indexOf(h) !== i).join(", ")})`,
    );
  }
}
