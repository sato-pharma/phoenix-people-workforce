import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import {
  customersDatabasePageItems,
  sourceOfSalesPageItems,
  weeklySalesToolsPageItems,
  type AdminToolsPageItem,
} from "../src/config/system-navigation.ts";
import type { PhoenixRole } from "../src/lib/auth/permissions.ts";
import { permissionActions, permissionMatrix, permissionResources } from "../src/lib/auth/permissions.ts";
import { permissionAllowed, roleAllowed, roleNotExcluded, type PermissionLookup } from "../src/lib/navigation/active-path.ts";

const SFE_MANAGER: PhoenixRole = "SFE Manager";

// These 8 cards' destination pages hard-redirect any non-Super-Admin role (see each page's own
// `role !== "Super Admin" && scope !== "system"` guard -- "system" scope is only ever set on the
// static internal systemAccessContext object, paired with role "Super Admin", so the guard is
// absolute for every real user session). SFE Manager is the only non-Super-Admin role holding
// sales:import / weekly_sales:import, so without excludedRoles he was shown a sidebar card that
// always bounced him straight back to resolveLandingPathForRole("SFE Manager") ==
// "/admin/sfe-command-center" -- his own "SFE Manager Overview" page.
const KNOWN_SUPER_ADMIN_ONLY_CARDS = [
  "/sales/monthly-closing",
  "/sales/closing-corrections",
  "/sales/distributor-profiles",
  "/sales/missing-data",
  "/sales/normalizer",
  "/sales/diagnostics",
  "/sales/customer-directory",
  "/sales/weekly/distributor-editor",
] as const;

// Mirrors the non-Super-Admin branch of every "*PageItems" hub page (e.g.
// app/(admin)/sales/source-of-sales-tools/page.tsx): a card is shown to a role once
// permissionAllowed + roleAllowed + roleNotExcluded all clear. Super Admin / system-scope bypasses
// that filter entirely on every hub, so only a non-Super-Admin role that still clears it can ever
// be handed a card whose destination page then hard-blocks it.
function buildPermissionLookup(role: PhoenixRole): PermissionLookup {
  const lookup: PermissionLookup = {};
  for (const resource of permissionResources) {
    for (const action of permissionActions) {
      const key = `${resource}:${action}` as const;
      lookup[key] = permissionMatrix[role]?.[resource]?.includes(action) ?? false;
    }
  }
  return lookup;
}

function pageFileForHref(href: string): string {
  return `app/(admin)${href}/page.tsx`;
}

export function runSfeManagerNavDeadLinksTests() {
  const allCards: readonly AdminToolsPageItem[] = [
    ...sourceOfSalesPageItems,
    ...customersDatabasePageItems,
    ...weeklySalesToolsPageItems,
  ];
  const byHref = new Map(allCards.map((card) => [card.href, card]));

  // (1) Pin today's fix -- fails if excludedRoles is ever removed from one of the 8 known cards,
  // or if a card is renamed/dropped without carrying the exclusion forward.
  for (const href of KNOWN_SUPER_ADMIN_ONLY_CARDS) {
    const card = byHref.get(href);
    assert.ok(card, `expected "${href}" to still be a catalogued admin sales/customers-database card`);
    assert.ok(
      card.excludedRoles?.includes(SFE_MANAGER),
      `"${card.label}" (${href}) must carry excludedRoles: ["SFE Manager"] -- its page ` +
        `(${pageFileForHref(href)}) is Super-Admin/system-scope-only, and without the exclusion the ` +
        `sidebar hands SFE Manager a card that always redirects him to his own overview.`,
    );
  }

  // (2) Generic forward guard -- any card SFE Manager can actually see (permission/role gate
  // passes) whose destination page hard-blocks every non-Super-Admin role is the same dead end,
  // whether or not it is on the pinned list above (e.g. a brand new sales:import-gated card).
  const lookup = buildPermissionLookup(SFE_MANAGER);
  let checkedGenerically = 0;
  for (const card of allCards) {
    const visibleToSfeManager =
      permissionAllowed(lookup, card.permissions) &&
      roleAllowed(SFE_MANAGER, card.roles) &&
      roleNotExcluded(SFE_MANAGER, card.excludedRoles);
    if (!visibleToSfeManager) continue;

    const pageFile = pageFileForHref(card.href);
    if (!existsSync(pageFile)) continue;
    checkedGenerically += 1;

    const pageSource = readFileSync(pageFile, "utf8");
    assert.doesNotMatch(
      pageSource,
      /role\s*!==\s*"Super Admin"/,
      `"${card.label}" (${card.href}) passes SFE Manager's permission/role gate in the sidebar hub, but its ` +
        `page hard-redirects any non-Super-Admin role -- add excludedRoles: ["SFE Manager"] to this card in ` +
        `src/config/system-navigation.ts (see the SoS Mapping / Master Database / Customer Mapping / Weekly ` +
        `Mapping cards for the established pattern).`,
    );
  }
  assert.ok(
    checkedGenerically >= 2,
    `expected at least the known-open cards (Sales Upload, Sales Import) to be checked; only checked ` +
      `${checkedGenerically} -- the href-to-page-file mapping may have drifted from app/(admin)/sales/**`,
  );
}
