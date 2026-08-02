import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RESTRICTED_PRODUCT_CODES } from "../src/lib/sales/access-scope.ts";
import {
  buildSourceOfSalesDashboard,
  type SourceOfSalesSummaryRecord,
  type SourceOfSalesUploadBatch,
} from "../src/lib/sales/monthly-distributor-import.ts";

function readSource(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
}

// The confidential Head Office line was visible to the SFE Manager on every surface fed by
// loadSourceOfSalesDashboard (/admin/sfe-command-center, /sales/import, and the
// /api/sales/monthly-import/dashboard route). The loader filtered restricted product CODES only and
// had no LINE filter at all, and its second parameter defaulted to `canViewRestricted = true` — a
// fail-OPEN default that every caller had to remember to override.
//
// `sales:import` is held by exactly one non-Super-Admin role (SFE Manager), so all three surfaces
// leaked to the same role. Measured in production 2026-08-02, the Head Office line holds 4 products:
// LA003 / LA004 / SS001 — which the independent restricted-code lock already hid — plus RY001, which
// it did not. RY001 is what actually reached the screen (June 2026: 630.00 EGP under a "Head Office"
// line row). The value was small only by accident: nothing stops a fifth product landing on that
// line tomorrow, and the line total is 212.5M.
//
// These tests pin the LINE-grain fix, not the product-code accident.
function summary(input: Partial<SourceOfSalesSummaryRecord> & { groupType: string }): SourceOfSalesSummaryRecord {
  return {
    batchId: "batch-1",
    groupCode: null,
    groupKey: input.groupLabel ?? input.groupType,
    groupLabel: input.groupType,
    officialLine: null,
    rowCount: 1,
    totalBonusQty: 0,
    totalQty: 1,
    totalValue: 0,
    ...input,
  };
}

function product(code: string, label: string, line: string, value: number): SourceOfSalesSummaryRecord {
  return summary({
    groupCode: code,
    groupKey: `${code}|${label}|${line}`,
    groupLabel: label,
    groupType: "product",
    officialLine: line,
    totalValue: value,
  });
}

function region(code: string, label: string, value: number): SourceOfSalesSummaryRecord {
  return summary({
    groupCode: code,
    groupKey: `${code}|${label}`,
    groupLabel: label,
    groupType: "region",
    totalValue: value,
  });
}

// No `as` cast — the fixture is checked against the real type, so a field drifting here is a
// compile error rather than a silently-wrong test.
const batch: SourceOfSalesUploadBatch = {
  batchId: "batch-1",
  blockingReasons: [],
  createdAt: "2026-06-01T00:00:00.000Z",
  distributorCode: "D1",
  distributorName: "Distributor One",
  failedRows: 0,
  fileName: "d1.xlsx",
  importableRows: 4,
  period: "2026-06",
  rowCount: 4,
  status: "validated",
  templateKey: "generic",
  totalBonusQty: 0,
  totalQty: 4,
  totalValue: 1000,
  uploadedBy: "tester",
  warningRows: 0,
};

function line(name: string, value: number): SourceOfSalesSummaryRecord {
  return summary({
    groupKey: name,
    groupLabel: name,
    groupType: "line",
    officialLine: name,
    totalValue: value,
  });
}

// Pedia 600 + CNS 300 = 900 visible. Head Office carries RY001 (100) — NOT a restricted code, which
// is precisely the row the old code-only filter let through — plus LA003 (5000), which it did hide.
//
// Both grains are present because the two paths read different rows: the unrestricted CEO path
// aggregates the pre-computed `line` summaries, while every scoped path re-derives byLine from the
// `product` rows (the only grain that carries a filterable product code).
const PRODUCTS = [
  product("PD001", "Pedia Product", "Pedia", 600),
  product("CN001", "CNS Product", "CNS", 300),
  product("RY001", "ROYANOXICAM 8MG 20 TAB", "Head Office", 100),
  product("LA003", "Lacto Basic 1", "Head Office", 5000),
  line("Pedia", 600),
  line("CNS", 300),
  line("Head Office", 5100),
];

