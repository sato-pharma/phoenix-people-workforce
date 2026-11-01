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

// The exact "hard Super-Admin-only, no exceptions" guard shared by every page in this sweep as of
// 2026-08-05. A page that has since grown a deliberate per-role carve-out (Monthly Closing,
// Customer Directory) necessarily splices an extra clause into the middle of this, so it no
// longer matches the literal substring -- see KNOWN_SFE_MANAGER_OPENED_CARDS below.
const HARD_SUPER_ADMIN_ONLY_GUARD = 'access.role !== "Super Admin" && access.scope !== "system"';

// These 6 cards' destination pages still hard-redirect any non-Super-Admin role (see each page's
// own `role !== "Super Admin" && scope !== "system"` guard -- "system" scope is only ever set on
// the static internal systemAccessContext object, paired with role "Super Admin", so the guard is
// absolute for every real user session). SFE Manager is the only non-Super-Admin role holding
// sales:import / weekly_sales:import, so without excludedRoles he was shown a sidebar card that
// always bounced him straight back to resolveLandingPathForRole("SFE Manager") ==
// "/admin/sfe-command-center" -- his own "SFE Manager Overview" page.
const KNOWN_SUPER_ADMIN_ONLY_CARDS = [
  "/sales/closing-corrections",
  "/sales/distributor-profiles",
  "/sales/missing-data",
  "/sales/normalizer",
  "/sales/diagnostics",
  "/sales/weekly/distributor-editor",
] as const;

