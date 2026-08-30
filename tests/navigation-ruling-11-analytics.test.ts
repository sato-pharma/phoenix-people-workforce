import assert from "node:assert/strict";

import {
  adminNavigationSections,
  hubPageItemGroups,
  salesAnalyticsPageItems,
  sourceOfSalesPageItems,
} from "../src/config/system-navigation.ts";
import { permissionMatrix, phoenixRoles, permissionActions, permissionResources } from "../src/lib/auth/permissions.ts";
import { getSections, permissionAllowed, roleAllowed, roleNotExcluded, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

// ─────────────────────────────────────────────────────────────────────────────
// RULING 11 — "No analytics module, no sales analytics."
//
// The owner said this three times. It is the one ruling of the eleven that is
// both fully unambiguous and fully in scope for the navigation restructure, and
// this file is what stops it drifting back.
//
// WHAT WAS REMOVED
//   - the `sales-analytics` rail section (-> /admin/analytics), Super Admin's
//     last remaining door to the hub
//   - the "Sales Analytics" group in hubPageItemGroups, which was still serving
//     all nine dashboards through Cmd+K after the rail row went
//   - the CEO's "Sales Analytics" QuickLinkCard (ceo-command-center.tsx)
//   - the SFE Manager's "Sales Analytics" entry (SFE_NAV_ITEMS, ceo-phase-b.tsx)
//
// WHAT WAS **NOT** REMOVED, DELIBERATELY
//   - the pages. /admin/analytics and the nine modules under it still ship,
//     still pass their own guards and still answer by direct URL. Ruling 11
//     removed a MODULE FROM NAVIGATION; it did not ask for a deletion, and
//     deleting them would take the Finance Manager's closing export with it.
//   - `finance-monthly-closing` -> /admin/analytics/monthly-closing/details.
//     After this change it is the only nav entry anywhere into the analytics
//     tree, and that is correct: it is one role's export surface, not the hub.
//   - `salesAnalyticsPageItems` itself, kept but unwired — the only surviving
//     record of who was allowed to open each dashboard.
//
// ⚠️ THE WIDER READING IS **NOT** SETTLED AND IS **NOT** ASSERTED HERE.
// "Attendance Analytics", "Probation Analytics", "Coaching Analytics" and
// "Double Visit Analytics" are TABS INSIDE other modules, not modules. Whether
// ruling 11 also renames those is a wider reading of the owner's words that he
// has not been asked to confirm, so this restructure left every one of them
// alone. There is deliberately NO assertion pinning them either way: pinning
// their presence would block a decision he is entitled to make later, and
// pinning their absence would invent one he never gave.
//
// The employee-portal module at /employee-portals/sales-analytics is likewise
// untouched and out of scope — it is a separate surface with its own routing
// tests (analytics-routing.test.ts), and the ruling was about the admin rail.
// Every assertion below is therefore scoped to the ADMIN navigation.
// ─────────────────────────────────────────────────────────────────────────────

const ANALYTICS_HUB = "/admin/analytics";

function lookupForRole(role: (typeof phoenixRoles)[number]): PermissionLookup {
  const rolePermissions = permissionMatrix[role];
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      lookup[`${resource}:${action}`] = rolePermissions[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

export function runNavigationRuling11AnalyticsTests() {
  // ── 1. no role's admin rail may offer the analytics hub ────────────────────
  // Asserted per-role rather than on the raw config, because a section can be
  // present in the seeds and invisible to everyone, or gated in a way that
  // surprises you. The question ruling 11 asks is "can anyone still see it",
  // and only resolving the rail per role actually answers that.
  for (const role of phoenixRoles) {
    const hrefs = getSections(adminNavigationSections, "admin", lookupForRole(role), role).flatMap((navSection) =>
      navSection.items.map((navItem) => navItem.href),
    );
    assert.equal(
      hrefs.includes(ANALYTICS_HUB),
      false,
      `${role}'s admin sidebar still offers ${ANALYTICS_HUB}. Ruling 11 delisted the analytics ` +
        `module — "no analytics module, no sales analytics", said three times. Remove the row; do ` +
        `not re-gate it to a narrower role, which is what was tried before and left the module alive.`,
    );
  }

  // ── 2. nor may any hub page / the command palette ──────────────────────────
  // The rail is only half the navigation. hubPageItemGroups feeds both the hub
  // cards and Cmd+K, so a module removed from the rail and left in a group is
  // still one keystroke away — which is exactly the state this change ended.
  for (const role of phoenixRoles) {
    const lookup = lookupForRole(role);
    const cardHrefs = hubPageItemGroups.flatMap((group) =>
      group.items
        .filter(
          (hubItem) =>
            permissionAllowed(lookup, hubItem.permissions) &&
            roleAllowed(role, hubItem.roles) &&
            roleNotExcluded(role, hubItem.excludedRoles),
        )
        .map((hubItem) => hubItem.href),
    );
    const analyticsCards = cardHrefs.filter((href) => href === ANALYTICS_HUB || href.startsWith(`${ANALYTICS_HUB}/`));
    assert.deepEqual(
      analyticsCards,
      [],
      `${role} can still reach the analytics module through a hub card or Cmd+K: ` +
        `${analyticsCards.join(", ")}. Ruling 11 removed the module from navigation, and the ` +
        `command palette is navigation.`,
    );
  }

  // ── 3. the retired array must stay unwired ─────────────────────────────────
  // salesAnalyticsPageItems is kept on purpose (it records the per-dashboard
  // role gates) but nothing may consume it. Re-adding one line to
  // hubPageItemGroups would silently restore all nine modules, so that one line
  // is what this asserts.
  const wired = hubPageItemGroups.some((group) => group.items === salesAnalyticsPageItems);
  assert.equal(
    wired,
    false,
    `salesAnalyticsPageItems is wired into hubPageItemGroups again. It is retained ONLY as a record ` +
      `of the old role gates — re-wiring it restores the whole module to Cmd+K and to the hub cards, ` +
      `which ruling 11 removed.`,
  );

  // ── 4. no admin rail section may be LABELLED Sales Analytics ───────────────
  // Separate from 1: an href can be changed while the label survives, and the
  // label is the part the owner actually reads. Scoped to the exact phrase he
  // ruled on — see the header on why "Probation Analytics" and friends are not
  // covered here.
  const offendingLabels = adminNavigationSections
    .flatMap((navSection) => [navSection.label, ...navSection.items.map((navItem) => navItem.label)])
    .filter((label) => typeof label === "string" && label.trim().toLowerCase() === "sales analytics");
  assert.deepEqual(
    offendingLabels,
    [],
    `The admin sidebar still carries a "Sales Analytics" label (${offendingLabels.length} found). ` +
      `Ruling 11 names this one by name.`,
  );

  // ── 5. ruling 1 — Monthly Closing alone, Targets alone ─────────────────────
  // "Sales = 5 blocks; Monthly Closing alone, Targets alone." `alone` means the
  // section holds exactly one item, so neither can quietly acquire a sibling
  // and become a group again.
  // "alone" is a property of what a PERSON sees, so it is asserted after getSections has gated the
  // section for each role — not on the raw seed array. The two are not the same check, and the
  // difference is load-bearing here: on 2026-08-30 Monthly Closing gained a second entry so that the
  // Super Admin gets the block ruling 1 promises him (/sales/monthly-closing) beside the Finance
  // Manager's export-only surface (/admin/analytics/monthly-closing/details), which admits nobody
  // else. The gates are mutually exclusive, so no role has ever seen both — but a raw
  // `items.length === 1` reads that as a group and fails, while a role that really was shown two
  // Monthly Closing rows would slip past it if the entries lived in two sections. Resolving per role
  // catches the case that matters and permits the one that does not.
  //
  // The section was renamed finance-monthly-closing -> monthly-closing in the same change, because
  // it is no longer one role's.
  for (const [id, label] of [
    ["monthly-closing", "Monthly Closing"],
    ["sales-targets-module", "Targets"],
  ] as const) {
    const found = adminNavigationSections.find((navSection) => navSection.id === id);
    assert.ok(found, `The "${label}" section (${id}) is missing — ruling 1 requires it as its own block.`);
    for (const role of phoenixRoles) {
      const resolved = getSections(adminNavigationSections, "admin", lookupForRole(role), role).find(
        (navSection) => navSection.id === id,
      );
      if (!resolved) continue;
      assert.equal(
        resolved.items.length,
        1,
        `Ruling 1 says ${label} stands ALONE, but ${role} is shown ${resolved.items.length} rows in it ` +
          `(${resolved.items.map((item) => item.href).join(", ")}). A second visible item turns the ` +
          `standalone button back into a collapsible group.`,
      );
    }
  }

  // ── 6. Territory Management folded into Source of Sales ────────────────────
  // Ruling 1 caps Sales at five blocks, which left Territory Management without
  // a slot. It moved into the Source of Sales hub rather than being dropped —
  // it IS the SoS geography. Both halves are asserted: the rail section is gone
  // AND the card exists, because doing only the first is how a page gets
  // stranded.
  assert.equal(
    adminNavigationSections.some((navSection) => navSection.id === "sales-territory-management"),
    false,
    `The standalone "sales-territory-management" rail section is back. Ruling 1 caps Sales at five ` +
      `blocks; Territory Management belongs to the Source of Sales hub.`,
  );
  assert.ok(
    sourceOfSalesPageItems.some((card) => card.href === "/sales/territory-management"),
    `Territory Management is not in sourceOfSalesPageItems. Its rail section was removed on the ` +
      `understanding it folded into the Source of Sales hub — without this card the page has no ` +
      `home in navigation at all.`,
  );
}
