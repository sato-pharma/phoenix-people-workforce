import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PORTAL_NAV_REGISTRY } from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import { hrNavigationSections, sourceOfSalesPageItems } from "../src/config/system-navigation.ts";
import {
  HR_ROLE_BUNDLES,
  UNASSIGNED_HR_FUNCTIONS,
  composeHrRoleGrants,
  hrBundleGrants,
  type HrBundleName,
} from "../src/lib/auth/hr-functions.ts";
import { permissionMatrix, permissionResources } from "../src/lib/auth/permissions.ts";
import { MODULE_LABELS } from "../src/lib/navigation/module-catalog.ts";
import { accessRegistry } from "../src/lib/security/access-registry.ts";

/**
 * Territory Management reaches the HR Business Partner - owner instruction, 2026-09-07:
 * "territory management is not appearing in hr business partner account make it appear to her."
 *
 * The obvious way to grant it was `sales: ["read"]`, which is what the module was gated on. That
 * would have been the bug, not the fix: `sales:read` also carries Source of Sales, Monthly Closing,
 * Sales vs Target and every other money page whose nav row names no role - so honouring one
 * instruction would have handed her the company's commercial surface as a side effect nobody asked
 * for and nothing would have reported. So the map got a resource of its own.
 *
 * That split is the thing worth pinning, and it fails in two opposite directions:
 *
 *   - TOO NARROW - a role that reached the module under `sales:read` is not granted `territory`,
 *     and loses a page it has always had. Silent: the nav row simply stops rendering.
 *   - TOO WIDE - someone "tidies" the new key back into `sales` (its neighbours on the Source of
 *     Sales hub are all `sales:import`, so it looks like the odd one out), or adds `sales` to an HR
 *     function to fix an unrelated refusal.
 *
 * Section 5 is the one that cannot be inferred from the grants: her sales scope is NONE, which
 * resolves to EMPTY line/region/area sets rather than to "everything", so without the company-wide
 * branch in the territory service she would hold the grant, be offered the row, open the page - and
 * see a blank map. A page that looks broken is a worse answer than a page that refuses.
 *
 * RETIRED 2026-10-08. The owner retired the HR Business Partner seat that evening ("no more HR
 * business partner"; the rest of its work "Leave it for system administrator now"). Her map left with
 * it: the /hr row is gone, the hub card is back to its three admin-shell roles, and the company-wide
 * branch in the territory service is EMPTY but kept. The split itself still stands, and so does the
 * grant's home: `territory:read` travels with `workforce_insight`, now on UNASSIGNED_HR_FUNCTIONS,
 * so the day he hands that function to a seat the map comes with it — read and nothing else.
 */

// The retired key. It indexes the permission matrix only: it has no bundle any more.
const HRBP = "HR Advisory" as const;

function hrRow(href: string) {
  for (const section of hrNavigationSections) {
    for (const item of section.items) {
      if (item.href === href) return item;
    }
  }
  return null;
}