// Monthly Closing and Customer Directory were ALSO on the list above until the owner asked
// (2026-08-05) for SFE Manager to actually be able to use them: view + download for both, and for
// Monthly Closing specifically, never publish. Pinned here as the opposite assertion of (1) below
// -- SFE Manager must be able to SEE these two cards, not be excluded.
const KNOWN_SFE_MANAGER_OPENED_CARDS = ["/sales/monthly-closing", "/sales/customer-directory"] as const;

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

  // (1) Pin the still-hidden cards -- fails if excludedRoles is ever removed from one of these 6,
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

  // (2) Pin the two now-opened cards -- fails if excludedRoles is ever reintroduced for either.
  for (const href of KNOWN_SFE_MANAGER_OPENED_CARDS) {
    const card = byHref.get(href);
    assert.ok(card, `expected "${href}" to still be a catalogued admin sales/customers-database card`);
    assert.ok(
      !card.excludedRoles?.includes(SFE_MANAGER),
      `"${card.label}" (${href}) must NOT exclude SFE Manager -- the owner asked (2026-08-05) for him ` +
        `to be able to use this tool. If that decision changed, update this test and ` +
        `KNOWN_SUPER_ADMIN_ONLY_CARDS together, not just the nav config.`,
    );
  }

  // (3) Generic forward guard -- any card SFE Manager can actually see (permission/role gate
  // passes) whose destination page still carries the untouched hard Super-Admin-only guard is a
  // dead end, whether or not it is on the pinned list above (e.g. a brand new sales:import-gated
  // card). Pages with a deliberate per-role carve-out (Monthly Closing, Customer Directory) no
  // longer match this literal guard shape, so they correctly fall out of this sweep -- their
  // access is instead pinned by (2), (4) and (6) below, and the boundary that must NOT loosen is
  // pinned by (5).
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
    assert.ok(
      !pageSource.includes(HARD_SUPER_ADMIN_ONLY_GUARD),
      `"${card.label}" (${card.href}) passes SFE Manager's permission/role gate in the sidebar hub, but its ` +
        `page still carries the unmodified hard Super-Admin-only guard -- add excludedRoles: ["SFE Manager"] ` +
        `to this card in src/config/system-navigation.ts, or give the page a deliberate per-role carve-out ` +
        `like Monthly Closing / Customer Directory.`,
    );
  }
  assert.ok(
    checkedGenerically >= 2,
    `expected at least the known-open cards (Sales Upload, Sales Import) to be checked; only checked ` +
      `${checkedGenerically} -- the href-to-page-file mapping may have drifted from app/(admin)/sales/**`,
  );

  // (4) Monthly Closing specifically: SFE Manager must reach the page, and canPublish must be
  // role-conditional -- never unconditionally true, or he would see the publish/unpublish UI too.
  const monthlyClosingSource = readFileSync("app/(admin)/sales/monthly-closing/page.tsx", "utf8");
  assert.ok(
    monthlyClosingSource.includes('!isSystemAdministratorViewer && access.role !== "SFE Manager"'),
    "Monthly Closing's page gate must explicitly admit SFE Manager alongside the system-administrator check.",
  );
  assert.match(
    monthlyClosingSource,
    /canPublish=\{isSystemAdministratorViewer\}/,
    "Monthly Closing must pass a role-conditional canPublish, not the bare `canPublish` shorthand " +
      "(which is unconditionally true) -- SFE Manager must never see the publish/unpublish UI.",
  );

  // (5) The publish API route is the REAL security boundary (the page gate and canPublish are UX
  // only) -- it must independently keep hard-blocking every non-Super-Admin role, completely
  // untouched by the page-level carve-out above. If this ever regresses to admit SFE Manager, he
  // could publish by calling the API directly even with the button hidden.
  const publishRouteSource = readFileSync("app/api/sales/monthly-closing/publish/route.ts", "utf8");
  assert.ok(
    publishRouteSource.includes(HARD_SUPER_ADMIN_ONLY_GUARD),
    "app/api/sales/monthly-closing/publish/route.ts must keep its own unconditional " +
      '`access.role !== "Super Admin" && access.scope !== "system"` gate -- publishing a closing must ' +
      "stay Super-Admin-only even though SFE Manager can now view the workspace.",
  );

  // (6) Customer Directory's export route must mirror the page's carve-out -- SFE Manager can see
  // the workspace but must also be able to download what it shows him.
  const customerDirectoryExportSource = readFileSync("app/api/sales/customer-directory/export/route.ts", "utf8");
  assert.match(
    customerDirectoryExportSource,
    /access\.role\s*!==\s*"SFE Manager"/,
    "Customer Directory's export route must explicitly admit SFE Manager, mirroring the page gate.",
  );

  // (6b) The rest of the workspace must mirror it too. The page and the export admitted him on
  // 2026-08-05 and these four did not, so the page opened and his first filter answered "restricted
  // to the admin account" (refused 403, 2026-11-01 16:00 Cairo). The list and channel routes feed the
  // workspace; every row links to the detail page, which reads the detail route.
  for (const gatedFile of [
    "app/api/sales/customer-directory/route.ts",
    "app/api/sales/customer-directory/by-channel/route.ts",
    "app/api/sales/customer-directory/[distributor]/[clientCode]/route.ts",
    "app/(admin)/sales/customer-directory/[distributor]/[clientCode]/page.tsx",
  ]) {
    assert.match(
      readFileSync(gatedFile, "utf8"),
      /access.role !== "Super Admin" && access.role !== "SFE Manager" && access.scope !== "system"/,
      `${gatedFile} must admit SFE Manager and nobody wider, mirroring the Customer Directory page gate.`,
    );
  }

  // (7) Monthly Closing's export route must mirror the page's carve-out too -- fixed 2026-08-05.
  // SFE Manager sees the full company-wide matrix in the workspace, so his download must be the
  // SAME full workbook, not the scoped "Details" fallback built for District/Regional/National
  // Sales Manager and PM/GPM. That fallback is a structurally different file (no Matrix/
  // Comparison/Rankings/Gaps/Summary sheets, a different filename) -- a silent regression here
  // hands him back the wrong export instead of a 403, which is exactly what shipped the same day
  // as the page carve-out and is the bug this test exists to catch.
  const monthlyClosingExportSource = readFileSync("app/api/sales/monthly-closing/export/route.ts", "utf8");
  assert.ok(
    monthlyClosingExportSource.includes(
      'access.role === "Super Admin" || access.scope === "system" || access.role === "SFE Manager"',
    ),
    "Monthly Closing's export route must admit SFE Manager into the full-workbook branch, mirroring the page's " +
      "view+download carve-out -- otherwise his Export XLSX click silently downloads the Details-only workbook.",
  );

  // (8) The matrix data-feed route (app/api/sales/monthly-closing/route.ts) is what the workspace
  // calls on Refresh and on every Line/Month change. It must admit SFE Manager exactly as the page,
  // export route and nav card already do -- this was the ONE closing surface the suite never pinned,
  // so it stayed Super-Admin-only and 403'd his on-screen Closing Matrix ("Forbidden: Monthly Closing
  // is restricted to the admin account") the moment he refreshed or switched line, even though the
  // page server-renders that same matrix for him (owner report + fix, 2026-08-10). Publishing and
  // locking stay Super-Admin-only, pinned by (5) above.
  const monthlyClosingMatrixRouteSource = readFileSync("app/api/sales/monthly-closing/route.ts", "utf8");
  assert.match(
    monthlyClosingMatrixRouteSource,
    /access\.role\s*!==\s*"SFE Manager"/,
    "app/api/sales/monthly-closing/route.ts (the workspace's matrix reload feed) must admit SFE Manager, " +
      "mirroring the page gate -- otherwise his Refresh / line change on the Closing Matrix returns 403 while " +
      "the page server-renders the same matrix for him. If that decision changed, update this test and the " +
      "page gate together.",
  );
}
