import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  canAccessWeeklyMappingTemplate,
  phoenixRoles,
  systemAccessContext,
  type AccessContext,
} from "../src/lib/auth/permissions.ts";
import { applyWeeklyAccessScope, type WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";
import {
  COMPANY_WEEKLY_READER_ROLES,
  PORTAL_WEEKLY_ROLES,
  isCompanyWeeklyReader,
  mayReadManagersWeeklySales,
} from "../src/lib/sales/weekly/portal-weekly-dashboard.ts";
import { stripComments } from "./support/comment-strip.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

type Row = { productCode: string; officialLine?: string | null; regionCode?: string | null };

const rows: Row[] = [
  { productCode: "SA001", officialLine: "CNS", regionCode: "CA" },
  { productCode: "RO001", officialLine: "Anti infective", regionCode: "UE" },
  { productCode: "GU001", officialLine: "Pedia", regionCode: "AB" },
  { productCode: "LA003", officialLine: "Pedia", regionCode: "CA" }, // Lacto Basic 1 (restricted)
  { productCode: "LA004", officialLine: "Pedia", regionCode: "GZ" }, // Lacto Basic 2 (restricted)
];

const codesOf = (result: Row[]) => result.map((row) => row.productCode).sort();

export async function runWeeklySalesAccessTests() {
  // Full access + may reveal restricted → everything, including Lacto Basic.
  const fullOpen = applyWeeklyAccessScope(rows, { tier: "full", canViewRestricted: true, canViewHeadOffice: true });
  assert.deepEqual(codesOf(fullOpen), ["GU001", "LA003", "LA004", "RO001", "SA001"], "full+restricted keeps Lacto");

  // Full access but NOT allowed to reveal (e.g. SFE Manager) → Lacto Basic stripped.
  const fullClosed = applyWeeklyAccessScope(rows, { tier: "full", canViewRestricted: false, canViewHeadOffice: true });
  assert.deepEqual(codesOf(fullClosed), ["GU001", "RO001", "SA001"], "full without reveal strips Lacto");

  // Product scope → only assigned codes; a restricted code is dropped even if (wrongly) assigned.
  const product: WeeklyAccessScope = { tier: "product", productCodes: new Set(["GU001", "RO001", "LA003"]), canViewHeadOffice: true };
  assert.deepEqual(codesOf(applyWeeklyAccessScope(rows, product)), ["GU001", "RO001"], "product scope = assigned, no Lacto");

  // Empty product scope → sees nothing.
  assert.deepEqual(
    applyWeeklyAccessScope(rows, { tier: "product", productCodes: new Set(), canViewHeadOffice: true }),
    [],
    "empty product scope sees nothing",
  );

  // Territory scope → line + region bound; Lacto stripped regardless.
  const territory: WeeklyAccessScope = {
    tier: "territory",
    allowedLineNames: new Set(["Pedia"]),
    allowedRegionCodes: new Set(["AB"]),
    allowedAreaCodes: null,
    canViewHeadOffice: true,
  };
  assert.deepEqual(codesOf(applyWeeklyAccessScope(rows, territory)), ["GU001"], "territory line+region bound");

  // Territory with line only (all regions) keeps Pedia rows but never Lacto Basic.
  const lineOnly: WeeklyAccessScope = {
    tier: "territory",
    allowedLineNames: new Set(["Pedia"]),
    allowedRegionCodes: null,
    allowedAreaCodes: null,
    canViewHeadOffice: true,
  };
  assert.deepEqual(codesOf(applyWeeklyAccessScope(rows, lineOnly)), ["GU001"], "territory line-only strips Lacto");

  // None → empty.
  assert.deepEqual(applyWeeklyAccessScope(rows, { tier: "none", canViewHeadOffice: true }), [], "none sees nothing");

  // ── Head Office confidential line ───────────────────────────────────────────
  const hoRows: Row[] = [
    { productCode: "PD001", officialLine: "Pedia", regionCode: "AB" },
    { productCode: "HO001", officialLine: "Head Office", regionCode: "CA" },
    { productCode: "HO002", officialLine: "office", regionCode: "GZ" }, // legacy variant
  ];
  // canViewHeadOffice false → Head Office line stripped for every tier (here: full).
  assert.deepEqual(
    codesOf(applyWeeklyAccessScope(hoRows, { tier: "full", canViewRestricted: true, canViewHeadOffice: false })),
    ["PD001"],
    "Head Office stripped when not allowed",
  );
  // canViewHeadOffice true (CEO / Super Admin) → Head Office kept.
  assert.deepEqual(
    codesOf(applyWeeklyAccessScope(hoRows, { tier: "full", canViewRestricted: true, canViewHeadOffice: true })),
    ["HO001", "HO002", "PD001"],
    "Head Office kept for CEO / Super Admin",
  );

  // ── distributors/sources metadata scope (loadWeeklyDashboard is DB-backed and not mockable in
  // this harness, so pin the exact scoping logic at the source level — same approach already used
  // for the sibling Source-of-Sales module in tests/portal-sos-scope.test.ts). ────────────────────
  const service = readSource("../src/lib/sales/weekly/service.ts");
  assert.ok(
    service.includes(
      'const scopeVisibleDistributorCodes =\n    accessScope.tier === "full" ? null : new Set(visibleRows.map((row) => normalizeCode(row.distributorCode)));',
    ),
    "service must derive scopeVisibleDistributorCodes from visibleRows (null only for full tier)",
  );
  assert.ok(
    service.includes("scopeVisibleDistributorCodes &&\n        !scopeVisibleDistributorCodes.has(normalizeCode(String(batch.distributor_code ?? \"\")))"),
    "the `sources` (Report Sources) list must be gated by scopeVisibleDistributorCodes",
  );
  assert.ok(
    service.includes(
      "distributors: scopeVisibleDistributorCodes\n      ? distributors.filter((d) => scopeVisibleDistributorCodes.has(normalizeCode(d.code)))\n      : distributors,",
    ),
    "the returned `distributors` dropdown list must be gated by scopeVisibleDistributorCodes",
  );
  assert.ok(
    service.includes('const distributorsForEmpty = accessScope.tier === "full" ? distributors : [];'),
    "the empty-dashboard shortcut must not leak the full distributor catalog to a restricted tier",
  );

  // ── mapping-template workbook audience ────────────────────────────────────────────────────────
  // The workbook embeds the UNSCOPED master catalogue incl. the confidential Head Office line, so
  // its audience must stay the mapping audience (Super Admin + SFE Manager) plus the CEO, who is
  // already cleared for Head Office but holds weekly_sales read+export only. #2234 moved it off
  // `export` — which reaches down to Medical Rep — and that swept the CEO out with the field.
  const allowed = new Set(["Super Admin", "SFE Manager", "CEO"]);
  for (const role of phoenixRoles) {
    const context = { ...systemAccessContext, role, scope: role === "Super Admin" ? "system" : "self" } as AccessContext;
    assert.equal(
      await canAccessWeeklyMappingTemplate(context),
      allowed.has(role),
      `${role} must ${allowed.has(role) ? "reach" : "NOT reach"} the weekly mapping template workbook`,
    );
  }

  // ── the managers' Weekly Sales dashboard: every role access.ts gives weekly access reaches it ──
  // Owner, 2026-10-20: every role a module applies to must find it. access.ts gives the SFE Manager
  // full weekly access and his own overview links him to /admin/field-sales/weekly-sales, yet that
  // page and all five of its feeds admitted the CEO and the Super Admin alone and sent him back to
  // /admin. One predicate now gates the page and every feed.
  const accessSource = stripComments(readSource("../src/lib/sales/weekly/access.ts")).replace(/\s+/g, " ");
  assert.match(
    accessSource,
    /if \(ctx\.role === "SFE Manager"\) \{ return \{ tier: "full", canViewRestricted: false \}; \}/,
    "the premise: access.ts gives the SFE Manager full weekly access, minus the confidential Lacto Basic",
  );
  assert.deepEqual([...COMPANY_WEEKLY_READER_ROLES].sort(), ["CEO", "SFE Manager", "Super Admin"]);
  const managersFeed = new Set<string>([...PORTAL_WEEKLY_ROLES, ...COMPANY_WEEKLY_READER_ROLES]);
  for (const role of phoenixRoles) {
    assert.equal(
      mayReadManagersWeeklySales(role),
      managersFeed.has(role),
      `${role} must ${managersFeed.has(role) ? "reach" : "NOT reach"} the managers' Weekly Sales feeds`,
    );
  }
  assert.equal(
    mayReadManagersWeeklySales("SFE Manager"),
    true,
    "THE SFE MANAGER MUST REACH THE WEEKLY SALES DASHBOARD HIS OWN ACCESS SCOPE ALREADY GRANTS — he was refused by every gate until 2026-10-20",
  );
  assert.equal(mayReadManagersWeeklySales("Medical Rep"), false, "a rep reads his own area's screen, never the managers' feeds");
  assert.equal(isCompanyWeeklyReader("National Sales Manager"), false, "a field manager reads the portal, not the company host");

  const page = stripComments(readSource("../app/(admin)/admin/field-sales/weekly-sales/page.tsx")).replace(/\s+/g, " ");
  assert.match(
    page,
    /if \(!\(isCompanyWeeklyReader\(access\.role\) \|\| canAccessSystemAdministratorWorkspace\(access\)\)\) \{ redirect\("\/admin"\);/,
    "the admin Weekly Sales page admits the company-wide readers through the shared list",
  );
  for (const route of [
    "../app/api/employee-portals/weekly-sales/route.ts",
    "../app/api/employee-portals/weekly-sales/export/route.ts",
    "../app/api/employee-portals/weekly-sales/product-units/route.ts",
    "../app/api/employee-portals/weekly-sales/depot-detail/route.ts",
    "../app/api/employee-portals/weekly-sales/depot-detail/export/route.ts",
  ]) {
    const source = stripComments(readSource(route)).replace(/\s+/g, " ");
    assert.match(
      source,
      /if \(!mayReadManagersWeeklySales\(access\.role\)\) \{ return NextResponse\.json\(\{ success: false, error: "Forbidden\." \}, \{ status: 403 \}\);/,
      `${route} gates on the one shared predicate`,
    );
    assert.doesNotMatch(
      source,
      /access\.role === "CEO" \|\| access\.role === "Super Admin"/,
      `${route} still names the two-role list that refused the SFE Manager`,
    );
  }
}