export function runSosImportDashboardHeadOfficeLockTests() {
  // ── The leak: RY001 is on the confidential line but is NOT a restricted code ──────────────
  assert.ok(
    !RESTRICTED_PRODUCT_CODES.some((code) => code.toUpperCase() === "RY001"),
    "RY001 is not in RESTRICTED_PRODUCT_CODES — the code list alone cannot hide the Head Office line",
  );

  // ── Scoped viewer (SFE Manager et al): the whole line disappears ──────────────────────────
  const scoped = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-06"],
    batches: [batch],
    excludeHeadOfficeLine: true,
    geoSummaries: [region("R1", "Delta", 540), region("R2", "Cairo", 360)],
    period: "2026-06",
    restrictedProductCodes: [...RESTRICTED_PRODUCT_CODES],
    summaries: PRODUCTS,
  });

  assert.deepEqual(
    scoped.byLine.map((group) => group.label).sort(),
    ["CNS", "Pedia"],
    "byLine must not contain a Head Office row",
  );
  assert.equal(
    scoped.byProduct.some((group) => group.code === "RY001"),
    false,
    "byProduct must drop RY001 — a Head Office product that is not a restricted code",
  );
  assert.equal(
    scoped.totals.totalValue,
    900,
    "totals must exclude the entire Head Office line (600 Pedia + 300 CNS), not just the restricted codes",
  );
  assert.equal(
    scoped.byDistributor.reduce((sum, row) => sum + row.totalValue, 0),
    900,
    "byDistributor is re-derived from visible products only",
  );
  // Geography reconciles (540 + 360 = 900) so it is shown.
  assert.deepEqual(
    scoped.byRegion.map((group) => group.label).sort(),
    ["Cairo", "Delta"],
    "a reconciling geography split is shown, not withheld",
  );

  // ── CEO / Super Admin: nothing is stripped ────────────────────────────────────────────────
  const unrestricted = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-06"],
    batches: [batch],
    period: "2026-06",
    summaries: PRODUCTS,
  });
  assert.equal(
    unrestricted.totals.totalValue,
    1000,
    "the CEO fast path still sums whole-batch totals unchanged",
  );
  assert.ok(
    unrestricted.byLine.some((group) => group.label === "Head Office"),
    "CEO / Super Admin still see the Head Office line",
  );

  // ── The fast path must NOT be taken when only the line lock is on ─────────────────────────
  // A viewer allowed to see restricted products but not Head Office would otherwise get
  // whole-batch totals, which bake in every line.
  const lineLockOnly = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-06"],
    batches: [batch],
    excludeHeadOfficeLine: true,
    period: "2026-06",
    summaries: PRODUCTS,
  });
  assert.equal(
    lineLockOnly.totals.totalValue,
    900,
    "line lock alone re-derives from the visible products (600 + 300) — never the 1000 batch total",
  );
  assert.notEqual(
    lineLockOnly.totals.totalValue,
    batch.totalValue,
    "the whole-batch fast path must not be reachable once the line lock is on",
  );
  assert.equal(
    lineLockOnly.byLine.some((group) => group.label === "Head Office"),
    false,
    "line lock alone still removes the Head Office line",
  );

  // The two locks are independent: a restricted product that does NOT sit on the Head Office line
  // survives the line lock (and vice versa). Production happens to put all three restricted codes on
  // Head Office, which is exactly why the code list looked sufficient — this pins the logic, not
  // that coincidence.
  const independent = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-06"],
    batches: [batch],
    excludeHeadOfficeLine: true,
    period: "2026-06",
    summaries: [
      product("PD001", "Pedia Product", "Pedia", 600),
      product("LA004", "Lacto Basic 2 (on Pedia)", "Pedia", 250),
      product("RY001", "ROYANOXICAM 8MG 20 TAB", "Head Office", 100),
    ],
  });
  assert.equal(
    independent.totals.totalValue,
    850,
    "line lock alone keeps a restricted code that is not on the Head Office line (600 + 250)",
  );
  assert.equal(
    independent.byProduct.some((group) => group.code === "RY001"),
    false,
    "…while still dropping the non-restricted product that IS on the Head Office line",
  );

  // ── Geo reconciliation guard: fail closed rather than show a contaminated split ───────────
  // byRegion/byArea/byBrick have no line dimension, so they are line-filtered by excluding the
  // line's product codes. If geography ever carries MORE value than the line-scoped total, that
  // exclusion under-filtered and the split still contains confidential rows — withhold all three.
  const contaminated = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-06"],
    batches: [batch],
    excludeHeadOfficeLine: true,
    geoSummaries: [
      region("R1", "Delta", 540),
      region("R2", "Cairo", 360),
      region("R3", "Head Office leak", 100),
      summary({ groupCode: "A1", groupKey: "A1|Alex", groupLabel: "Alex", groupType: "area", totalValue: 1000 }),
      summary({ groupCode: "B1", groupKey: "B1|Brick", groupLabel: "Brick", groupType: "brick", totalValue: 1000 }),
    ],
    period: "2026-06",
    restrictedProductCodes: [...RESTRICTED_PRODUCT_CODES],
    summaries: PRODUCTS,
  });
  assert.deepEqual(contaminated.byRegion, [], "byRegion is withheld when geography exceeds the scoped total");
  assert.deepEqual(contaminated.byArea, [], "byArea is withheld alongside it");
  assert.deepEqual(contaminated.byBrick, [], "byBrick is withheld alongside it");
  assert.equal(contaminated.totals.totalValue, 900, "the line-scoped total itself stays correct");

  // A geography that sums BELOW the scoped total is not a leak (unmapped geography) — keep it.
  const partialGeo = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-06"],
    batches: [batch],
    excludeHeadOfficeLine: true,
    geoSummaries: [region("R1", "Delta", 540)],
    period: "2026-06",
    restrictedProductCodes: [...RESTRICTED_PRODUCT_CODES],
    summaries: PRODUCTS,
  });
  assert.deepEqual(
    partialGeo.byRegion.map((group) => group.label),
    ["Delta"],
    "an under-sum is unmapped geography, not a leak — it must still render",
  );

  // The guard must never fire for an unscoped (CEO) viewer. That path takes its geography from the
  // unfiltered summaries (the geo RPC is not called at all for a CEO) and is never reconciled — its
  // geography legitimately exceeds any single line's total.
  const ceoGeo = buildSourceOfSalesDashboard({
    availablePeriods: ["2026-06"],
    batches: [batch],
    period: "2026-06",
    summaries: [...PRODUCTS, region("R1", "Delta", 99999)],
  });
  assert.deepEqual(
    ceoGeo.byRegion.map((group) => group.label),
    ["Delta"],
    "the reconciliation guard is scoped-viewer-only and must not blank the CEO's geography",
  );
  assert.equal(
    ceoGeo.byRegion[0]?.totalValue,
    99999,
    "the CEO's geography is passed through untouched, even far above the batch total",
  );

  // ── Source pins: the API shape is what stops this recurring ───────────────────────────────
  const loader = readSource("../src/lib/sales/monthly-distributor-import.ts");
  assert.ok(
    /export async function loadSourceOfSalesDashboard\(\s*period: string \| null \| undefined,\s*viewer: SourceOfSalesDashboardViewer,\s*\)/.test(loader),
    "loadSourceOfSalesDashboard takes a REQUIRED viewer — not an optional fail-open boolean",
  );
  // Matches a PARAMETER default (`canViewRestricted = true,` / `…= true)`) rather than the phrase,
  // so the docstring explaining why the old default was removed does not trip its own pin.
  assert.ok(
    !/canViewRestricted\s*=\s*true\s*[,)]/.test(loader),
    "the fail-open `canViewRestricted = true` parameter default is gone",
  );
  assert.ok(
    loader.includes("const canViewHeadOffice = canViewHeadOfficeLine(viewer.role)")
      && loader.includes("const canViewRestricted = canViewRestrictedProducts(viewer.role)"),
    "both confidential locks are derived inside the loader from the role, so no caller can forget one",
  );
  assert.ok(
    loader.includes("excludeHeadOfficeLine: !canViewHeadOffice"),
    "the loader threads the line lock into every buildSourceOfSalesDashboard call",
  );
  assert.equal(
    (loader.match(/excludeHeadOfficeLine: !canViewHeadOffice/g) ?? []).length,
    3,
    "all three build sites (no period, no validated batch, and the main path) carry the lock",
  );
  assert.ok(
    loader.includes("loadHeadOfficeProductCodes")
      && /if \(!headOfficeCodes\) \{\s*geoSummaries = \[\];/.test(loader),
    "an unreadable product master withholds geography rather than using an incomplete exclusion list",
  );

  // Every caller must pass the role. A positional boolean would silently re-open the hole.
  for (const rel of [
    "../app/(admin)/sales/import/page.tsx",
    "../app/api/sales/monthly-import/dashboard/route.ts",
    "../src/lib/ceo/command-center.ts",
  ]) {
    const source = readSource(rel);
    assert.ok(
      /loadSourceOfSalesDashboard\([^)]*\{\s*role:/.test(source),
      `${rel} passes a viewer { role } to loadSourceOfSalesDashboard`,
    );
    assert.ok(
      !/loadSourceOfSalesDashboard\([^)]*canViewRestrictedProducts\(/.test(source),
      `${rel} no longer passes a pre-computed restricted-products boolean`,
    );
  }
}
