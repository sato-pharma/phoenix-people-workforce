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
 * for that hub was `excludedRoles: ["Super Admin", "Finance Manager"]` — deliberately, because
 * Super Admin gets the workspace at /admin/crm instead and would otherwise see two "CRM" rows.
 *
 * So the only role either card admitted was the one role that could not see the hub holding it.
 * /admin/crm is the CRM workspace — a master table with its own tab bar — not a card hub, so it
 * offers neither. Both pages rendered perfectly on a typed URL and were reachable in the product
 * only through Cmd+K.
 *
 * ## How it was finally closed (2026-08-29)
 *
 * By hand, one page at a time, until the owner was actually asked. Reps Plans got its own row;
 * Doctor List and Plan Verification got theirs; four more cards were recorded as a known blind spot
 * because "more sidebar rows" was not obviously the right answer and nobody had the standing to
 * choose. Asked directly, the owner chose to FINISH THE EXPANSION — the four missing rows — and to
 * keep the hub exclusion.
 *
 * That is the right answer for a reason worth writing down, because the cheaper-looking one was
 * offered first and was wrong: the exclusion is not a quirk, it is the 2026-08-08 rule that the SFE
 * Manager keeps hub BUTTONS while everyone else gets those hubs EXPANDED into rows. Handing Super
 * Admin the hub button would have put a button on his sidebar whose nine cards include FIVE pages
 * he already has rows for — restoring exactly the duplication the 2026-08-08 restoration removed.
 *
 * So the rule below is stated positively — every card needs a row — rather than as an allowlist of
 * the ones that do not have one. An allowlist records a gap; this fails on the day one is created.
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
  // One gating path for every role now, so the test takes exactly what production takes. The
  // system administrator's waiver lives inside navigationItemVisible rather than in a branch
  // the caller has to opt into, which is what makes this call identical to app-shell's.
  const sections = getSections(
    getNavigationSections("admin"),
    "admin",
    permissionLookupFor(role),
    role,
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

  // The exclusion STAYS. It is the 2026-08-08 rule — the SFE Manager keeps hub BUTTONS, and every
  // other role gets those hubs EXPANDED into their own rows — not a quirk to be undone. Asked
  // directly on 2026-08-29 whether to hand Super Admin the hub instead, the owner chose to finish
  // the expansion: the hub's nine cards include five pages he already has rows for, so the button
  // would restore exactly the duplication the 2026-08-08 restoration removed.
  assert.ok(
    !superAdminHrefs.has(CRM_HUB_HREF),
    "Super Admin must not see the CRM hub button — he gets the expanded rows instead (owner, 2026-08-08), and a button beside them duplicates five of those rows",
  );

  // ── 2. THE EXPANSION MUST BE COMPLETE ───────────────────────────────────────────────────────
  // This is the assertion that ends the recurrence, and it replaces an allowlist.
  //
  // The rows were added one at a time, as each stranding was noticed: Reps Plans first, then Doctor
  // List and Plan Verification. Four more — CRM Integrity, Brick Coverage, Double Visit Analytics,
  // Double Visit Data Integrity — sat in a KNOWN_STRANDED_FROM_SUPER_ADMIN allowlist instead,
  // because "more sidebar rows" versus "give him the hub" was a decision nobody had the standing to
  // make. The owner made it on 2026-08-29. The allowlist is gone and the rule is stated positively,
  // so a NEW card cannot replay the whole story: it fails here on the day it is added.
  //
  // /admin/doctor-coverage and /admin/doctor-coverage-settings were in that allowlist until
  // 2026-08-28, when the owner retired the board — they left by being deleted, not by being reached.
  assert.ok(
    crmPageItems.length >= 8,
    `expected the real CRM card list, got ${crmPageItems.length} cards — an emptied or renamed list must fail here rather than pass by having nothing to check`,
  );

  // Note there is no `|| superAdminHrefs.has(CRM_HUB_HREF)` escape here, unlike the general rule in
  // 2b below. He cannot see that hub by design, so for him the row is the only route there is.
  const superAdminCannotReach = crmPageItems
    .filter((card) => !superAdminHrefs.has(card.href))
    .map((card) => card.href)
    .sort();

  assert.deepEqual(
    superAdminCannotReach,
    [],
    "every CRM hub card needs its own Super-Admin sidebar row: he cannot see the hub that renders these cards, so a card without a row is reachable by nobody except a typed URL. Add the row in system-navigation.ts beside the other CRM rows",
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
  // The Reps Plans row is Super-Admin-only, so every other role must still reach its page the way
  // it always did: as a card on the hub, with no direct row of its own. /admin/rep-doctor-lists is
  // absent for a second reason since 2026-08-28 — the owner retired it, so there is no row for any
  // role and no card either.
  for (const role of ["SFE Manager", "CEO", "National Sales Manager"] as const) {
    const hrefs = adminHrefsFor(role);
    assert.ok(hrefs.has(CRM_HUB_HREF), `${role} still reaches the CRM hub`);
    assert.ok(
      !hrefs.has("/admin/reps-plans") && !hrefs.has("/admin/rep-doctor-lists"),
      `${role} must NOT gain a direct row — the cards stay Super-Admin-only and a visible row he cannot open is the opposite bug`,
    );
  }
}
