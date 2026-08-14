// ─────────────────────────────────────────────────────────────────────────────
// S1 Business Review — the LIVE canonical build.
//
// This module replaces the five committed JSON snapshots as the source of every SALES
// number on /business-review-s1 and its employee-portal twin. Sales, targets and
// achievement now come from the same canonical engine as Monthly Closing and
// /sales-vs-target — au.f_monthly_achievement, reached through loadAchievementRange —
// so the S1 review can no longer disagree with the rest of Phoenix about what a person,
// an area or a line sold in a given month. That disagreement was real: the workbook put
// H1 at 55,225,794.39 EGP and the canonical engine puts it at 59,390,438.29 (+7.5%).
//
// WHY THIS IS A RESTATED REVIEW, NOT A PAYOUT RECORD
//
// The numbers below are NOT what H1 2026 was paid on. H1 payouts were settled against the
// legacy `sales_records` engine and are closed (owner decision, 2026-08-13: the Incentive
// tab moves forward to Semester 2 and does not restate H1). Rebuilt from canonical, some
// areas and districts land in a different band than the one they were actually paid in.
// That is the point of the rebuild — it makes the review agree with the sales truth — and
// it is exactly why every surface that renders this data must label it a restated review.
// `S1_RESTATEMENT_NOTICE` below is that label; do not render this dataset without it.
//
// WHAT IS CANONICAL AND WHAT IS NOT — the split is deliberate
//
//   CANONICAL (live, this module):  sales value, sales units, target, achievement, the
//   area list, the district list, area↔district attribution, region, vacancy, and the
//   product mix. All of it at (period, line, area, product) grain from one range call.
//
//   CARRIED FORWARD (the committed workbook JSON): marketing spend, outstation spend, CRM
//   visits, double visits and unique-doctor counts. These are NOT sales, Rule #1 does not
//   reach them, and the canonical engine holds no equivalent. Their workbook figures also
//   embody owner rulings — which CRM rows were deduplicated, which marketing requests count
//   as committed spend — that must not be silently re-derived inside a sales migration.
//   `ireports360_visits_effective` does hold H1 visits live (92,620 rows Jan–Jun vs the
//   workbook's 69,682 deduplicated), and rebuilding those is a separate decision for the
//   owner, not a side effect of this one.
//
// The carried figures are joined to the canonical districts by DM SEAT ID, taken from
// data/access-map.json — the same seat map the portal scope trusts, and the only key that
// survives a district changing hands. A canonical seat with no 1:1 workbook counterpart
// gets `overlayAvailable: false` and zeros, never a guessed cost.
//
// TWO WORKBOOK ARTEFACTS ARE DELIBERATELY DROPPED
//
//   1. The Pedia "exception" (+280,000 EGP of Ivyronc, included at line level and excluded
//      at rep/DM level). It was a manual reconciliation patch for a workbook discrepancy.
//      The canonical engine already carries that order, at its real area, in its real
//      month — re-adding it would double-count. `exceptionValue` is 0 and `withException`
//      equals the plain totals.
//   2. Per-line `include` sets that name products the line does not canonically sell.
//      Canonical attributes a SKU to the line that owns it, so Pedia's workbook rows for
//      Dolabactin and the Tebofortin family now sit on CNS where the catalogue puts them.
//      That is a restatement, not a loss — the value is still in the company total.
//
// NOTHING IS EVER SILENTLY DROPPED. Rows with no line, and rows with no area, are counted
// and reported through `provenance`, never discarded to make a total look tidy.
// ─────────────────────────────────────────────────────────────────────────────

