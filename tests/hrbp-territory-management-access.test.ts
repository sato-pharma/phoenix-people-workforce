import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { PORTAL_NAV_REGISTRY } from "../src/components/employee-portal/employee-portal-nav-registry.ts";
import { hrNavigationSections, sourceOfSalesPageItems } from "../src/config/system-navigation.ts";
import { HR_ROLE_BUNDLES, hrBundleGrants } from "../src/lib/auth/hr-functions.ts";
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
 */

// `as const`, not `: PhoenixRole`. It indexes HR_ROLE_BUNDLES and hrBundleGrants, both of which are
// keyed by the two HR BUNDLE names rather than by the whole role union - widening it here is a
// typecheck error, and it is the narrow type that carries the meaning anyway.
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

  // 2. The HR Business Partner holds it, and holds it from the catalogue.
  assert.deepEqual(
    permissionMatrix[HRBP].territory,
    ["read"],
    "the owner asked for the map, not for the pin editor: read and nothing else",
  );
  const composed = hrBundleGrants(HRBP) as Record<string, string[] | undefined>;
  assert.deepEqual(
    composed.territory,
    ["read"],
    "the grant must come from an HR function, so it traces to a job-description line rather than " +
      "having been written straight into the matrix",
  );
  assert.ok(
    (HR_ROLE_BUNDLES[HRBP] as readonly string[]).includes("workforce_insight"),
    "the grant lives in workforce_insight; moving it to a shared function would hand the map to " +
      "HR Operations, who was never named",
  );

  // 3. And she does NOT gain the commercial surface.
  assert.equal(
    permissionMatrix[HRBP].sales,
    undefined,
    "the whole point of the split: `territory` must not arrive as `sales:read`, which opens " +
      "Source of Sales, Monthly Closing and Sales vs Target",
  );
  for (const resource of ["weekly_sales", "direct_orders"] as const) {
    assert.equal(
      permissionMatrix[HRBP][resource],
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

  // 5. Her scope is company-wide, or the page renders blank.
  // resolveSalesAccessScope answers NONE for any role off the sales ladder, and NONE means EMPTY
  // sets, not "everything". The territory service carries an explicit branch ahead of that call;
  // this asserts the branch is still there and still names her.
  const service = readFileSync("src/lib/territory-management/service.ts", "utf8");
  assert.ok(
    service.includes('TERRITORY_COMPANY_WIDE_NON_SALES_ROLES = new Set<PhoenixRole>(["HR Advisory"])'),
    "without the company-wide branch her map is empty - she has no line, no region and no seat",
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

  // 7. Her sidebar actually carries the row.
  // The grant alone renders nothing: the HR navigation is AUTHORED, deliberately not derived from
  // the permission matrix, so a permission with no row is a module she still cannot find.
  const row = hrRow("/hr/sales/territory-management");
  assert.ok(row, "the HR sidebar must carry the row - that is the whole instruction");
  assert.equal(row?.label, "Territory Management");
  assert.deepEqual(row?.permissions, [{ resource: "territory" }], "the row's key must match the page's gate");
  assert.deepEqual(row?.roles, [HRBP], "offered to the seat the owner named, not to both HR seats");

  // The admin twin's card keeps its own role list; only its key moved.
  const card = sourceOfSalesPageItems.find((item) => item.href === "/sales/territory-management");
  assert.ok(card, "the Source of Sales hub card must survive the split");
  assert.deepEqual(card?.permissions, [{ resource: "territory" }]);
  assert.deepEqual(
    card?.roles,
    ["CEO", "SFE Manager", "Super Admin", "HR Advisory"],
    "the three admin-shell roles are unchanged - the portal roles reach the module through their " +
      "twin - and she is named beside them because hr-url-namespace.test.ts reads an /hr row as a " +
      "WIDENING unless the admin navigation already admits the seat to that page. The card itself " +
      "stays out of her reach: the hub it sits on is sales:read",
  );
}
