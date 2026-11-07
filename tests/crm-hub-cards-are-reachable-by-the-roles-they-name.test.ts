import assert from "node:assert/strict";

import { bandSectionIdsFor, crmPageItems, getNavigationSections } from "../src/config/system-navigation.ts";
import {
  getSections,
  navigationItemVisible,
  type PermissionLookup,
} from "../src/lib/navigation/active-path.ts";
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

// The hub page. Still on disk, still answers by URL — but since 2026-09-05 no rail row opens it, on
// any role, because the owner removed every row that opens a page of modules. Its cards were promoted
// onto the rail under the hub's own heading, which is the `crm` band. So this constant no longer
// names a route anyone can click, and every "or via the hub" escape below is gone with it: a card is
// reachable now only by being a ROW.
const CRM_HUB_HREF = "/admin/crm-tools";
// The band was ONE section until the 2026-09-05 rebalance split it in two — "CRM Boards" keeps the
// `crm` id and "CRM Data Quality" is the other half. Resolved rather than spelled out: naming one id
// here would still find a real section, so this test would keep passing while silently checking half
// the module against all of the hub's cards. It failed loudly instead, which is why it is a list.
const CRM_BAND_IDS = bandSectionIdsFor("crm");

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

/** The rows the CRM band actually draws for a role — [] when the band is gated away entirely. */
function crmBandRowsFor(role: PhoenixRole): string[] {
  return getSections(getNavigationSections("admin"), "admin", permissionLookupFor(role), role)
    .filter((section) => CRM_BAND_IDS.includes(section.id))
    .flatMap((section) => section.items.map((item) => item.href))
    .sort();
}

/** The cards the HUB PAGE would render for a role, through the same helper the rail uses. */
function crmCardsFor(role: PhoenixRole): string[] {
  const lookup = permissionLookupFor(role);
  return crmPageItems
    .filter((card) => card.href !== CRM_HUB_HREF && navigationItemVisible(card, lookup, role))
    .map((card) => card.href)
    .sort();
}