import { applyAchievementAreaMerges, getMergedAreaName } from "@/lib/sales/closing-area-merges";
import {
  loadAllCanonicalAreaNames,
  loadEmployeeNameMap,
  loadProductNameMap,
  regionName,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import {
  emptyTotals,
  loadAchievementRange,
  loadUploadedPeriodsInRange,
  totalRows,
  type VsTargetTotals,
} from "@/lib/sales/vs-target";
import accessMapRaw from "./data/access-map.json";
import antiData from "./data/anti-s1.json";
import cnsData from "./data/cns-s1.json";
import companyData from "./data/company-s1.json";
import pediaData from "./data/pedia-s1.json";
import type {
  AreaSummary,
  CompanyLineRow,
  DmSummary,
  LineSummary,
  ProductRow,
  S1Company,
  S1Dataset,
  Slice,
} from "./types";

export type S1Line = "pedia" | "cns" | "anti";

/** The label every surface rendering this dataset must show. Not optional. */
export const S1_RESTATEMENT_NOTICE =
  "Restated review — not a payout record. Rebuilt from SoS Monthly Closing, the same engine " +
  "as Sales vs Target. H1 2026 incentives were paid against the retired sales engine and are " +
  "closed; some bands here differ from what was actually paid.";

export const S1_FROM = "2026-01";
export const S1_TO = "2026-06";
const S1_PERIODS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"] as const;
const S1_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun"] as const;
const MONTH_OF_PERIOD = new Map<string, string>(S1_PERIODS.map((p, i) => [p, S1_MONTHS[i]]));

/** S1 line id → the line_code the canonical engine uses. */
const LINE_CODE: Record<S1Line, string> = { pedia: "pedia", cns: "cns", anti: "anti_infective" };
const S1_LINE_ORDER: { id: S1Line; label: string }[] = [
  { id: "pedia", label: "Pedia" },
  { id: "cns", label: "CNS" },
  { id: "anti", label: "Anti-Infective" },
];

/**
 * The owner's `includeProducts` ruling, resolved to product CODES.
 *
 * The ruling was written in workbook spelling and three of its entries do not match the
 * live catalogue name at all — "Sagenkgo" is catalogue SA001 "Saginko", "Royafloxacin
 * 500mg tab" is RO001 "Royafloxacin", "Tebofrtin drops" is TE001 "Tebofotin drops".
 * Matching on name would have quietly dropped those three from every include-only figure,
 * which is precisely the class of silent miss this migration exists to remove. Codes are
 * stable; names are not.
 */
const INCLUDE_PRODUCT_CODES: Record<S1Line, ReadonlySet<string>> = {
  // Guamusin, Ivyronc, Lacto Advanced 1, Lacto Advanced 2.
  pedia: new Set(["GU001", "IV001", "LA001", "LA002"]),
  // All fifteen CNS SKUs are included by the ruling.
  cns: new Set([
    "TE001", "TE002", "TE003", "TE004", "TE005",
    "CO001", "CO002", "CO003", "CO004",
    "RI001", "RI002", "RI003",
    "DO001", "DO002", "DO003",
  ]),
  // "Royafloxacin 500mg tab" and "Sagenkgo".
  anti: new Set(["RO001", "SA001"]),
};

/**
 * Product family, by code.
 *
 * Same reason as the include set: keyed on code, not name. The Anti-Infective ruling
 * already records that the source workbook's own Family column mislabelled Royafloxacin as
 * "Dolabactin" in January and February — deriving family from the row was never safe.
 */
const PRODUCT_FAMILY: Record<string, string> = {
  LA001: "Lacto", LA002: "Lacto",
  IV001: "Ivyronc",
  GU001: "Guamusin",
  TE001: "Tebofortin", TE002: "Tebofortin", TE003: "Tebofortin", TE004: "Tebofortin", TE005: "Tebofortin",
  CO001: "Conviban", CO002: "Conviban", CO003: "Conviban", CO004: "Conviban",
  RI001: "Rispadex", RI002: "Rispadex", RI003: "Rispadex",
  DO001: "Dopaminect", DO002: "Dopaminect", DO003: "Dolabactin",
  SA001: "Saginko",
  RO001: "Royafloxacin",
};

// ── The carried-forward (non-sales) overlay ──────────────────────────────────

type WorkbookDataset = {
  meta: { thresholds: { repFailBelow: number; dsmFailBelow: number }; rulings: Record<string, string | string[]> };
  line: LineSummary;
  dms: DmSummary[];
  marketing: S1Dataset["marketing"];
  outstation: S1Dataset["outstation"];
  visits: S1Dataset["visits"];
  doubleVisits: S1Dataset["doubleVisits"];
};

const WORKBOOK: Record<S1Line, WorkbookDataset> = {
  pedia: pediaData as unknown as WorkbookDataset,
  cns: cnsData as unknown as WorkbookDataset,
  anti: antiData as unknown as WorkbookDataset,
};
const WORKBOOK_COMPANY = companyData as unknown as S1Company;

type AccessMapShape = {
  generatedAt: string;
  lines: Record<string, { areas: Record<string, { dmSeatId: string | null; s1Dm: string }> }>;
};
const ACCESS_MAP = accessMapRaw as unknown as AccessMapShape;

/** The non-sales figures a district carries, or nulls when the seat has no workbook twin. */
export type DmOverlay = Pick<
  DmSummary,
  | "marketingCost" | "marketingMonths" | "marketingByMonth"
  | "outstationCost" | "outstationMonths" | "outstationByMonth"
  | "doubleVisits" | "visits" | "visitsAvgPerMonth" | "visitsByMonth"
  | "customersTotal" | "customersByMonth"
>;

const EMPTY_OVERLAY: DmOverlay = {
  marketingCost: 0, marketingMonths: 0, marketingByMonth: {},
  outstationCost: 0, outstationMonths: 0, outstationByMonth: {},
  doubleVisits: 0, visits: 0, visitsAvgPerMonth: 0, visitsByMonth: {},
  customersTotal: 0, customersByMonth: {},
};

/**
 * DM seat id → that seat's workbook district figures.
 *
 * Built only from seats whose relation to a workbook DM label is 1:1 in BOTH directions —
 * the same fail-closed rule portal-scope.ts applies for territory. A seat carrying two
 * workbook labels, or a label spread over two seats, cannot be told apart, and attaching
 * one district's marketing spend to another district's seat would be a fabrication rather
 * than a gap.
 */
function overlayBySeat(line: S1Line): Map<string, DmOverlay> {
  const areas = ACCESS_MAP.lines[line]?.areas ?? {};
  const dmsBySeat = new Map<string, Set<string>>();
  const seatsByDm = new Map<string, Set<string>>();
  for (const entry of Object.values(areas)) {
    if (!entry.dmSeatId) continue;
    if (!dmsBySeat.has(entry.dmSeatId)) dmsBySeat.set(entry.dmSeatId, new Set());
    dmsBySeat.get(entry.dmSeatId)!.add(entry.s1Dm);
    if (!seatsByDm.has(entry.s1Dm)) seatsByDm.set(entry.s1Dm, new Set());
    seatsByDm.get(entry.s1Dm)!.add(entry.dmSeatId);
  }

  const byName = new Map(WORKBOOK[line].dms.map((d) => [d.dm, d]));
  const out = new Map<string, DmOverlay>();
  for (const [seat, labels] of dmsBySeat) {
    if (labels.size !== 1) continue;
    const label = [...labels][0];
    if (seatsByDm.get(label)?.size !== 1) continue;
    const wb = byName.get(label);
    if (!wb) continue;
    out.set(seat, {
      marketingCost: wb.marketingCost, marketingMonths: wb.marketingMonths, marketingByMonth: wb.marketingByMonth,
      outstationCost: wb.outstationCost, outstationMonths: wb.outstationMonths, outstationByMonth: wb.outstationByMonth,
      doubleVisits: wb.doubleVisits, visits: wb.visits, visitsAvgPerMonth: wb.visitsAvgPerMonth,
      visitsByMonth: wb.visitsByMonth, customersTotal: wb.customersTotal, customersByMonth: wb.customersByMonth,
    });
  }
  return out;
}

// ── Small numeric helpers ────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A totals bucket rendered as the review's `Slice`.
 *
 * `ach` is a PERCENTAGE (90.02), not a fraction, because that is what the two client
 * components already render. It divides the COVERED actual by the target — sales sitting
 * on a key that has no target are reported beside the percentage, never inside it — and it
 * is null, never 0, when there is no target to divide by.
 */
function sliceOf(t: VsTargetTotals): Slice {
  return {
    sales: round2(t.actualValue),
    target: round2(t.targetValue),
    ach: t.achievementValue == null ? null : round2(t.achievementValue * 100),
  };
}

const EMPTY_SLICE: Slice = { sales: 0, target: 0, ach: null };

function groupBy<T>(rows: readonly T[], key: (row: T) => string | null): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    if (k == null) continue;
    const bucket = map.get(k);
    if (bucket) bucket.push(row);
    else map.set(k, [row]);
  }
  return map;
}

