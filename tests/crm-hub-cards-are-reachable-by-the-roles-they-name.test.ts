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
 * ## How it was closed (2026-08-29), and then closed the other way (2026-08-30)
 *
 * First by hand, one page at a time, until the owner was actually asked. Reps Plans got its own
 * row; Doctor List and Plan Verification got theirs; four more cards were recorded as a known blind
 * spot because "more sidebar rows" was not obviously the right answer and nobody had the standing
 * to choose. Asked directly on 2026-08-29, the owner chose to FINISH THE EXPANSION — the four
 * missing rows — and to keep the hub exclusion.
 *
 * Asked again on 2026-08-30, in the context of his own navigation ruling that Layer 1 should hold
 * one row per module, he REVERSED it: collapse CRM to the hub button. So Super Admin now sees
 * /admin/crm-tools like everyone else, and the nine rows are gone.
 *
 * Both answers were his and neither was a mistake — they answer different questions. On 08-29 the
 * question was "these four pages are stranded, rows or hub?" with the rest of the sidebar held
 * constant. On 08-30 it was "your whole rail is 60 rows, which rule wins?" The lesson this file
 * keeps is not which way the answer went; it is that the question was ASKED both times, because
 * the cost of guessing is a page nobody can find.
 *
 * The rule below is therefore stated as REACHABILITY, not as "every card needs a row". A row and a
 * visible hub button are both routes, and pinning the row specifically is what made this test have
 * to be rewritten when the owner changed his mind about the shape rather than about the rule.
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
  // ── 1. The headline: Reps Plans is reachable, and the route is now the hub ───────────────────
  const superAdminHrefs = adminHrefsFor("Super Admin");

  assert.ok(
    superAdminHrefs.has(CRM_HUB_HREF) || superAdminHrefs.has("/admin/reps-plans"),
    "Super Admin is the ONLY role Reps Plans admits, so he needs a route to it — the CRM hub button, or a row of its own. With neither, the page is reachable by nobody except a typed URL",
  );

  // The 2026-08-30 collapse (owner, asked directly). Super Admin previously had NINE CRM rows and
  // was excluded from the hub by name, so that he never saw a hub button beside the rows
  // duplicating it. He chose the hub, so the exclusion went and the rows went with it.
  //
  // This is asserted as "not both", not as "the hub". The owner has moved this boundary twice and
  // may move it again; what must never come back is the state either arrangement exists to
  // prevent — a hub button sitting beside the rows it duplicates.
  //
  // The list is the eight hrefs that WERE his rows, spelled out rather than derived from
  // crmPageItems, because one card is not a CRM-module page at all: Workforce Compliance
  // (/admin/field-workforce-compliance) is a People Management row that appears here as a card
  // because it is judged on CRM visit activity, and the SFE Manager — excluded from that row by
  // name — reaches it only through this hub. One page filed under two modules is the arrangement,
  // not the duplication this guards against, and a derived list would flag it on every run.
  const CRM_ROWS_COLLAPSED_2026_08_30 = [
    "/admin/crm",
    "/admin/reps-plans",
    // Was "/admin/doctor-list" until 2026-08-31, when the owner retired that board and replaced it
    // with Reps List. Same card, same slot, same roles — only the route and the label moved, so the
    // href is updated here rather than dropped: dropping it would quietly stop guarding the slot.
    "/admin/reps-list",
    "/admin/plan-verification",
    "/admin/crm-integrity",
    "/admin/brick-coverage",
    "/admin/double-visit-analytics",
    "/admin/double-visit-data-integrity",
  ] as const;
  const duplicatedByTheHub = superAdminHrefs.has(CRM_HUB_HREF)
    ? CRM_ROWS_COLLAPSED_2026_08_30.filter((href) => superAdminHrefs.has(href))
    : [];
  assert.deepEqual(
    duplicatedByTheHub,
    [],
    "Super Admin must not see the CRM hub button AND rows for the cards it already lists — that duplication is what both the 2026-08-08 expansion and the 2026-08-30 collapse exist to avoid",
  );
  // Every one of those eight is still a card here, so the collapse removed a row and not a route.
  for (const href of CRM_ROWS_COLLAPSED_2026_08_30) {
    assert.ok(
      crmPageItems.some((card) => card.href === href),
      `${href} lost its Super Admin row in the 2026-08-30 collapse, so it MUST still be a card in crmPageItems`,
    );
  }

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

  // Super Admin is no longer a special case: since 2026-08-30 he sees the hub like everyone else,
  // so the same reachability rule covers him. It is kept as its own assertion because he is the
  // role every one of these cards names, and a failure here should say so by name.
  const superAdminCannotReach = crmPageItems
    .filter((card) => !superAdminHrefs.has(card.href) && !superAdminHrefs.has(CRM_HUB_HREF))
    .map((card) => card.href)
    .sort();

  assert.deepEqual(
    superAdminCannotReach,
    [],
    "every CRM hub card must be reachable by Super Admin — via the hub row, or a row of its own. With neither, the page is reachable by nobody except a typed URL",
  );

  // ── 2b. The same rule, every role a card names ─────────────────────────────────────
  const unreachable: string[] = [];
  for (const card of crmPageItems) {
    for (const role of card.roles ?? []) {
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
  // Every other role reaches these pages the way it always did: as cards on the hub, with no direct
  // row. That was true before the 2026-08-30 collapse and is still true after it — the collapse
  // moved Super Admin ONTO their arrangement, it did not move them. /admin/rep-doctor-lists is
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
