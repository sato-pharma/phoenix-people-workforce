import assert from "node:assert/strict";

import {
  getSections,
  usesFlatSidebar,
  type PermissionLookup,
} from "../src/lib/navigation/active-path.ts";
import { adminNavigationSections } from "../src/config/system-navigation.ts";
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
// This suite pins BOTH halves of that: the restoration for Super Admin / CEO, and the fact that
// the SFE Manager's own sidebar did not move.

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

// Mirrors app-shell.tsx exactly: `access.scope === "system" || access.role === "Super Admin"`.
// It matters here — that bypass ignores `roles`/`permissions` but still honours `excludedRoles`,
// which is the ONLY mechanism keeping the hub copies off Super Admin's sidebar.
function sectionsFor(role: PhoenixRole) {
  return getSections(
    adminNavigationSections,
    "admin",
    lookupForRole(role),
    role,
    role === "Super Admin",
  );
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

// The five modules PR #1625 folded into hub pages, restored as their own rows on 2026-08-08.
const RESTORED_ROWS = [
  "/probation",
  "/admin/field-workforce-compliance",
  "/admin/pm-products",
  "/admin/marketing-roi-tracker",
  "/admin/crm",
] as const;

// The hub buttons that replaced them. The SFE Manager keeps these; Super Admin must not see a hub
// AND its expanded rows at the same time.
const SFE_HUBS = ["/admin/probation-tools", "/admin/crm-tools"] as const;

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
  const superAdminSections = new Map(sectionsFor("Super Admin").map((s) => [s.id, s.label]));
  for (const [sectionId, expectedLabel] of [
    ["command-center", "Command Center"],
    ["my-requests", "My Requests"],
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

  // ── Super Admin gets the folded-away modules back, without duplicates ──────
  const superAdminHrefs = hrefsFor("Super Admin");
  assertIncludesAll(superAdminHrefs, RESTORED_ROWS, "Super Admin gets his module rows back");
  assertExcludesAll(
    superAdminHrefs,
    SFE_HUBS,
    "Super Admin must not see a hub button beside the expanded rows it duplicates",
  );

  // The four probation rows travel together — collapsing them to one button is what row 5 of the
  // owner's decision sheet reverted.
  assertIncludesAll(
    superAdminHrefs,
    ["/probation", "/probation/dashboard", "/probation/analytics", "/admin/probation-settings"],
    "Super Admin sees all four probation rows",
  );

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