/** The value on the LATEST period that carries one — "as of the end of S1". */
function latest<T>(rows: readonly AchievementRow[], pick: (row: AchievementRow) => T | null): T | null {
  let bestPeriod = "";
  let best: T | null = null;
  for (const row of rows) {
    const value = pick(row);
    if (value == null || row.period < bestPeriod) continue;
    bestPeriod = row.period;
    best = value;
  }
  return best;
}

function monthlySlices(rows: readonly AchievementRow[]): Record<string, Slice> {
  const out: Record<string, Slice> = {};
  const byPeriod = groupBy(rows, (r) => r.period);
  for (const period of S1_PERIODS) {
    const month = MONTH_OF_PERIOD.get(period)!;
    out[month] = sliceOf(totalRows(byPeriod.get(period) ?? []));
  }
  return out;
}

function monthlyAch(rows: readonly AchievementRow[]): Record<string, number | null> {
  const slices = monthlySlices(rows);
  const out: Record<string, number | null> = {};
  for (const month of S1_MONTHS) out[month] = slices[month].ach;
  return out;
}

function monthlySales(rows: readonly AchievementRow[]): number[] {
  const byPeriod = groupBy(rows, (r) => r.period);
  return S1_PERIODS.map((period) => round2(totalRows(byPeriod.get(period) ?? []).actualValue));
}

