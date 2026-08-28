import assert from "node:assert/strict";

import { crmPageItems, getNavigationSections } from "../src/config/system-navigation.ts";
import { getSections, type PermissionLookup } from "../src/lib/navigation/active-path.ts";
import {
  permissionActions,
  permissionMatrix,
  permissionResources,
  type PhoenixRole,
} from "../src/lib/auth/permissions.ts";

/**
 * A CRM hub card must be reachable by the role it names.
 *
 * ## The bug this pins
 *
 * Rep Doctor Lists and Reps Plans are cards in `crmPageItems`, and `crmPageItems` is rendered by
 * exactly ONE page: /admin/crm-tools. Both cards are `roles: ["Super Admin"]`. The sidebar row
 * for that hub is `excludedRoles: ["Super Admin", "Finance Manager"]` — deliberately, because
 * Super Admin gets the workspace at /admin/crm instead and would otherwise see two "CRM" rows.
 *
 * So the only role either card admitted was the one role that could not see the hub holding it.
 * /admin/crm is the CRM workspace — a master table with its own tab bar — not a card hub, so it
 * offers neither. Both pages rendered perfectly on a typed URL and were reachable in the product
 * only through Cmd+K.
 *
 * ## Why no existing test caught it
 *
 * Every access assertion passed. `canAccessRepsPlans` is true for Super Admin, `crm_visits:read`
 * is true, both pages return 200. tests/sfe-manager-nav-dead-links.test.ts asks the opposite
 * question — is a rendered row openable — and a row that does not exist cannot be a dead link.
 * The organogram paid for this same shape twice (see
 * organogram-nav-link-exists-for-every-role-that-can-open-it.test.ts); these two pages are the
 * third and fourth, and the hub indirection is what hides it: the card list looks like a route.
 *
 * ## What this asserts
 *
 * For every card in `crmPageItems` that names roles, each named role reaches the card's href —
 * either as its own sidebar row, or via a visible row for the hub that renders the card. Both
 * count as reachable; this pins that AT LEAST ONE exists, not which.
 *
 * `system-navigation.ts` is UX only and never the security boundary (CLAUDE.md), so the failure
 * mode here is never exposure. It is a page nobody can find.
 */

const CRM_HUB_HREF = "/admin/crm-tools";

function permissionLookupFor(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

/** Exactly what the admin sidebar renders for this role — the real filter, not a replica. */
function adminHrefsFor(role: PhoenixRole): Set<string> {
  // getSections' system-administrator branch bypasses roles/permissions and honours only
  // excludedRoles. Super Admin takes that branch in production (app-shell.tsx), so the test must
  // take it too — it is precisely the branch that hid the hub from him.
  const isSystemAdministratorWorkspace = role === "Super Admin";
  const sections = getSections(
    getNavigationSections("admin"),
    "admin",
    permissionLookupFor(role),
    role,
    null,
    isSystemAdministratorWorkspace,
  );
  return new Set(sections.flatMap((section) => section.items.map((item) => item.href)));
}

export function runCrmHubCardReachabilityTests() {
  // ── 1. The headline: the two cards that were stranded ────────────────────────────────────────
  const superAdminHrefs = adminHrefsFor("Super Admin");

  assert.ok(
    superAdminHrefs.has("/admin/reps-plans"),
    "Super Admin is the ONLY role Reps Plans admits, and he cannot see the hub that lists it — he must have his own sidebar row",
  );
  assert.ok(
    superAdminHrefs.has("/admin/rep-doctor-lists"),
    "Super Admin is the ONLY role Rep Doctor Lists admits, and he cannot see the hub that lists it — he must have his own sidebar row",
  );

  // The exclusion that caused it is deliberate and must stay: without it he sees two "CRM" rows.
  assert.ok(
    !superAdminHrefs.has(CRM_HUB_HREF),
    "Super Admin is still excluded from the CRM hub by name — that exclusion is the reason the rows above have to exist",
  );

  // ── 2. The rest of the hub: Super Admin's OWN blind spot, recorded exactly ──────────────────
  // The two rows above fix the cards NOBODY could reach. They are not the whole story: every card
  // in crmPageItems names Super Admin, and he sees none of them, because the hub row that renders
  // them all excludes him. For the cards below that is a milder fault than the two above — SFE
  // Manager and CEO still reach them through the hub, so the page is not lost to the product, only
  // to the owner's own account. Two of the entries are asserted to be unreachable by the very
  // comments in system-navigation.ts that describe them: /admin/doctor-coverage says "SFE Manager,
  // CEO and Super Admin use the admin entry", and /admin/doctor-coverage-settings says "Super Admin
  // and SFE Manager use the admin entry instead". There is no admin entry for him.
  //
  // This list is pinned EXACTLY, not as a floor. Fixing one fails this test and asks you to remove
  // it from the list; a NEW stranded card fails it too. The fix for these is a design decision the
  // owner has to make and has not yet been asked — six more sidebar rows is not obviously better
  // than letting him see the hub under a distinct label — so the gap is recorded here rather than
  // silently widened or silently closed.
  const KNOWN_STRANDED_FROM_SUPER_ADMIN = [
    "/admin/crm-integrity",
    "/admin/double-visit-analytics",
    "/admin/double-visit-data-integrity",
    "/admin/doctor-coverage",
    "/admin/brick-coverage",
    "/admin/doctor-coverage-settings",
  ];

  const superAdminCannotReach = crmPageItems
    .filter((card) => !superAdminHrefs.has(card.href) && !superAdminHrefs.has(CRM_HUB_HREF))
    .map((card) => card.href);

  assert.deepEqual(
    [...superAdminCannotReach].sort(),
    [...KNOWN_STRANDED_FROM_SUPER_ADMIN].sort(),
    "the set of CRM cards Super Admin cannot reach must match the recorded list exactly — a new one is a regression, and a missing one means it was fixed and the list should shrink",
  );

  // ── 2b. The general rule for every OTHER role ──────────────────────────────────────
  // Everyone else must be able to reach every card that names them. Only Super Admin has the
  // exclusion, so only Super Admin gets an allowance.
  const unreachable: string[] = [];
  for (const card of crmPageItems) {
    for (const role of card.roles ?? []) {
      if (role === "Super Admin") continue;
      const hrefs = adminHrefsFor(role);
      if (!hrefs.has(card.href) && !hrefs.has(CRM_HUB_HREF)) {
        unreachable.push(`${role} -> ${card.label} (${card.href})`);
      }
    }
  }
  assert.deepEqual(
    unreachable,
    [],
    "a CRM card that names a role must be reachable by that role — as its own sidebar row, or via a hub row it can actually see",
  );

  // ── 3. Nobody else's route changed ───────────────────────────────────────────────────────────
  // The two new rows are Super-Admin-only, so every other role must still reach these pages the
  // way it always did: as cards on the hub, with no direct row of its own.
  for (const role of ["SFE Manager", "CEO", "National Sales Manager"] as const) {
    const hrefs = adminHrefsFor(role);
    assert.ok(hrefs.has(CRM_HUB_HREF), `${role} still reaches the CRM hub`);
    assert.ok(
      !hrefs.has("/admin/reps-plans") && !hrefs.has("/admin/rep-doctor-lists"),
      `${role} must NOT gain a direct row — the cards stay Super-Admin-only and a visible row he cannot open is the opposite bug`,
    );
  }
}