export function runHrbpTerritoryManagementAccessTests() {
  // 1. The resource exists in BOTH lists.
  // The union is compile-time; buildPermissionLookup iterates the array. A resource in one and not
  // the other yields a lookup with no key for it, and permissionAllowed treats an unseen key as
  // PERMITTED - the map would be offered to every role in the company rather than refused.
  assert.ok(
    permissionResources.includes("territory"),
    "`territory` must be in the runtime array too, or the nav lookup fails OPEN on it",
  );
  assert.equal(
    MODULE_LABELS.territory,
    "Territory Management",
    "every resource needs a module label or the lock picker renders an empty name",
  );

  // 2. The retired seat holds nothing; the grant still lives in its function.
  assert.equal(permissionMatrix[HRBP].territory, undefined, "the retired HR Business Partner seat holds no map");
  const composed = composeHrRoleGrants(["workforce_insight"]) as Record<string, string[] | undefined>;
  assert.deepEqual(
    composed.territory,
    ["read"],
    "the grant must come from an HR function, so it traces to a job-description line rather than " +
      "being written straight into the matrix — and it is read, the map, never the pin editor",
  );
  assert.ok(
    UNASSIGNED_HR_FUNCTIONS.includes("workforce_insight"),
    "workforce_insight left the unassigned list — if a seat holds it now, that seat holds the map " +
      "and needs its /hr row and the company-wide branch back (sections 5 and 7)",
  );
  for (const seat of Object.keys(HR_ROLE_BUNDLES) as HrBundleName[]) {
    assert.equal(
      hrBundleGrants(seat).territory,
      undefined,
      `${seat} holds territory — no live HR seat was given the map`,
    );
  }

  // 3. And the function does NOT carry the commercial surface.
  assert.equal(
    composed.sales,
    undefined,
    "the whole point of the split: `territory` must not arrive as `sales:read`, which opens " +
      "Source of Sales, Monthly Closing and Sales vs Target",
  );
  for (const resource of ["weekly_sales", "direct_orders"] as const) {
    assert.equal(
      composed[resource],
      undefined,
      `${resource} is money and is not part of reading a brick map`,
    );
  }

  // 4. Nobody who had the module lost it.
  // Every role the two nav rows offer Territory Management to reached it through `sales:read`
  // before 2026-09-07. Each must hold the new key, or the split quietly took a page away.
  for (const role of [
    "Super Admin",
    "CEO",
    "SFE Manager",
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
  ] as const) {
    assert.ok(
      permissionMatrix[role].territory?.includes("read"),
      `${role} reached Territory Management under sales:read and must still reach it`,
    );
  }

  // 5. A non-sales seat's scope must be company-wide, or the page renders blank.
  // resolveSalesAccessScope answers NONE for any role off the sales ladder, and NONE means EMPTY
  // sets, not "everything". The territory service carries an explicit branch ahead of that call. It
  // named the HR Business Partner until her seat was retired; it is empty now and must stay CALLED,
  // ahead of the sales scope, so the next non-sales seat given the map sees it whole.
  const service = readFileSync("src/lib/territory-management/service.ts", "utf8");
  assert.ok(
    service.includes("TERRITORY_COMPANY_WIDE_NON_SALES_ROLES = new Set<PhoenixRole>([])"),
    "the company-wide set must be empty since 2026-10-08 — the retired seat was its only member",
  );
  const branch = service.indexOf("TERRITORY_COMPANY_WIDE_NON_SALES_ROLES.has(access.role)");
  const salesScopeCall = service.indexOf("const salesScope = await resolveSalesAccessScope(access);");
  assert.ok(branch > 0, "the company-wide branch must still be called, not merely declared");
  assert.ok(branch < salesScopeCall, "the branch must run BEFORE the fail-closed sales scope");

  // 6. The gates and the rows agree.
  // A row whose permission and whose page gate disagree is the failure this repo has shipped
  // before: the link renders and the page refuses it.
  for (const file of [
    "app/(admin)/sales/territory-management/page.tsx",
    "app/employee-portals/territory-management/page.tsx",
    "app/api/territory-management/filters/route.ts",
    "app/api/territory-management/map/route.ts",
    "app/api/territory-management/scope/route.ts",
    "app/api/territory-management/search/route.ts",
  ]) {
    const source = readFileSync(file, "utf8");
    assert.ok(
      source.includes('assertPermission(access, "territory", "read")'),
      `${file} must gate on territory:read`,
    );
    assert.ok(
      !source.includes('assertPermission(access, "sales", "read")'),
      `${file} must not keep the old sales:read gate beside the new one`,
    );
  }
  for (const pattern of [
    "/api/territory-management/filters",
    "/api/territory-management/map",
    "/api/territory-management/scope",
    "/api/territory-management/search",
  ]) {
    const entry = accessRegistry.find((row) => row.pattern === pattern);
    assert.ok(entry, `${pattern} must stay in the access registry`);
    assert.deepEqual(
      entry?.permission,
      { resource: "territory", action: "read" },
      `${pattern}: the registry is what a reviewer reads instead of the handler - it must not lag`,
    );
  }

  // 6b. The portal registry's own copy of the gate.
  // A THIRD place records this module's permission, beside the handler and the access registry, and
  // it is the one this change missed on its first pass: tests/employee-portal-nav-permission-matches
  // -page.test.ts compares the registry's copy against the page's real gate and went red in CI while
  // every check run locally was green. Named here so the next edit has one fewer place to forget.
  const portalRow = PORTAL_NAV_REGISTRY.find((row) => row.href === "/employee-portals/territory-management");
  assert.ok(portalRow, "the portal registry row must survive the split");
  assert.deepEqual(
    portalRow?.permission,
    { resource: "territory", action: "read" },
    "the portal registry's copy must track the page's gate, or the drift check fails in CI",
  );

  // 7. The HR rail no longer carries the row — no live HR seat holds the map.
  assert.equal(
    hrRow("/hr/sales/territory-management"),
    null,
    "the /hr Territory Management row was the HR Business Partner's alone and left with her seat",
  );

  // The admin twin's card keeps its own role list; only its key moved in 2026-09.
  const card = sourceOfSalesPageItems.find((item) => item.href === "/sales/territory-management");
  assert.ok(card, "the Source of Sales hub card must survive the split");
  assert.deepEqual(card?.permissions, [{ resource: "territory" }]);
  assert.deepEqual(
    card?.roles,
    ["CEO", "SFE Manager", "Super Admin"],
    "the three admin-shell roles — the portal roles reach the module through their twin. The HR " +
      "Business Partner was named beside them from 2026-09-07 until her seat was retired",
  );
}