// ── Provenance ───────────────────────────────────────────────────────────────

export type S1LineProvenance = {
  line: S1Line;
  label: string;
  /** Actual value sitting on a (line, area, product) key that has a target. */
  coveredValue: number;
  /** Actual value with no target anywhere — reported beside the %, never inside it. */
  uncoveredValue: number;
  /** Months in which this line has at least one canonical target. */
  periodsWithTarget: string[];
  /** Canonical DM seats with no 1:1 workbook district, so no spend/visit figures. */
  seatsWithoutOverlay: string[];
};

export type S1Provenance = {
  engine: "SoS Monthly Closing (au.f_monthly_achievement)";
  from: string;
  to: string;
  /** Months whose distributor upload actually landed — NOT `has_actual`. */
  uploadedPeriods: string[];
  /** Months inside the window with no distributor upload at all. */
  missingUploadPeriods: string[];
  /** Rows the engine returned with no sales line — real value, in no line's dataset. */
  unlinedValue: number;
  unlinedRows: number;
  lines: S1LineProvenance[];
  /** The workbook the non-sales figures are carried from, and when its seat map was cut. */
  overlaySource: string;
  overlayGeneratedAt: string;
  restatementNotice: string;
};

// ── The build ────────────────────────────────────────────────────────────────

type Names = {
  area: (lineCode: string, code: string) => string;
  product: (code: string) => string;
  employee: (hrId: string) => string;
};

/** Sentinel for canonical rows that resolved to a line but to no area. Uses the repo's
 * standing six-character backslash-u-zero-zero-zero-zero escape for a NUL separator/sentinel — never a raw byte,
 * which ripgrep/git-grep silently treat the whole file as binary and skip (memory:
 * raw-nul-byte-makes-source-invisible-to-ripgrep). */
const NO_AREA_KEY = "\u0000no-area";
const NO_AREA_NAME = "Unattributed — no area on the source row";
const NO_DM_KEY = "\u0000no-dm";
const NO_DM_NAME = "No district manager";

