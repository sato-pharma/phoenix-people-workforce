import assert from "node:assert/strict";

import { applyWeeklyAccessScope, type WeeklyAccessScope } from "../src/lib/sales/weekly/access.ts";

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
  const fullOpen = applyWeeklyAccessScope(rows, { tier: "full", canViewRestricted: true });
  assert.deepEqual(codesOf(fullOpen), ["GU001", "LA003", "LA004", "RO001", "SA001"], "full+restricted keeps Lacto");

  // Full access but NOT allowed to reveal (e.g. SFE Manager) → Lacto Basic stripped.
  const fullClosed = applyWeeklyAccessScope(rows, { tier: "full", canViewRestricted: false });
  assert.deepEqual(codesOf(fullClosed), ["GU001", "RO001", "SA001"], "full without reveal strips Lacto");

  // Product scope → only assigned codes; a restricted code is dropped even if (wrongly) assigned.
  const product: WeeklyAccessScope = { tier: "product", productCodes: new Set(["GU001", "RO001", "LA003"]) };
  assert.deepEqual(codesOf(applyWeeklyAccessScope(rows, product)), ["GU001", "RO001"], "product scope = assigned, no Lacto");

  // Empty product scope → sees nothing.
  assert.deepEqual(
    applyWeeklyAccessScope(rows, { tier: "product", productCodes: new Set() }),
    [],
    "empty product scope sees nothing",
  );

  // Territory scope → line + region bound; Lacto stripped regardless.
  const territory: WeeklyAccessScope = {
    tier: "territory",
    allowedLineNames: new Set(["Pedia"]),
    allowedRegionCodes: new Set(["AB"]),
  };
  assert.deepEqual(codesOf(applyWeeklyAccessScope(rows, territory)), ["GU001"], "territory line+region bound");

  // Territory with line only (all regions) keeps Pedia rows but never Lacto Basic.
  const lineOnly: WeeklyAccessScope = {
    tier: "territory",
    allowedLineNames: new Set(["Pedia"]),
    allowedRegionCodes: null,
  };
  assert.deepEqual(codesOf(applyWeeklyAccessScope(rows, lineOnly)), ["GU001"], "territory line-only strips Lacto");

  // None → empty.
  assert.deepEqual(applyWeeklyAccessScope(rows, { tier: "none" }), [], "none sees nothing");
}
