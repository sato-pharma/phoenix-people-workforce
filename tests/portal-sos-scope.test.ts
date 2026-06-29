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
}