function buildAreas(line: S1Line, rows: AchievementRow[], names: Names): AreaSummary[] {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  const lineCode = LINE_CODE[line];

  return [...groupBy(rows, (r) => r.areaCode ?? NO_AREA_KEY)]
    .map(([areaKey, areaRows]) => {
      const isUnattributed = areaKey === NO_AREA_KEY;
      const includeRows = areaRows.filter((r) => includeCodes.has(r.productCode.toUpperCase()));
      const dmHrId = latest(areaRows, (r) => r.dmHrId);
      const region = regionName(latest(areaRows, (r) => r.regionCode)) || "Unassigned region";

      // Vacancy AS OF the end of the semester, the same single-status view the workbook
      // took. An area whose latest period has no rep occupant reads vacant even if it was
      // staffed in January — which is what a semester review is asking.
      const lastPeriodWithRows = areaRows.reduce((max, r) => (r.period > max ? r.period : max), "");
      const vacant = !areaRows.some((r) => r.period === lastPeriodWithRows && r.repHrId);

      const products: Record<string, Slice> = {};
      for (const [code, productRows] of groupBy(includeRows, (r) => r.productCode.toUpperCase())) {
        products[names.product(code)] = sliceOf(totalRows(productRows));
      }

      const allProducts = sliceOf(totalRows(areaRows));
      return {
        area: isUnattributed ? NO_AREA_NAME : names.area(lineCode, areaKey),
        areaCode: isUnattributed ? null : areaKey,
        dmSeatId: latest(areaRows, (r) => r.dmSeatId),
        dm: dmHrId ? names.employee(dmHrId) : `${region} (vacant)`,
        region,
        vacant,
        includeOnly: sliceOf(totalRows(includeRows)),
        allProducts,
        hasTarget: areaRows.some((r) => r.hasTarget),
        // "Ungradeable" is the workbook's word for an area no achievement can be computed
        // for. Canonical says the same thing by returning a null achievement.
        ungradeable: allProducts.ach == null,
        hasReturns: Object.values(monthlySlices(areaRows)).some((s) => s.sales < 0),
        products,
        trend: monthlySales(includeRows),
      } satisfies AreaSummary;
    })
    .sort((a, b) => b.allProducts.sales - a.allProducts.sales);
}

function buildDms(line: S1Line, rows: AchievementRow[], areas: AreaSummary[], names: Names): DmSummary[] {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  const overlay = overlayBySeat(line);
  const areasBySeat = groupBy(areas, (a) => a.dmSeatId ?? NO_DM_KEY);

  return [...groupBy(rows, (r) => r.dmSeatId ?? NO_DM_KEY)]
    .map(([seatKey, seatRows]) => {
      const isUnmanaged = seatKey === NO_DM_KEY;
      const seatAreas = areasBySeat.get(seatKey) ?? [];
      const activeAreaNames = new Set(seatAreas.filter((a) => !a.vacant).map((a) => a.area));
      const dmHrId = latest(seatRows, (r) => r.dmHrId);
      const region = regionName(latest(seatRows, (r) => r.regionCode)) || "Unassigned region";

      const includeRows = seatRows.filter((r) => includeCodes.has(r.productCode.toUpperCase()));
      // "Active" excludes vacant areas, so a district is not judged on territory it had
      // nobody in. Resolved through the area list, which already decided vacancy once.
      const activeAreaCodes = new Set(seatAreas.filter((a) => !a.vacant).map((a) => a.areaCode));
      const activeRows = includeRows.filter((r) => activeAreaCodes.has(r.areaCode));

      const productAch: Record<string, number | null> = {};
      for (const [code, productRows] of groupBy(includeRows, (r) => r.productCode.toUpperCase())) {
        productAch[names.product(code)] = sliceOf(totalRows(productRows)).ach;
      }
      const familyAch: Record<string, number | null> = {};
      for (const [family, familyRows] of groupBy(includeRows, (r) => PRODUCT_FAMILY[r.productCode.toUpperCase()] ?? null)) {
        familyAch[family] = sliceOf(totalRows(familyRows)).ach;
      }

      const carried = (!isUnmanaged && overlay.get(seatKey)) || EMPTY_OVERLAY;
      return {
        dm: isUnmanaged ? NO_DM_NAME : dmHrId ? names.employee(dmHrId) : `${region} (vacant)`,
        dmSeatId: isUnmanaged ? null : seatKey,
        region,
        vacant: !isUnmanaged && !dmHrId,
        areas: seatAreas.map((a) => a.area),
        activeAreas: [...activeAreaNames],
        includeOnly: sliceOf(totalRows(includeRows)),
        activeIncludeOnly: sliceOf(totalRows(activeRows)),
        allProducts: sliceOf(totalRows(seatRows)),
        productAch,
        familyAch,
        trend: monthlySales(includeRows),
        achByMonth: monthlyAch(includeRows),
        achByMonthActive: monthlyAch(activeRows),
        /** False when this seat has no 1:1 workbook district — the spend/visit fields are
         *  then zeros meaning "not known", not zeros meaning "spent nothing". */
        overlayAvailable: !isUnmanaged && overlay.has(seatKey),
        ...carried,
      } satisfies DmSummary;
    })
    .sort((a, b) => b.allProducts.sales - a.allProducts.sales);
}

