import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { applyWeeklyAccessScope, type WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";

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
    canViewHeadOffice: true,
  };
  assert.deepEqual(codesOf(applyWeeklyAccessScope(rows, territory)), ["GU001"], "territory line+region bound");

  // Territory with line only (all regions) keeps Pedia rows but never Lacto Basic.
  const lineOnly: WeeklyAccessScope = {
    tier: "territory",
    allowedLineNames: new Set(["Pedia"]),
    allowedRegionCodes: null,
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
    service.includes('const distributorsForEmpty = (filters?.accessScope?.tier ?? "full") === "full" ? distributors : [];'),
    "the empty-dashboard shortcut must not leak the full distributor catalog to a restricted tier",
  );
}
