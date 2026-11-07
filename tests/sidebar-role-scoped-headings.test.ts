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

// ── 2026-09-05: the owner reversed the COLLAPSE ──────────────────────────────────────────────
//
// "I don't want any subtitle to be the one that when I press, it redirects me to a page with big
// modules. I want a recruitment and its modules under it." So no rail row opens a hub page any
// more: every hub's cards are promoted onto the rail under the hub's own heading, and the hub row
// itself is gone. The two lists below are the same two the 2026-08-30 collapse produced, read the
// other way round — which is what the note above says to do rather than argue with them.
//
// The SECTIONS survive the reversal unchanged; only their contents moved. That is why the
// assertions that used to name a hub href now name a section id.

// What is LEFT of the 2026-08-08 restoration. Both are rows on Super Admin's sidebar, both are
// cards on a hub the SFE Manager uses, and he is excluded from each standalone ROW by name:
//   /admin/field-workforce-compliance   a People Management row; a card on the CRM hub, where the
//                                       SFE Manager reaches it (it is judged on CRM visit activity)
//   /admin/pm-products                  its own section since 2026-08-30; a card on the Marketing
//                                       & ROI hub, where the SFE Manager reaches it
// Since the promotion those two cards ARE rail rows for him — inside `crm` and `hub-marketing-roi`,
// never inside the sections below, which is what the exclusion was always about.
const RESTORED_ROWS = ["/admin/field-workforce-compliance", "/admin/pm-products"] as const;
const RESTORED_ROW_SECTIONS = ["people-management", "pm-product-master"] as const;

// The hub buttons, now retired. No role may have one: they are pages still, reachable by URL and
// by search, but nothing on the rail opens them.
const RETIRED_HUB_HREFS = [
  "/admin/probation-tools",
  "/admin/crm-tools",
  "/admin/marketing-roi",
] as const;

// The rows the 2026-08-30 collapse removed and the 2026-09-05 promotion put back. Super Admin, who
// had every one before the collapse, must have every one again — and none of the hubs above.
const COLLAPSED_INTO_HUBS = [
  // → /admin/probation-tools
  "/probation",
  "/probation/dashboard",
  "/probation/analytics",
  "/admin/probation-settings",
  // → /admin/crm-tools
  "/admin/crm",
  // "/admin/reps-plans" was here until 2026-09-21, when the owner merged Reps Plans into Reps List:
  // it is now the Call rate tab of the row below, and the old route only redirects there.
  // Was "/admin/doctor-list" until 2026-08-31, when the owner retired that board and Reps List took
  // its card. The route still exists as a redirect stub, so the guard follows the live href.
  "/admin/reps-list",
  "/admin/plan-verification",
  // "/admin/crm-integrity" was here until 2026-11-07, when CRM Integrity was retired with iReports360
  // and its row left every rail on purpose (tests/crm-switch-off-safety.test.ts pins that).
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

  // The four sections PR #1625 blanked, named explicitly so a future edit that re-blanks one is
  // caught by name rather than by a generic "some section lost its label".
  //
  // "my-requests" ("My Requests") was RESTORED to the rail on 2026-08-31 (owner instruction),
  // reversing the 2026-08-30 phase-4 removal: the owner asked for the sidebar rows back for every
  // admin-shell role that lost them, while the personal-workspace tabs stay too (additive). So the
  // section exists again and its heading is pinned here once more.
  //
  // TWO OF THE FOUR WERE RENAMED 2026-09-05, and the point of this list is unchanged: it pins that
  // each section HAS a heading, by name, so a re-blanking is caught by name. The promotion gave
  // each of these two a twin in its own domain group carrying the module's name — "Marketing &
  // ROI" and "People Management" are the promoted bands now — so keeping the old strings here
  // would have pinned the very collision tests/sidebar-rows-read-uniquely.test.ts forbids. What
  // each section is called moved; that it is called something did not.
  const superAdminSections = new Map(sectionsFor("Super Admin").map((s) => [s.id, s.label]));
  for (const [sectionId, expectedLabel] of [
    ["command-center", "Command Center"],
    ["my-requests", "My Requests"],
    ["workspace-marketing-requests", "Marketing Workspace"],
    ["people-management", "Compliance"],
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
  const sfeBands = sfeSections.map((navSection) => navSection.id);
  assertExcludesAll(sfeHrefs, RETIRED_HUB_HREFS, "no rail row may open a hub page — not even the SFE Manager's, who had them longest");
  assertIncludesAll(
    sfeHrefs,
    ["/probation", "/admin/crm", "/admin/marketing-roi-tracker"],
    "SFE Manager gets the modules his three hub buttons used to front",
  );
  assert.ok(
    sfeHrefs.includes("/admin/sfe-command-center"),
    "SFE Manager keeps his own overview (the premium-styled row)",
  );
  // The exclusion is about the SECTIONS, not the pages. Both rows are cards on hubs he uses, so
  // since the promotion he holds both hrefs — inside `crm` and `hub-marketing-roi`. What he must
  // still not have is the standalone section each row was restored into for the other roles.
  assertExcludesAll(
    sfeBands,
    RESTORED_ROW_SECTIONS,
    "SFE Manager must not pick up the sections restored for the other roles",
  );
  assertIncludesAll(
    sfeHrefs,
    RESTORED_ROWS,
    "…while keeping both pages, which his own hubs always offered him as cards",
  );

  // ── Super Admin: the restored rows, no hub buttons, and every promoted row back ──
  const superAdminHrefs = hrefsFor("Super Admin");
  assertIncludesAll(
    superAdminHrefs,
    RESTORED_ROWS,
    "Super Admin keeps the rows the 2026-08-30 collapse did NOT touch",
  );
  assertExcludesAll(
    superAdminHrefs,
    RETIRED_HUB_HREFS,
    "Super Admin's hub buttons are gone — 2026-09-05, no rail row opens a page of modules",
  );
  assertIncludesAll(
    superAdminHrefs,
    COLLAPSED_INTO_HUBS,
    "every row the 2026-08-30 collapse folded into a hub is back on Super Admin's rail, under that hub's heading",
  );

  // Every promoted page is a card on the hub whose band it now sits in — the rail and the hub page
  // are the same list, which is what makes the promotion a move rather than a rebuild. Spelled out
  // per href instead of counted.
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