function buildProducts(line: S1Line, rows: AchievementRow[], names: Names): ProductRow[] {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  return [...groupBy(rows, (r) => r.productCode.toUpperCase())]
    .map(([code, productRows]) => ({
      product: names.product(code),
      family: PRODUCT_FAMILY[code] ?? names.product(code),
      include: includeCodes.has(code),
      byMonth: monthlySlices(productRows),
      total: sliceOf(totalRows(productRows)),
    }))
    .sort((a, b) => b.total.sales - a.total.sales);
}

function buildLineSummary(
  line: S1Line,
  rows: AchievementRow[],
  areas: AreaSummary[],
  includeRows: AchievementRow[],
): LineSummary {
  const wb = WORKBOOK[line].line;
  const vacantAreaCodes = new Set(areas.filter((a) => a.vacant).map((a) => a.areaCode));
  const exVacantRows = includeRows.filter((r) => !vacantAreaCodes.has(r.areaCode));

  const quarterRows = (periods: readonly string[]) => {
    const set = new Set(periods);
    return {
      includeOnly: sliceOf(totalRows(includeRows.filter((r) => set.has(r.period)))),
      allProducts: sliceOf(totalRows(rows.filter((r) => set.has(r.period)))),
    };
  };

  const byMonth: LineSummary["byMonth"] = {};
  for (const period of S1_PERIODS) {
    const month = MONTH_OF_PERIOD.get(period)!;
    byMonth[month] = {
      includeOnly: sliceOf(totalRows(includeRows.filter((r) => r.period === period))),
      allProducts: sliceOf(totalRows(rows.filter((r) => r.period === period))),
    };
  }

  const includeOnly = sliceOf(totalRows(includeRows));
  const allProducts = sliceOf(totalRows(rows));
  return {
    includeOnly,
    allProducts,
    // The workbook's manual +280,000 Ivyronc reconciliation has no meaning against an
    // engine that already carries that order at its real area and month.
    withException: { includeOnly, allProducts },
    exVacant: { includeOnly: sliceOf(totalRows(exVacantRows)) },
    exceptionValue: 0,
    quarters: {
      Q1: quarterRows(["2026-01", "2026-02", "2026-03"]),
      Q2: quarterRows(["2026-04", "2026-05", "2026-06"]),
    },
    byMonth,
    // Carried forward — see this module's header. Not sales, no canonical equivalent.
    marketingCost: wb.marketingCost,
    outstationCost: wb.outstationCost,
    visits: wb.visits,
    doubleVisits: wb.doubleVisits,
    visitsAvgPerRepPerMonth: wb.visitsAvgPerRepPerMonth,
    // Live: how many distinct medical reps actually held a seat carrying sales in H1.
    reps: new Set(rows.map((r) => r.repHrId).filter(Boolean)).size,
    customersTotal: wb.customersTotal,
    customersByMonth: wb.customersByMonth,
  };
}

function buildDataset(line: S1Line, rows: AchievementRow[], names: Names): S1Dataset {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  const includeRows = rows.filter((r) => includeCodes.has(r.productCode.toUpperCase()));
  const areas = buildAreas(line, rows, names);
  const wb = WORKBOOK[line];

  return {
    meta: {
      line: S1_LINE_ORDER.find((l) => l.id === line)!.label,
      period: "S1 2026 (Jan–Jun)",
      currency: "EGP",
      months: [...S1_MONTHS],
      generatedFrom: [
        "SoS Monthly Closing — au.f_monthly_achievement, 2026-01 to 2026-06 (live)",
        "data/access-map.json — DM seat map, for the carried non-sales figures",
        `data/${line}-s1.json — marketing, outstation, CRM visits and doctor counts only`,
      ],
      thresholds: wb.meta.thresholds,
      rulings: wb.meta.rulings,
    },
    line: buildLineSummary(line, rows, areas, includeRows),
    products: buildProducts(line, rows, names),
    dms: buildDms(line, rows, areas, names),
    areas,
    marketing: wb.marketing,
    outstation: wb.outstation,
    visits: wb.visits,
    doubleVisits: wb.doubleVisits,
  };
}

