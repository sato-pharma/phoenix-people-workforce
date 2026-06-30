import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PORTAL_SOS_ROLES,
  computePortalSosVisibility,
  isPortalSosRole,
} from "../src/lib/sales/portal-sos-dashboard.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// Guards the employee-portal Source-of-Sales scope + smart-filter rules:
//   - which roles may open the dashboard,
//   - which filters are shown/hidden per scope shape (the security-sensitive UX rule), and
//   - that the engine still enforces product + region lockdown server-side (source pins).
export function runPortalSosScopeTests() {
  // ── Role gate ───────────────────────────────────────────────────────────────
  for (const role of [
    "District Manager",
    "Regional Manager",
    "National Sales Manager",
    "Product Manager",
    "Group Product Manager",
    "Marketing Manager",
  ] as const) {
    assert.equal(isPortalSosRole(role), true, `${role} must access portal SoS`);
  }
  for (const role of ["Medical Rep", "SFE Manager", "CEO", "Super Admin", "Employee", "Manager"] as const) {
    assert.equal(isPortalSosRole(role), false, `${role} must NOT access portal SoS`);
  }
  assert.equal(PORTAL_SOS_ROLES.length, 6, "exactly six roles get the portal SoS tab");

  // ── Filter visibility per scope shape ─────────────────────────────────────────
  const line = (...names: string[]) => new Set(names.map((n) => n.toLowerCase()));
  const region = (...codes: string[]) => new Set(codes.map((c) => c.toUpperCase()));

  // DSM: single line, single region → line hidden, region HIDDEN, area shown.
  const dsm = computePortalSosVisibility(line("pedia"), region("CAI"));
  assert.equal(dsm.line, false, "DSM line hidden");
  assert.equal(dsm.region, false, "DSM region hidden (single fixed region)");
  assert.equal(dsm.area, true, "DSM area shown");
  assert.equal(dsm.product, true);
  assert.equal(dsm.distributor, true);

  // RM: single line, multiple regions → line hidden, region SHOWN.
  const rm = computePortalSosVisibility(line("pedia"), region("CAI", "ALX", "DLT"));
  assert.equal(rm.line, false, "RM line hidden");
  assert.equal(rm.region, true, "RM region shown (his regions)");

  // NSM: single line, no region lock → line hidden, region shown.
  const nsm = computePortalSosVisibility(line("pedia"), null);
  assert.equal(nsm.line, false, "NSM line hidden");
  assert.equal(nsm.region, true, "NSM region shown");

  // PM/GPM: single line, no region lock → line hidden, region shown (product scope handled separately).
  const pm = computePortalSosVisibility(line("cns"), null);
  assert.equal(pm.line, false, "PM line hidden");
  assert.equal(pm.region, true, "PM region shown");

  // MM: three lines → line SHOWN, region shown.
  const mm = computePortalSosVisibility(line("pedia", "cns", "anti infective"), null);
  assert.equal(mm.line, true, "MM line shown (3 lines)");
  assert.equal(mm.region, true, "MM region shown");

  // Company (null line set) → line shown.
  const company = computePortalSosVisibility(null, null);
  assert.equal(company.line, true, "company line shown");

  // Period is always available.
  for (const v of [dsm, rm, nsm, pm, mm, company]) {
    assert.equal(v.period, true);
    assert.equal(v.area, true);
    assert.equal(v.product, true);
    assert.equal(v.distributor, true);
  }

  // ── Engine server-side lockdown pins ──────────────────────────────────────────
  const engine = readSource("../src/lib/sales/sos-dashboard.ts");
  assert.ok(
    engine.includes("scopeProductCodes && !scopeProductCodes.has(row.productCode.toUpperCase())"),
    "engine keepExec must enforce product-code lockdown",
  );
  assert.ok(
    engine.includes("scopeRegionCodes && !scopeRegionCodes.has(row.regionCode.toUpperCase())"),
    "engine keepExec must enforce region-code lockdown",
  );
  assert.ok(
    engine.includes("canSeeCrossLineGeography") && engine.includes("emptyRpcRows"),
    "engine must skip brick/customer RPCs for non-company callers (perf)",
  );
  // Performance: the detail RPC must receive the scope ∩ filter selection so the database
  // pre-filters, rather than returning the whole company and filtering only in keepExec.
  assert.ok(
    engine.includes('"phx_exec_distributor_product"') &&
      engine.includes("p_products: trendProductCodes") &&
      engine.includes("p_regions: trendRegionCodes") &&
      engine.includes("p_exclude_codes: excludeCodes"),
    "engine must push scope+filter selection into the phx_exec_distributor_product RPC",
  );
  // Head Office line is confidential — CEO/Super Admin only. Pinned at the row filter, the filter
  // options (line + products), and the trend so it can never leak to any other role.
  assert.ok(
    engine.includes("!canSeeHeadOffice && isHeadOfficeLine(row.officialLine)"),
    "engine keepExec must strip the Head Office line for non-CEO/Super-Admin",
  );
  assert.ok(
    engine.includes("canSeeHeadOffice || !isHeadOfficeLine(p.line)"),
    "engine must strip Head Office products from the filter options",
  );
  const accessScope = readSource("../src/lib/sales/access-scope.ts");
  assert.ok(
    /export function canViewHeadOfficeLine/.test(accessScope) && /role === "CEO" \|\| role === "Super Admin"/.test(accessScope),
    "Head Office line visibility must be limited to CEO / Super Admin",
  );

  // The portal API must resolve scope from the session and reject non-SoS roles.
  const route = readSource("../app/api/employee-portals/source-of-sales/route.ts");
  assert.ok(route.includes("isPortalSosRole(access.role)"), "portal SoS API must gate by role");
  assert.ok(route.includes("getPortalSosDashboard"), "portal SoS API must use the scoped wrapper");

  // ── Area scoping — a region-locked viewer (RM / DSM) must never see areas outside his regions ──
  // Single-region detection is exactly "one region in scope" (DSM); this is the same condition that
  // hides the Region filter, so the two must stay in agreement.
  assert.equal(dsm.region, false, "single-region viewer hides the Region filter");
  assert.equal(rm.region, true, "multi-region viewer (RM) shows the Region filter");

  const wrapper = readSource("../src/lib/sales/portal-sos-dashboard.ts");
  // RM's region universe is his managed reporting subtree, forwarded to the engine as the override.
  assert.ok(
    wrapper.includes("resolveRegionalManagerRegionCodes") && /regionCodes = regionOverride/.test(wrapper),
    "RM region scope must come from his managed reporting subtree",
  );
  // isSingleRegion is derived from the region set size and exported to the client for layout.
  assert.ok(
    wrapper.includes("regionCodes !== null && regionCodes.size === 1"),
    "wrapper must derive isSingleRegion from the region set size",
  );
  // The Area filter dropdown is trimmed to the viewer's in-scope regions — never the whole company.
  assert.ok(
    wrapper.includes("regionCodes.has(String(area.region).toUpperCase())"),
    "wrapper must trim Area options to the viewer's region scope",
  );

  // Engine: byArea is built from the region-locked `detail` set, and the Area Coverage denominator
  // (masterAreas) is itself scoped to the viewer's regions — so a region-locked caller can never see
  // or be measured against areas outside his regions.
  assert.ok(
    engine.includes("!scopeRegionCodes || scopeRegionCodes.has((a.regionCode ?? \"\").toUpperCase())"),
    "engine must scope the area-coverage denominator (masterAreas) to the viewer's regions",
  );
  assert.ok(
    /const byArea = group\(\s*detail,/.test(engine),
    "engine byArea must be grouped from the region-locked detail rows",
  );
  // Single-region viewers get a "top area" insight instead of the useless "top region = 100%".
  assert.ok(
    engine.includes("if (input.singleRegion)") && engine.includes("is the top area at"),
    "engine must swap the top-region insight for a top-area insight when single-region",
  );

  // UI: DSM swaps "By region" for a vertical By-area chart and drops the Region breakdown tab;
  // multi-region viewers keep By region and gain a horizontal By-area chart.
  const ui = readSource("../src/components/sales/portal/portal-sos-dashboard.tsx");
  assert.ok(ui.includes("scope.isSingleRegion ?"), "UI must branch chart layout on isSingleRegion");
  assert.ok(ui.includes("<ColumnBars"), "UI must render the vertical ColumnBars chart for DSM By-area");
  assert.ok(
    ui.includes("singleRegion ? [] : [{ key: \"region\""),
    "UI must drop the Region breakdown tab for single-region viewers",
  );
}
