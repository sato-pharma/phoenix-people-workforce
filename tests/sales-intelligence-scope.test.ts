import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getSalesScope, phoenixRoles, type PhoenixRole } from "../src/lib/auth/permissions.ts";
import {
  applyLineRegionScope,
  bridgeEmployeeLineToOfficial,
  canViewRestrictedProducts,
  computeSalesAccessScope,
  isRestrictedProductCode,
  RESTRICTED_PRODUCT_CODES,
  stripRestrictedRows,
} from "../src/lib/sales/access-scope.ts";

const migrationSource = readFileSync(
  new URL("../supabase/migrations/20260611120000_sales_intelligence_rpcs.sql", import.meta.url),
  "utf8",
);
const loaderSource = readFileSync(
  new URL("../src/lib/sales/intelligence/loader.ts", import.meta.url),
  "utf8",
);
const accessScopeSource = readFileSync(
  new URL("../src/lib/sales/access-scope.ts", import.meta.url),
  "utf8",
);

function scopeForRole(role: PhoenixRole, includeRestricted: boolean) {
  return computeSalesAccessScope({
    role,
    businessScope: getSalesScope({ role }),
    viewerLineName: null,
    viewerRegionName: null,
    includeRestricted,
  });
}

export function runSalesIntelligenceScopeTests() {
  // ── The headline rule: only CEO + Super Admin can ever reveal LA003/LA004 ──────────
  assert.deepEqual(
    [...RESTRICTED_PRODUCT_CODES],
    ["LA003", "LA004"],
    "restricted product codes must be exactly LA003 + LA004",
  );

  const PRIVILEGED: PhoenixRole[] = ["CEO", "Super Admin"];
  for (const role of phoenixRoles) {
    const privileged = PRIVILEGED.includes(role);
    assert.equal(
      canViewRestrictedProducts(role),
      privileged,
      `canViewRestrictedProducts must be ${privileged} for ${role}`,
    );

    // Default (no opt-in): restricted products excluded for EVERYONE.
    assert.deepEqual(
      scopeForRole(role, false).excludedProductCodes,
      ["LA003", "LA004"],
      `${role} must exclude LA003/LA004 by default`,
    );

    const optedIn = scopeForRole(role, true);
    if (privileged) {
      assert.deepEqual(
        optedIn.excludedProductCodes,
        [],
        `${role} opting in must reveal restricted products`,
      );
      assert.equal(optedIn.restrictedIncluded, true, `${role} opt-in must register`);
    } else {
      // The toggle is IGNORED for every non-privileged role — tampering cannot reveal them.
      assert.deepEqual(
        optedIn.excludedProductCodes,
        ["LA003", "LA004"],
        `${role} must NOT be able to reveal restricted products via the include flag`,
      );
      assert.equal(optedIn.restrictedIncluded, false, `${role} opt-in must be ignored`);
      assert.equal(optedIn.includeRestrictedProductsAllowed, false);
    }
  }

  // SFE Manager: company-wide visibility, yet STILL no restricted products (not CEO/SA).
  const sfe = scopeForRole("SFE Manager", true);
  assert.equal(sfe.canViewAllSales, true, "SFE Manager sees all sales");
  assert.deepEqual(sfe.excludedProductCodes, ["LA003", "LA004"], "SFE Manager still cannot see Lacto Basic");

  // ── stripRestrictedRows (defense in depth) ────────────────────────────────────────
  const rows = [
    { productCode: "LA003", value: 1 },
    { productCode: "la003", value: 1 },
    { productCode: " LA004 ", value: 1 },
    { productCode: "CN001", value: 1 },
    { productCode: "PE010", value: 1 },
  ];
  const stripped = stripRestrictedRows(rows, ["LA003", "LA004"]);
  assert.deepEqual(
    stripped.map((row) => row.productCode),
    ["CN001", "PE010"],
    "stripRestrictedRows must drop LA003/LA004 in any case/whitespace form",
  );
  assert.equal(
    stripRestrictedRows(rows, []).length,
    rows.length,
    "empty exclusion list strips nothing (CEO/SA opted in)",
  );
  assert.equal(isRestrictedProductCode(" la004 "), true);
  assert.equal(isRestrictedProductCode("CN001"), false);
  assert.equal(isRestrictedProductCode(null), false);

  // ── Line bridge (employee line name → Source-of-Sales official line) ───────────────
  assert.equal(bridgeEmployeeLineToOfficial("Anti Inf"), "Anti infective");
  assert.equal(bridgeEmployeeLineToOfficial("Office"), "Head Office");
  assert.equal(bridgeEmployeeLineToOfficial("Pedia"), "Pedia");
  assert.equal(bridgeEmployeeLineToOfficial("CNS"), "CNS");
  assert.equal(bridgeEmployeeLineToOfficial("  cns  "), "CNS");
  assert.equal(bridgeEmployeeLineToOfficial(null), null);
  assert.equal(bridgeEmployeeLineToOfficial(""), null);

  // ── computeSalesAccessScope: scope shape per role tier ────────────────────────────
  const ceo = computeSalesAccessScope({ role: "CEO", businessScope: "COMPANY", viewerLineName: null, viewerRegionName: null, includeRestricted: false });
  assert.equal(ceo.canViewAllSales, true);
  assert.equal(ceo.allowedLineNames, null);
  assert.equal(ceo.allowedRegionNames, null);

  const nsmCns = computeSalesAccessScope({ role: "National Sales Manager", businessScope: "LINE", viewerLineName: "CNS", viewerRegionName: "Cairo", includeRestricted: false });
  assert.deepEqual([...(nsmCns.allowedLineNames ?? [])], ["CNS"], "NSM is bounded to their line");
  assert.equal(nsmCns.allowedRegionNames, null, "LINE scope sees all regions in the line");

  const nsmOffice = computeSalesAccessScope({ role: "National Sales Manager", businessScope: "LINE", viewerLineName: "Office", viewerRegionName: null, includeRestricted: false });
  assert.deepEqual([...(nsmOffice.allowedLineNames ?? [])], ["Head Office"]);

  const nsmNoLine = computeSalesAccessScope({ role: "National Sales Manager", businessScope: "LINE", viewerLineName: null, viewerRegionName: null, includeRestricted: false });
  assert.deepEqual([...(nsmNoLine.allowedLineNames ?? ["SENTINEL"])], [], "missing line fails CLOSED (empty set)");

  const rsm = computeSalesAccessScope({ role: "Regional Manager", businessScope: "HIERARCHY", viewerLineName: "Anti Inf", viewerRegionName: "Cairo", includeRestricted: false });
  assert.deepEqual([...(rsm.allowedLineNames ?? [])], ["Anti infective"]);
  assert.deepEqual([...(rsm.allowedRegionNames ?? [])], ["cairo"], "Regional Manager is region-bounded");

  const mr = computeSalesAccessScope({ role: "Medical Rep", businessScope: "SELF", viewerLineName: "Pedia", viewerRegionName: "Giza", includeRestricted: false });
  assert.deepEqual([...(mr.allowedLineNames ?? [])], ["Pedia"]);
  assert.deepEqual([...(mr.allowedRegionNames ?? [])], ["giza"]);

  // ── applyLineRegionScope ──────────────────────────────────────────────────────────
  const dp = [
    { officialLine: "CNS", regionCode: "R1", value: 1 },
    { officialLine: "Pedia", regionCode: "R1", value: 1 },
    { officialLine: "CNS", regionCode: "R2", value: 1 },
  ];
  assert.equal(
    applyLineRegionScope(dp, { allowedLineNames: new Set(["CNS"]), allowedRegionCodes: null }).length,
    2,
    "line filter keeps only CNS rows",
  );
  assert.equal(
    applyLineRegionScope(dp, { allowedLineNames: new Set(["CNS"]), allowedRegionCodes: new Set(["R1"]) }).length,
    1,
    "line + region filter keeps CNS/R1 only",
  );
  assert.equal(
    applyLineRegionScope(dp, { allowedLineNames: null, allowedRegionCodes: null }).length,
    3,
    "null filters pass everything through",
  );
  // Brick rows carry no officialLine — line scope cannot apply, region scope still does.
  const bricks = [
    { regionCode: "R1", value: 1 },
    { regionCode: "R2", value: 1 },
  ];
  assert.equal(
    applyLineRegionScope(bricks, { allowedLineNames: new Set(["CNS"]), allowedRegionCodes: new Set(["R1"]) }).length,
    1,
    "brick rows are region-filtered even though line cannot apply",
  );

  // ── Structural guards: the SQL-layer boundary must be present and locked down ───────
  assert.match(migrationSource, /p_exclude_codes\s+text\[\]/, "SI RPCs must accept an exclude-codes array");
  assert.match(migrationSource, /unnest\(p_exclude_codes\)/, "exclusion must filter via unnest(p_exclude_codes)");
  assert.match(migrationSource, /p_lines\s+text\[\]/, "SI RPCs must accept a line-scope array");
  assert.match(migrationSource, /p_regions\s+text\[\]/, "SI RPCs must accept a region-scope array");
  assert.match(
    migrationSource,
    /revoke all on function public\.phx_si_distributor_product[\s\S]*?from public, anon, authenticated/,
    "SI RPCs must be revoked from anon/authenticated",
  );
  assert.match(
    migrationSource,
    /grant execute on function public\.phx_si_distributor_product[\s\S]*?to service_role/,
    "SI RPCs must be granted only to service_role",
  );
  for (const fn of ["phx_si_distributor_product", "phx_si_brick", "phx_si_customers"]) {
    assert.match(migrationSource, new RegExp(fn), `migration must define ${fn}`);
  }

  // Loader must always re-strip restricted rows in TS (defense in depth).
  assert.match(loaderSource, /stripRestrictedRows/, "loader must call stripRestrictedRows");
  // The canonical code list must not drift.
  assert.match(
    accessScopeSource,
    /RESTRICTED_PRODUCT_CODES\s*=\s*\["LA003",\s*"LA004"\]/,
    "RESTRICTED_PRODUCT_CODES must remain exactly LA003 + LA004",
  );

  // ── v2 RPC migration: every function must carry the full scope contract ─────────────
  const v2Source = readFileSync(
    new URL("../supabase/migrations/20260611142000_sales_intelligence_v2_rpcs.sql", import.meta.url),
    "utf8",
  );
  const v2Functions = [
    "phx_si_distributor_product",
    "phx_si_brick",
    "phx_si_customers",
    "phx_si_period_totals",
    "phx_si_daily",
    "phx_si_customer_product",
  ];
  for (const fn of v2Functions) {
    const bodyMatch = v2Source.match(
      new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?\\$\\$;`),
    );
    assert.ok(bodyMatch, `v2 migration must define ${fn}`);
    const body = bodyMatch[0];
    assert.match(body, /unnest\(p_exclude_codes\)/, `${fn} must exclude restricted products in SQL`);
    assert.match(body, /cardinality\(p_lines\)/, `${fn} must accept line scope`);
    assert.match(body, /cardinality\(p_regions\)/, `${fn} must accept region scope`);
    assert.match(body, /security definer/, `${fn} must be security definer`);
    assert.match(body, /statement_timeout/, `${fn} must carry its own statement timeout`);
    assert.match(body, /b\.status = 'validated'/, `${fn} must only read validated batches`);
    assert.match(
      v2Source,
      new RegExp(`revoke all on function public\\.${fn}\\([^)]*\\) from public, anon, authenticated`),
      `${fn} must be revoked from anon/authenticated`,
    );
    assert.match(
      v2Source,
      new RegExp(`grant execute on function public\\.${fn}\\([^)]*\\) to service_role`),
      `${fn} must be granted only to service_role`,
    );
  }
  // The Direct-channel fix: stored value for is_direct rows + the 'DIRECT' area bucket.
  assert.match(v2Source, /case when coalesce\(r\.is_direct, false\)/, "v2 must honor the Direct channel's stored value");
  assert.match(v2Source, /coalesce\(nullif\(r\.area_code, ''\), 'DIRECT'\)/, "v2 must bucket Direct rows under the DIRECT area");
  // The 28,877-pair customer×product grain must be fail-closed and LIMIT-clamped in SQL.
  assert.match(
    v2Source,
    /cardinality\(p_product_codes\) > 0 or cardinality\(p_client_codes\) > 0/,
    "customer×product must return nothing without an explicit drill filter",
  );
  assert.match(v2Source, /least\(coalesce\(p_limit, 100\), 500\)/, "customer×product must clamp its limit in SQL");
  // Day grain must be month-bounded (null period scans nothing).
  assert.match(v2Source, /p_period is not null/, "phx_si_daily must reject a null period");

  // ── Anti-loop pin: the per-period trend scan must never return ──────────────────────
  const serviceSource = readFileSync(
    new URL("../src/lib/sales/intelligence/service.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    serviceSource,
    /for\s*\(const trendPeriod of/,
    "the O(months) per-period trend loop must stay dead — trend rides phx_si_period_totals",
  );
  assert.match(serviceSource, /loadSiPeriodTotals/, "dashboard trend must use the one-scan period totals");
  // New loaders must flow through the single scope→args implementation.
  assert.match(loaderSource, /export async function loadSiPeriodTotals[\s\S]*?buildSiRpcArgs/, "period totals must use buildSiRpcArgs");
  assert.match(loaderSource, /export async function loadSiDaily[\s\S]*?buildSiRpcArgs/, "daily must use buildSiRpcArgs");
  assert.match(loaderSource, /export async function loadSiCustomerProduct[\s\S]*?buildSiRpcArgs/, "customer×product must use buildSiRpcArgs");
}