function buildCompany(datasets: Record<S1Line, S1Dataset>): S1Company {
  const wbTotal = WORKBOOK_COMPANY.total;
  let sales = 0, target = 0, exSales = 0, exTarget = 0, reps = 0, areasTotal = 0, areasVacant = 0;
  const byMonth: Record<string, { sales: number; target: number }> = {};
  for (const month of S1_MONTHS) byMonth[month] = { sales: 0, target: 0 };

  const lines: CompanyLineRow[] = S1_LINE_ORDER.map(({ id, label }) => {
    const ds = datasets[id];
    const ap = ds.line.allProducts;
    const ev = ds.line.exVacant.includeOnly;
    sales += ap.sales; target += ap.target;
    exSales += ev.sales; exTarget += ev.target;
    reps += ds.line.reps;
    for (const month of S1_MONTHS) {
      byMonth[month].sales += ds.line.byMonth[month]?.allProducts.sales ?? 0;
      byMonth[month].target += ds.line.byMonth[month]?.allProducts.target ?? 0;
    }
    const vacant = ds.areas.filter((a) => a.vacant).length;
    areasTotal += ds.areas.length;
    areasVacant += vacant;

    // Same two filters the workbook build used, so the two never disagree about what
    // counts as a district: only graded areas score, only target-bearing seats count.
    const graded = ds.areas.filter((a) => a.hasTarget && a.allProducts.ach != null);
    const seats = ds.dms.filter((d) => d.allProducts.target > 0);
    return {
      id,
      label,
      allProducts: ap,
      exVacant: ev,
      marketingCost: ds.line.marketingCost,
      outstationCost: ds.line.outstationCost,
      visits: ds.line.visits,
      visitsAvailable: ds.visits.available,
      doubleVisits: ds.line.doubleVisits,
      customersTotal: ds.line.customersTotal,
      dms: seats.filter((d) => !d.vacant).length,
      dmsVacant: seats.filter((d) => d.vacant).length,
      areas: ds.areas.length,
      areasVacant: vacant,
      earners: graded.filter((a) => !a.vacant && (a.allProducts.ach ?? 0) >= 90).length,
      repFails: graded.filter((a) => !a.vacant && (a.allProducts.ach ?? 0) < ds.meta.thresholds.repFailBelow).length,
    };
  }).sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1));

  const dms = S1_LINE_ORDER.flatMap(({ id, label }) =>
    datasets[id].dms
      .filter((d) => d.allProducts.target > 0)
      .map((d) => ({
        dm: d.dm,
        line: label,
        lineId: id,
        vacant: d.vacant,
        allProducts: d.allProducts,
        marketingCost: d.marketingCost,
        outstationCost: d.outstationCost,
        visitsAvgPerMonth: d.visitsAvgPerMonth,
        customersTotal: d.customersTotal,
        doubleVisits: d.doubleVisits,
        visitsAvailable: datasets[id].visits.available,
      })),
  ).sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1));

  const slice = (s: number, t: number): Slice => ({
    sales: round2(s),
    target: round2(t),
    ach: t !== 0 ? round2((s / t) * 100) : null,
  });

  return {
    meta: {
      period: "S1 2026 (Jan–Jun)",
      currency: "EGP",
      months: [...S1_MONTHS],
      lines: S1_LINE_ORDER.map((l) => l.label),
      doctorNote: WORKBOOK_COMPANY.meta.doctorNote,
      generatedFrom: [
        "SoS Monthly Closing — au.f_monthly_achievement, 2026-01 to 2026-06 (live)",
        "data/company-s1.json — marketing, outstation, CRM visits and doctor counts only",
      ],
    },
    total: {
      allProducts: slice(sales, target),
      exVacant: slice(exSales, exTarget),
      marketingCost: wbTotal.marketingCost,
      outstationCost: wbTotal.outstationCost,
      visits: wbTotal.visits,
      doubleVisits: wbTotal.doubleVisits,
      reps,
      customersTotal: wbTotal.customersTotal,
      customersByMonth: wbTotal.customersByMonth,
      customersNaiveSum: wbTotal.customersNaiveSum,
      customersOverlap: wbTotal.customersOverlap,
      areas: areasTotal,
      areasVacant,
      byMonth: Object.fromEntries(S1_MONTHS.map((m) => [m, slice(byMonth[m].sales, byMonth[m].target)])),
    },
    lines,
    dms,
  };
}

