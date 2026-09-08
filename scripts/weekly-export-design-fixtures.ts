/**
 * The two fixed workbooks the design lock is measured on.
 *
 * SHARED ON PURPOSE, for the same reason the fingerprint function is: the test asserts the emitted
 * package against the pins and `weekly-export-design-unlock.ts` writes the pins from the emitted
 * package. If the two built even slightly different workbooks, a legitimate unlock would produce a
 * pins file the test rejects — a lock nobody can open. One fixture, both callers.
 *
 * FIXED, so the pins cannot drift with the data. Nothing here reads the database, the clock or the
 * environment; `generatedAt` is a constant for the same reason.
 */
import { buildWeeklyExportWorkbook } from "@/lib/sales/weekly/export-workbook";
import { buildNsmDsmWorkbook } from "@/lib/sales/weekly/nsm-dsm-workbook";
import type { WeeklyManagerIndex } from "@/lib/sales/weekly/manager-attribution";
import type { WeeklyFactExportRow } from "@/lib/sales/weekly/types";
import { GENERATED_AT, sampleDashboard } from "../tests/weekly-export-workbook.test.ts";

export { GENERATED_AT } from "../tests/weekly-export-workbook.test.ts";

// ── the NSM/DSM book ────────────────────────────────────────────────────────────

const MANAGER_INDEX: WeeklyManagerIndex = {
  ceoName: "The CEO",
  dmByLineRegion: new Map(),
  nameByHrId: new Map(),
  operationalRegionByLineArea: new Map(),
  regionNameByCode: new Map([["GC", "Greater Cairo"], ["DL", "Delta"]]),
  seatsById: new Map(),
};

function nsmRow(overrides: Partial<WeeklyFactExportRow> = {}): WeeklyFactExportRow {
  return {
    areaCode: "C11",
    batchId: "b1",
    branchCode: "BR1",
    branchName: "Cairo Depot",
    cycleMonth: "2026-08",
    distributorCode: "IS",
    distributorName: "Ibn Sina-Sato",
    family: "Tebofortin",
    line: "CNS",
    productCode: "TEB80",
    productName: "Tebofortin 80mg",
    regionCode: "GC",
    regionName: "Greater Cairo",
    salesUnits: 120,
    salesValue: 48_000,
    stockUnits: 15,
    weekNumber: 1,
    weekStart: "2026-08-02",
    ...overrides,
  };
}

export async function buildNsmDsmFixture(): Promise<Buffer> {
  const rows: WeeklyFactExportRow[] = [
    nsmRow(),
    nsmRow({ productCode: "TEB120", productName: "Tebofortin 120mg", salesUnits: 80, salesValue: 36_000, stockUnits: 40 }),
    nsmRow({ areaCode: "C12", branchCode: "BR2", branchName: "Giza Depot", salesUnits: 40, salesValue: 19_000, stockUnits: 8, weekNumber: 2 }),
    nsmRow({ areaCode: null, branchCode: "CHN", branchName: "Chain Account", salesUnits: 25, salesValue: 11_500, stockUnits: 90, weekNumber: 2 }),
    nsmRow({ areaCode: "D21", branchCode: "BR3", branchName: "Gharbia Depot", regionCode: "DL", regionName: "Delta", salesUnits: 60, salesValue: 21_000, stockUnits: 30 }),
  ];
  return (await buildNsmDsmWorkbook({
    areaNames: new Map([["C11", "Cairo 1"], ["C12", "Cairo 2"], ["D21", "Gharbia 2"]]),
    areaSplit: null,
    generatedAt: "2026-09-08T09:00:00.000Z",
    lineFilter: ["CNS"],
    managerIndex: MANAGER_INDEX,
    periodLabel: "August 2026",
    productAxis: ["TEB80", "TEB120"],
    regionFilter: [],
    regionNames: new Map([["GC", "Greater Cairo"], ["DL", "Delta"]]),
    rows,
  })) as Buffer;
}

// ── the BI book ─────────────────────────────────────────────────────────────────
//
// REUSED, never restated. `sampleDashboard` is a large, precise object — kpis, compare, trend,
// weekComparison, appliedFilters and eight "available*" lists — and a hand-copied version of it
// would drift from the one `runWeeklyExportTests` builds the moment either is touched. The two
// would then fingerprint different workbooks and the lock would be unopenable. Importing the real
// one makes that impossible by construction.
//
// The test module defines functions and constants only — importing it runs no assertions.

export async function buildBiFixture(): Promise<Buffer> {
  return (await buildWeeklyExportWorkbook(sampleDashboard(), GENERATED_AT, { interactive: true })) as Buffer;
}

export const LOCKED_EXPORTS = [
  { build: buildBiFixture, key: "bi", label: "weekly BI export" },
  { build: buildNsmDsmFixture, key: "nsmDsm", label: "weekly NSM/DSM export" },
] as const;