export function runCrmHubCardReachabilityTests() {
  // ── 1. The headline: Reps Plans is reachable, and the route is now the hub ───────────────────
  // SINCE 2026-09-21 ITS ROUTE IS THE REPS LIST ROW. The owner merged the two modules ("merge the 2
  // modules into 1 module WHICH REPS LIST"): the board is the Call rate tab of Reps List, and
  // /admin/reps-plans is a redirect to it. So the headline now reads the other way round — Super
  // Admin reaches the call rate through his Reps List row, and holds no second row onto the same
  // module.
  const superAdminHrefs = adminHrefsFor("Super Admin");

  assert.ok(
    superAdminHrefs.has("/admin/reps-list"),
    "Super Admin needs a route to the call rate, and since 2026-09-21 that is his Reps List row — the Call rate tab is the retired Reps Plans board. With no row, the page is reachable by nobody except a typed URL",
  );
  assert.ok(
    !superAdminHrefs.has("/admin/reps-plans"),
    "no rail row may still open /admin/reps-plans — it is a redirect onto the Reps List Call rate tab, so a row for it would open the same module twice",
  );

  // The 2026-08-30 collapse (owner, asked directly). Super Admin previously had NINE CRM rows and
  // was excluded from the hub by name, so that he never saw a hub button beside the rows
  // duplicating it. He chose the hub, so the exclusion went and the rows went with it.
  //
  // This is asserted as "not both", not as "the hub". The owner has moved this boundary twice and
  // may move it again; what must never come back is the state either arrangement exists to
  // prevent — a hub button sitting beside the rows it duplicates.
  //
  // The list is the hrefs that WERE his rows, spelled out rather than derived from
  // crmPageItems, because one card is not a CRM-module page at all: Workforce Compliance
  // (/admin/field-workforce-compliance) is a People Management row that appears here as a card
  // because it is judged on CRM visit activity, and the SFE Manager — excluded from that row by
  // name — reaches it only through this hub. One page filed under two modules is the arrangement,
  // not the duplication this guards against, and a derived list would flag it on every run.
  //
  // /admin/reps-plans was one of them until 2026-09-21, when the owner merged it into Reps List. It
  // left by becoming a tab of a card still on this list, not by losing a route.
  const CRM_ROWS_COLLAPSED_2026_08_30 = [
    "/admin/crm",
    // Was "/admin/doctor-list" until 2026-08-31, when the owner retired that board and replaced it
    // with Reps List. Same card, same slot, same roles — only the route and the label moved, so the
    // href is updated here rather than dropped: dropping it would quietly stop guarding the slot.
    "/admin/reps-list",
    "/admin/plan-verification",
    // "/admin/crm-integrity" was here until 2026-11-07, when CRM Integrity was retired with iReports360:
    // it compared vendor visits with vendor check-ins, so it left the hub and the rail together and its
    // route became a pointer to Phoenix CRM's own integrity screens. It left by retirement, not by
    // losing a row — tests/crm-switch-off-safety.test.ts pins that it stays off both.
    "/admin/brick-coverage",
    "/admin/double-visit-analytics",
    "/admin/double-visit-data-integrity",
  ] as const;
  // 2026-09-05 settled it a third way, and this time by removing one of the two options rather than
  // by choosing between them: there is no hub button on any rail, so the duplication is unreachable
  // by construction. Both halves are still asserted, because "unreachable by construction" is a
  // property of the current promotion and not a law.
  assert.ok(
    !superAdminHrefs.has(CRM_HUB_HREF),
    "no rail row may open the CRM hub page — the owner removed every row that opens a page of modules",
  );
  const collapsedRowsMissing = CRM_ROWS_COLLAPSED_2026_08_30.filter((href) => !superAdminHrefs.has(href));
  assert.deepEqual(
    collapsedRowsMissing,
    [],
    "the rows the 2026-08-30 collapse folded into the CRM hub are back on Super Admin's rail as of 2026-09-05, under the hub's own heading — with the hub button gone, a missing row is a page he can no longer reach",
  );
  // Every one of those is still a card here, so the collapse removed a row and not a route.
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
    .filter((card) => card.href !== CRM_HUB_HREF && !superAdminHrefs.has(card.href))
    .map((card) => card.href)
    .sort();

  assert.deepEqual(
    superAdminCannotReach,
    [],
    "every CRM hub card must be a row on Super Admin's rail — since 2026-09-05 that is the only route, the hub button having been removed. Without one the page is reachable by nobody except a typed URL",
  );

  // ── 2b. The same rule, every role a card names ─────────────────────────────────────
  const unreachable: string[] = [];
  for (const card of crmPageItems) {
    if (card.href === CRM_HUB_HREF) continue;
    for (const role of card.roles ?? []) {
      if (!adminHrefsFor(role).has(card.href)) {
        unreachable.push(`${role} -> ${card.label} (${card.href})`);
      }
    }
  }
  assert.deepEqual(
    unreachable,
    [],
    "a CRM card that names a role must be a sidebar row for that role — the hub row that used to count as the second route is gone, so a card the rail drops is reachable by nobody except a typed URL",
  );

  // ── 3. The promotion is a MOVE, not a rebuild ───────────────────────────────────────────────
  //
  // This block asserted two things until 2026-09-05, and the reversal changed what each one means.
  //
  // It asserted the hub BUTTON for these three. There is no hub button on any rail now, so that
  // could only fail — and the routes it stood for did not disappear, they became rows.
  //
  // And it asserted that none of the three gains a direct /admin/reps-plans row, on the stated
  // grounds that "the cards stay Super-Admin-only". That has not been true since 2026-09-03: the
  // card names `["Super Admin", "SFE Manager"]`, so the SFE Manager clears it, opens it, and now
  // legitimately holds a row for it. Keeping the assertion would have pinned a card gate the owner
  // had already widened — an old permission set defended by a navigation test, which is the shape
  // the header of this file warns about.
  //
  // So the rule is stated as the promotion's own promise instead, which is stronger than either:
  // a role's CRM rows are EXACTLY the CRM cards that role clears. A card that stops being a row
  // fails here, and so does a row for a card the role cannot open — the dead-link half, which used
  // to need its own assertion.
  //
  // Super Admin is deliberately not in this loop. He clears one card more than he has rows for:
  // /admin/field-workforce-compliance is a People Management row of his as well as a CRM card, and
  // dedupeSectionsByHref drops the second copy. That is the "one page filed under two modules"
  // arrangement described above, not a dropped route, and §1 and §2a already cover him.
  for (const role of ["SFE Manager", "CEO", "National Sales Manager"] as const) {
    assert.deepEqual(
      crmBandRowsFor(role),
      crmCardsFor(role),
      `${role}: the CRM band on the rail must list exactly the cards the CRM hub page would show ` +
        "— the 2026-09-05 promotion moved the cards onto the rail, so any difference is a route " +
        "gained or lost rather than moved",
    );
    assert.ok(
      crmBandRowsFor(role).length > 0,
      `${role} must still reach the CRM module — the band is the route now that the hub button is gone`,
    );
    // Retired 2026-08-28 by the owner: no row for any role, and no card either. Kept because a
    // restored page with no navigation entry is how this whole file started.
    assert.ok(
      !adminHrefsFor(role).has("/admin/rep-doctor-lists"),
      `${role} must not have a /admin/rep-doctor-lists row — the owner retired that board`,
    );
  }
}