export type S1CanonicalBundle = {
  datasets: Record<S1Line, S1Dataset>;
  company: S1Company;
  provenance: S1Provenance;
};

/**
 * Build the whole S1 review from the canonical engine.
 *
 * ONE range call for all six months and all three lines — never one call per period. Each
 * period is a full attribution pass and every round trip crosses to eu-central-1.
 */
export async function loadS1CanonicalBundle(): Promise<S1CanonicalBundle> {
  const [rawRows, areaNames, employeeNames, productNames, uploaded] = await Promise.all([
    loadAchievementRange(S1_FROM, S1_TO),
    loadAllCanonicalAreaNames(),
    loadEmployeeNameMap(),
    loadProductNameMap(),
    loadUploadedPeriodsInRange(S1_FROM, S1_TO),
  ]);

  // Fayoum/Beni Suef fold onto one area for Pedia and CNS, exactly as they do on Monthly
  // Closing. Applied before any aggregation, or the two surfaces show different area lists.
  const rows = applyAchievementAreaMerges(rawRows);

  const names: Names = {
    area: (lineCode, code) => getMergedAreaName(lineCode, code) ?? areaNames.get(code) ?? "Unassigned area",
    product: (code) => productNames.get(code) ?? code,
    employee: (hrId) => employeeNames.get(hrId) ?? "Unnamed employee",
  };

  const byLine = groupBy(rows, (r) => r.lineCode);
  const datasets = Object.fromEntries(
    S1_LINE_ORDER.map(({ id }) => [id, buildDataset(id, byLine.get(LINE_CODE[id]) ?? [], names)]),
  ) as Record<S1Line, S1Dataset>;

  // Rows the engine resolved to no line at all. Small (9,996 EGP across H1) but real, and
  // they belong to no per-line dataset — so they are counted here rather than dropped.
  const unlined = rows.filter((r) => !r.lineCode);

  const lineProvenance: S1LineProvenance[] = S1_LINE_ORDER.map(({ id, label }) => {
    const lineRows = byLine.get(LINE_CODE[id]) ?? [];
    const totals = totalRows(lineRows);
    return {
      line: id,
      label,
      coveredValue: round2(totals.coveredActualValue),
      uncoveredValue: round2(totals.uncoveredActualValue),
      periodsWithTarget: [...new Set(lineRows.filter((r) => r.hasTarget).map((r) => r.period))].sort(),
      seatsWithoutOverlay: datasets[id].dms
        .filter((d) => d.dmSeatId && !d.overlayAvailable)
        .map((d) => d.dm)
        .sort(),
    };
  });

  return {
    datasets,
    company: buildCompany(datasets),
    provenance: {
      engine: "SoS Monthly Closing (au.f_monthly_achievement)",
      from: S1_FROM,
      to: S1_TO,
      uploadedPeriods: [...uploaded].sort(),
      missingUploadPeriods: S1_PERIODS.filter((p) => !uploaded.has(p)),
      unlinedValue: round2(totalRows(unlined).actualValue),
      unlinedRows: unlined.length,
      lines: lineProvenance,
      overlaySource: "data/*-s1.json (workbook, marketing · outstation · CRM visits · doctors)",
      overlayGeneratedAt: ACCESS_MAP.generatedAt,
      restatementNotice: S1_RESTATEMENT_NOTICE,
    },
  };
}

/** Exported for the empty-state paths so a failed load never renders as "sold nothing". */
export function emptySlice(): Slice {
  return { ...EMPTY_SLICE };
}

/** Exported so a caller can total a scoped subset with the same coverage rule. */
export function totalAreas(areas: readonly AreaSummary[]): Slice {
  const total = emptyTotals();
  for (const area of areas) {
    total.actualValue += area.allProducts.sales;
    total.targetValue += area.allProducts.target;
    if (area.hasTarget) total.coveredActualValue += area.allProducts.sales;
  }
  total.achievementValue = total.targetValue !== 0 ? total.coveredActualValue / total.targetValue : null;
  return sliceOf(total);
}
