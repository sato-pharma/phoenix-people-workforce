// ─────────────────────────────────────────────────────────────────────────────
// Business Review — the LIVE build, for ANY window.
//
// This module builds the whole review — sales, targets, achievement, marketing spend, outstation
// spend, CRM visits, double visits and doctors reached — from production, for whatever from→to
// window the viewer picked. Nothing is read from a committed workbook any more; the five JSON
// snapshots that used to supply the non-sales half are gone as data sources, because a frozen
// Jan–Jun figure cannot answer a question about March, or about next January.
//
// WHY THIS IS A REVIEW, NOT A PAYOUT RECORD
//
// This was written as a RESTATEMENT warning: Semester 1 2026 payouts were settled against the
// legacy `sales_records` engine and are closed (owner decision, 2026-08-13: the Incentive tab moves
// forward to Semester 2 and does not restate Semester 1), so rebuilding Semester 1 from canonical
// landed some areas in a different band than the one they were actually paid in.
//
// That specific warning is now unreachable. REVIEW_FLOOR is "2026-07" (owner, 2026-08-23), so no
// Semester 1 month can be selected and the notice was describing months this module cannot render.
// What
// survives is the part that is still true for EVERY window: this is built from the canonical
// closing engine, and a band shown here is a review figure, not the record anyone was paid on.
// `REVIEW_SOURCE_NOTICE` is that label; do not render this dataset without it.
//
// WHERE EACH NUMBER COMES FROM — the map the review shows on its own Coverage tab
//
//   Sales, units, target, achievement   au.f_monthly_achievement, via loadAchievementRange. One
//                                       range call for the whole window and all three lines.
//   Area / district / line / region      the same rows: the engine resolves occupancy per month
//                                       through au.f_seat_occupant_asof.
//   Marketing spend                      marketing_requests, keyed on pay_date.
//   Outstation spend                     outstation_expenses, keyed on payout_year/payout_month.
//   Visits, double visits, doctors       crm_visits_unified, via the CRM read door: iReports360, and
//                                       a Phoenix CRM team's own visits from its start (2026-10-02).
//   Job roles                            employees.job_title, through resolveJobFunctionRole.
//
// THE ONE DESIGN DECISION EVERYTHING ELSE HANGS OFF: a person is placed on an area, a district
// and a line by the MONTH'S OWN sales attribution (sources/attribution.ts), never by today's seat
// tree. A visit, an expense and a sale by the same rep in the same month therefore land in the
// same place, and a rep who left in March still places correctly for January.
//
// TWO WORKBOOK ARTEFACTS ARE DELIBERATELY DROPPED
//
//   1. The Pedia "exception" (+280,000 EGP of Ivyronc, included at line level and excluded at
//      rep/DM level). It was a manual reconciliation patch. The canonical engine already carries
//      that order, at its real area, in its real month — re-adding it would double-count.
//   2. Per-line `include` sets naming products the line does not canonically sell. Canonical
//      attributes a SKU to the line that owns it, so Pedia's workbook rows for Dolabactin and the
//      Tebofortin family now sit on CNS where the catalogue puts them.
//
// NOTHING IS EVER SILENTLY DROPPED. Rows with no line, rows with no area, visits with no HR id,
// people no source can place — all are counted and reported through `provenance` and the coverage
// layer, never discarded to make a total look tidy.
// ─────────────────────────────────────────────────────────────────────────────

import { isDegraded, markDegraded } from "@/lib/cache/serve-uncached";
import { formatPharmacyFigure } from "@/lib/crm/visit-count-buckets";
import { applyAchievementAreaMerges, getMergedAreaName } from "@/lib/sales/closing-area-merges";
import {
  loadAllCanonicalAreaNames,
  loadProductNameMap,
  regionName,
  type AchievementRow,
} from "@/lib/sales/monthly-targets";
import { listMonthlyClosingPeriods } from "@/lib/sales/monthly-distributor-import";
import {
  emptyTotals,
  gradedPeriodsOf,
  loadAchievementRange,
  loadUploadedPeriodsInRange,
  totalRows,
  type VsTargetTotals,
} from "@/lib/sales/vs-target";

import {
  buildReviewCoverage,
  buildSourceCoverage,
  describePeriods,
  type ReviewCoverage,
  type SourceCoverage,
} from "./coverage";
import {
  REVIEW_FLOOR,
  periodColumnLabels,
  quartersInWindow,
  resolveReviewWindow,
  windowLabel,
  type ReviewWindow,
} from "./period";
import { buildAttributionMap, hrKey, type AttributionMap, type Placement } from "./sources/attribution";
import { isResignedStatus, leaverLabel } from "./employment-status";
import { MARKETING_ORIGIN, MARKETING_RULE, loadMarketingFacts, type MarketingLoad } from "./sources/marketing";
import { OUTSTATION_ORIGIN, OUTSTATION_RULE, loadOutstationFacts, type OutstationLoad } from "./sources/outstation";
import {
  buildOverlays,
  type HeldOutTotals,
  type ReviewOverlay,
  type ReviewOverlays,
  type UnplacedTotals,
} from "./sources/rollup";
/** The import sheets' own spelling of the three lines, for the closing's RPCs. */
import {
  ROLES_ORIGIN,
  buildRoleFacts,
  loadLineIdByCode,
  loadReviewDirectory,
  type ReviewDirectory,
  type RoleFacts,
  type RolesLoad,
} from "./sources/roles";
import {
  CUSTOMERS_ORIGIN,
  CUSTOMERS_RULE,
  VISITS_ORIGIN,
  VISITS_RULE,
  loadVisitFacts,
  type VisitsLoad,
} from "./sources/visits";
import type {
  AreaSummary,
  CompanyLineRow,
  DmSummary,
  LineSummary,
  ProductRow,
  RepVisit,
  ReviewCompany,
  ReviewDataset,
  Slice,
} from "./types";

export type ReviewLine = "pedia" | "cns" | "anti";

/** A line with no recorded activity at all still renders its tables, empty rather than absent. */
const EMPTY_ROLE_FACTS: RoleFacts = { roles: [], people: [], unknownPeople: 0 };

/**
 * The label every surface rendering this dataset must show. Not optional.
 *
 * It must stay true for ANY window the viewer picks. The previous wording did not: it warned that
 * Semester 1 2026 bands here differ from what was actually paid, which stopped being reachable the moment
 * REVIEW_FLOOR moved to July 2026 — it described months the picker no longer offers.
 */
export const REVIEW_SOURCE_NOTICE =
  "Review, not a payout record. Rebuilt live from SoS Monthly Closing — the same engine as " +
  "Sales vs Target — for the window you picked. Incentive payouts are settled separately, so a " +
  "band shown here is not a payment.";

/** The owner's fail thresholds. Unchanged from the workbook, and the same for all three lines. */
export const REVIEW_THRESHOLDS = { repFailBelow: 20, dsmFailBelow: 50 } as const;

/** Review line id → the line_code the canonical engine uses. */
const LINE_CODE: Record<ReviewLine, string> = { pedia: "pedia", cns: "cns", anti: "anti_infective" };
/**
 * Review line id → `source_of_sales_fact_rollup.official_line`, which is what the closing's own
 * RPCs match on. A THIRD spelling of the same three lines, and deliberately not folded into
 * `LINE_CODE`: that one is the canonical engine's key and this one is the import sheets'. Verified
 * against production 2026-09-26 — the distinct values are "CNS", "Pedia", "Anti Infective" and
 * "Head Office", the last of which the review does not cover.
 */
export const OFFICIAL_LINE: Record<ReviewLine, string> = { pedia: "Pedia", cns: "CNS", anti: "Anti Infective" };
/** The same three, as the canonical engine keys them. Exported for the concentration loader. */
export const REVIEW_LINE_CODES: Record<ReviewLine, string> = LINE_CODE;
const REVIEW_LINE_ORDER: { id: ReviewLine; label: string }[] = [
  { id: "pedia", label: "Pedia" },
  { id: "cns", label: "CNS" },
  { id: "anti", label: "Anti-Infective" },
];

/**
 * The owner's `includeProducts` ruling, resolved to product CODES.
 *
 * The ruling was written in workbook spelling and three of its entries do not match the live
 * catalogue name at all — "Sagenkgo" is catalogue SA001 "Saginko", "Royafloxacin 500mg tab" is
 * RO001 "Royafloxacin", "Tebofrtin drops" is TE001 "Tebofotin drops". Matching on name would have
 * quietly dropped those three from every include-only figure. Codes are stable; names are not.
 */
const INCLUDE_PRODUCT_CODES: Record<ReviewLine, ReadonlySet<string>> = {
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
 * Same reason as the include set: keyed on code, not name. The Anti-Infective ruling already
 * records that the source workbook's own Family column mislabelled Royafloxacin as "Dolabactin"
 * in January and February — deriving family from the row was never safe.
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

// ── Small numeric helpers ────────────────────────────────────────────────────

const round2 = (n: number) => Math.round(n * 100) / 100;
/** EGP for a sentence, not a table cell — whole pounds, grouped, the way the export writes it. */
const money = (n: number) => `EGP ${Math.round(n).toLocaleString("en-US")}`;

/**
 * A totals bucket rendered as the review's `Slice`.
 *
 * `ach` is a PERCENTAGE (90.02), not a fraction, because that is what the two client components
 * already render. It divides the COVERED actual by the target — sales sitting on a key that has
 * no target are reported beside the percentage, never inside it — and it is null, never 0, when
 * there is no target to divide by.
 */
function sliceOf(t: VsTargetTotals): Slice {
  return {
    sales: round2(t.actualValue),
    target: round2(t.targetValue),
    graded: round2(t.gradedActualValue),
    ach: t.achievementValue == null ? null : round2(t.achievementValue * 100),
  };
}

const EMPTY_SLICE: Slice = { sales: 0, target: 0, graded: 0, ach: null };

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

/** The value on the LATEST period that carries one — "as of the end of the window". */
/**
 * The manager's name as a REVIEW should print it: his own, and if he has left, the day he left.
 *
 * 🔴 `latest()` below skips a NULL, so a window whose later month has no occupant still resolves to
 * the earlier one — which is correct (somebody DID run those sales) and was also how a resigned
 * district manager came to be printed as the serving one. Measured on production: Pedia's Upper
 * Egypt carried `dm_hr_id = B-23` through July and NULL through August, because he resigned on
 * 31 August; the pack named him for the whole window with nothing saying he had gone.
 */
function dmDisplayName(ctx: BuildContext, dmHrId: string): string {
  const name = ctx.names.employee(dmHrId);
  const entry = ctx.directory.get(hrKey(dmHrId));
  return isResignedStatus(entry?.employmentStatus) ? leaverLabel(name, entry?.lastWorkingDate) : name;
}

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

function monthlySlices(
  rows: readonly AchievementRow[],
  periods: readonly string[],
  graded: ReadonlySet<string>,
): Record<string, Slice> {
  const out: Record<string, Slice> = {};
  const byPeriod = groupBy(rows, (r) => r.period);
  for (const period of periods) out[period] = sliceOf(totalRows(byPeriod.get(period) ?? [], graded));
  return out;
}

function monthlyAch(
  rows: readonly AchievementRow[],
  periods: readonly string[],
  graded: ReadonlySet<string>,
): Record<string, number | null> {
  const slices = monthlySlices(rows, periods, graded);
  const out: Record<string, number | null> = {};
  for (const period of periods) out[period] = slices[period].ach;
  return out;
}

function monthlySales(rows: readonly AchievementRow[], periods: readonly string[]): number[] {
  const byPeriod = groupBy(rows, (r) => r.period);
  return periods.map((period) => round2(totalRows(byPeriod.get(period) ?? []).actualValue));
}

// ── Provenance ───────────────────────────────────────────────────────────────

export type ReviewLineProvenance = {
  line: ReviewLine;
  label: string;
  /** Actual value sitting on a (line, area, product) key that has a target. */
  coveredValue: number;
  /** Actual value with no target anywhere — reported beside the %, never inside it. */
  uncoveredValue: number;
  /** Months in which this line has at least one canonical target. */
  periodsWithTarget: string[];
  /** Months inside the window with sales but no target at all — value only, not gradeable. */
  periodsWithoutTarget: string[];
};

export type ReviewProvenance = {
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
  lines: ReviewLineProvenance[];
  /** Facts, people and rows that reached no unit — counted here, never folded into a total. */
  unplaced: UnplacedTotals;
  /** Visit rows the duplicate collapse removed, and rows from resigned agents kept on purpose. */
  visitsCollapsed: number;
  visitsFromExcludedAgents: number;
  restatementNotice: string;
};

// ── The build ────────────────────────────────────────────────────────────────

type Names = {
  area: (lineCode: string, code: string) => string;
  product: (code: string) => string;
  employee: (hrId: string) => string;
};

/** Sentinels for canonical rows that resolved to a line but to no area, and to no district.
 * A pipe, matching the house composite-key convention elsewhere in the sales domain, and
 * deliberately NOT a NUL byte: git-grep and ripgrep treat a file containing one as binary
 * and skip it entirely, which makes the source invisible to every search in the repo. */
const NO_AREA_KEY = "|no-area";
const NO_AREA_NAME = "Unattributed — no area on the source row";
const NO_DM_KEY = "|no-dm";
const NO_DM_NAME = "No district manager";

/** The half of the build context that is identical for all three lines, built once. */
type SharedBuildContext = {
  window: ReviewWindow;
  names: Names;
  overlays: ReviewOverlays;
  directory: ReviewDirectory;
  /**
   * THE SPAN EVERY FIGURE ON THE PAGE ANSWERS — the requested window intersected with the months
   * whose distributor files have landed.
   *
   * It is what `meta.period` prints, and it is deliberately NOT `window.label`. The sales half has
   * always held a month with no upload out of every sales, target and achievement figure; the
   * non-sales half did not until 2026-09-26, so one heading covered two spans. Now both halves stop
   * at the same month, and the heading says which one that is rather than naming a range a third of
   * whose figures were never in it. The requested window is still carried, on the coverage block, so
   * the page can say what it did and why.
   */
  figureLabel: string;
};

/** Everything the per-line builders need beyond the sales rows themselves. */
type BuildContext = SharedBuildContext & {
  /**
   * THE MONTHS THIS LINE IS GRADED ON — one set, decided once, used at every grain beneath it.
   *
   * Owner ruling 2026-09-26: the Business Review follows the Monthly Closing's LINE-level rule.
   * The closing grades a line, so "was there a target in this month" is a question about the
   * LINE, not about whichever area, district or product subset happens to be on screen.
   *
   * Before this, every grain asked the question of itself (`totalRows`'s own default), and the
   * grains then disagreed: an area with no target in a month its line WAS targeted in dropped
   * that month's sales from its own numerator while the line kept them. Summing the areas
   * therefore fell short of the line, which is why the admin page read 74.35% for Jul–Aug 2026
   * and the portal page — which sums the viewer's own areas — read 70.12% for the same window,
   * 1,598,667 EGP apart. Two named district managers saw a grade up to 7.2 points below the one
   * in the DSM league table their review was run from.
   *
   * Set PER LINE in `loadReviewBundle`, so the three lines never borrow each other's months.
   */
  gradedPeriods: ReadonlySet<string>;
};

function buildAreas(line: ReviewLine, rows: AchievementRow[], ctx: BuildContext): AreaSummary[] {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  const lineCode = LINE_CODE[line];
  const periods = ctx.window.periods;
  const graded = ctx.gradedPeriods;

  return [...groupBy(rows, (r) => r.areaCode ?? NO_AREA_KEY)]
    .map(([areaKey, areaRows]) => {
      const isUnattributed = areaKey === NO_AREA_KEY;
      const includeRows = areaRows.filter((r) => includeCodes.has(r.productCode.toUpperCase()));
      const dmHrId = latest(areaRows, (r) => r.dmHrId);
      const region = regionName(latest(areaRows, (r) => r.regionCode)) || "Unassigned region";

      // Vacancy AS OF the end of the window — the single-status view a review is asking for. An
      // area whose latest period has no rep occupant reads vacant even if it was staffed earlier.
      // A seat whose only occupant has since RESIGNED reads vacant too (owner, 2026-09-28): a rep who
      // has left the company no longer holds the territory, so "Exclude vacant" clears it. His sales
      // stay in the area/line totals — vacancy is display state and never changes a figure.
      const lastPeriodWithRows = areaRows.reduce((max, r) => (r.period > max ? r.period : max), "");
      const lastOccupants = [
        ...new Set(
          areaRows
            .filter((r) => r.period === lastPeriodWithRows && r.repHrId)
            .map((r) => String(r.repHrId).trim()),
        ),
      ];
      const vacant = lastOccupants.every((id) => isResignedStatus(ctx.directory.get(hrKey(id))?.employmentStatus));

      const products: Record<string, Slice> = {};
      for (const [code, productRows] of groupBy(includeRows, (r) => r.productCode.toUpperCase())) {
        products[ctx.names.product(code)] = sliceOf(totalRows(productRows, graded));
      }

      const allProducts = sliceOf(totalRows(areaRows, graded));
      // One set, used for both the COUNT and the membership test. Upper-cased because HR ids reach
      // this code from three systems in mixed case and a raw comparison has hidden 28% of rows.
      const areaRepHrIds = [
        ...new Set(
          areaRows
            .map((r) => String(r.repHrId ?? "").trim().toUpperCase())
            .filter((id) => id.length > 0),
        ),
      ].sort();
      const byMonth = monthlySlices(areaRows, periods, graded);
      const overlay = isUnattributed ? ctx.overlays.area(null, null) : ctx.overlays.area(lineCode, areaKey);

      return {
        area: isUnattributed ? NO_AREA_NAME : ctx.names.area(lineCode, areaKey),
        areaCode: isUnattributed ? null : areaKey,
        dmSeatId: latest(areaRows, (r) => r.dmSeatId),
        dm: dmHrId ? dmDisplayName(ctx, dmHrId) : `${region} (vacant)`,
        region,
        vacant,
        includeOnly: sliceOf(totalRows(includeRows, graded)),
        allProducts,
        hasTarget: areaRows.some((r) => r.hasTarget),
        // "Ungradeable" is the review's word for an area no achievement can be computed for.
        // Canonical says the same thing by returning a null achievement.
        ungradeable: allProducts.ach == null,
        hasReturns: Object.values(byMonth).some((s) => s.sales < 0),
        products,
        trend: monthlySales(includeRows, periods),
        byMonth,
        reps: areaRepHrIds.length,
        repHrIds: areaRepHrIds,
        visits: overlay.visits,
        visitSplit: overlay.visitSplit,
        regularVisits: overlay.regularVisits,
        campaignVisits: overlay.campaignVisits,
        visitsByMonth: overlay.visitsByMonth,
        doubleVisits: overlay.doubleVisits,
        customersTotal: overlay.customersTotal,
        customersByMonth: overlay.customersByMonth,
        customersAm: overlay.customersAm,
        customersPm: overlay.customersPm,
        customersPharmacy: overlay.customersPharmacy,
        outstationClaimed: overlay.outstationClaimed,
        outstationApproved: overlay.outstationApproved,
        marketingCommitted: overlay.marketingCommitted,
        marketingRequests: overlay.marketingRequests,
      } satisfies AreaSummary;
    })
    .sort((a, b) => b.allProducts.sales - a.allProducts.sales);
}

function buildDms(line: ReviewLine, rows: AchievementRow[], areas: AreaSummary[], ctx: BuildContext): DmSummary[] {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  const areasBySeat = groupBy(areas, (a) => a.dmSeatId ?? NO_DM_KEY);
  const periods = ctx.window.periods;
  const graded = ctx.gradedPeriods;

  return [...groupBy(rows, (r) => r.dmSeatId ?? NO_DM_KEY)]
    .map(([seatKey, seatRows]) => {
      const isUnmanaged = seatKey === NO_DM_KEY;
      const seatAreas = areasBySeat.get(seatKey) ?? [];
      const activeAreaNames = new Set(seatAreas.filter((a) => !a.vacant).map((a) => a.area));
      const dmHrId = latest(seatRows, (r) => r.dmHrId);
      // A district manager who has since RESIGNED no longer holds the seat — it reads vacant, exactly
      // as an unoccupied one does (owner, 2026-09-28).
      const dmResigned = !!dmHrId && isResignedStatus(ctx.directory.get(hrKey(dmHrId))?.employmentStatus);
      const region = regionName(latest(seatRows, (r) => r.regionCode)) || "Unassigned region";

      const includeRows = seatRows.filter((r) => includeCodes.has(r.productCode.toUpperCase()));
      // "Active" excludes vacant areas, so a district is not judged on territory it had nobody in.
      const activeAreaCodes = new Set(seatAreas.filter((a) => !a.vacant).map((a) => a.areaCode));
      const activeRows = includeRows.filter((r) => activeAreaCodes.has(r.areaCode));

      const productAch: Record<string, number | null> = {};
      for (const [code, productRows] of groupBy(includeRows, (r) => r.productCode.toUpperCase())) {
        productAch[ctx.names.product(code)] = sliceOf(totalRows(productRows, graded)).ach;
      }
      const familyAch: Record<string, number | null> = {};
      for (const [family, familyRows] of groupBy(includeRows, (r) => PRODUCT_FAMILY[r.productCode.toUpperCase()] ?? null)) {
        familyAch[family] = sliceOf(totalRows(familyRows, graded)).ach;
      }

      const overlay = isUnmanaged ? ctx.overlays.dm(null) : ctx.overlays.dm(seatKey);
      const activeMonths = overlay.visitsMonths || periods.length;

      return {
        dm: isUnmanaged ? NO_DM_NAME : dmHrId ? dmDisplayName(ctx, dmHrId) : `${region} (vacant)`,
        dmSeatId: isUnmanaged ? null : seatKey,
        region,
        vacant: !isUnmanaged && (!dmHrId || dmResigned),
        areas: seatAreas.map((a) => a.area),
        activeAreas: [...activeAreaNames],
        includeOnly: sliceOf(totalRows(includeRows, graded)),
        activeIncludeOnly: sliceOf(totalRows(activeRows, graded)),
        allProducts: sliceOf(totalRows(seatRows, graded)),
        productAch,
        familyAch,
        trend: monthlySales(includeRows, periods),
        achByMonth: monthlyAch(includeRows, periods, graded),
        achByMonthActive: monthlyAch(activeRows, periods, graded),
        marketingCost: overlay.marketingCommitted,
        marketingPending: overlay.marketingPending,
        marketingRequests: overlay.marketingRequests,
        marketingMonths: overlay.marketingMonths,
        marketingByMonth: overlay.marketingByMonth,
        outstationCost: overlay.outstationClaimed,
        outstationApproved: overlay.outstationApproved,
        outstationRows: overlay.outstationRows,
        outstationMonths: overlay.outstationMonths,
        outstationByMonth: overlay.outstationByMonth,
        outstationApprovedByMonth: overlay.outstationApprovedByMonth,
        doubleVisits: overlay.doubleVisits,
        doubleVisitsLed: overlay.ridesLed,
        visits: overlay.visits,
        visitSplit: overlay.visitSplit,
        regularVisits: overlay.regularVisits,
        campaignVisits: overlay.campaignVisits,
        visitsAvgPerMonth: round2(overlay.visits / activeMonths),
        visitsByMonth: overlay.visitsByMonth,
        customersTotal: overlay.customersTotal,
        customersByMonth: overlay.customersByMonth,
        customersAm: overlay.customersAm,
        customersPm: overlay.customersPm,
        customersPharmacy: overlay.customersPharmacy,
        // A UNION over this district's reps, sealed by the overlay: a doctor two of them visited
        // is one doctor here. Summing their mixes would double him.
        specialityMix: overlay.specialityMix,
      } satisfies DmSummary;
    })
    .sort((a, b) => b.allProducts.sales - a.allProducts.sales);
}

function buildProducts(line: ReviewLine, rows: AchievementRow[], ctx: BuildContext): ProductRow[] {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  return [...groupBy(rows, (r) => r.productCode.toUpperCase())]
    .map(([code, productRows]) => ({
      product: ctx.names.product(code),
      family: PRODUCT_FAMILY[code] ?? ctx.names.product(code),
      include: includeCodes.has(code),
      byMonth: monthlySlices(productRows, ctx.window.periods, ctx.gradedPeriods),
      total: sliceOf(totalRows(productRows, ctx.gradedPeriods)),
    }))
    .sort((a, b) => b.total.sales - a.total.sales);
}

function buildLineSummary(
  rows: AchievementRow[],
  areas: AreaSummary[],
  includeRows: AchievementRow[],
  overlay: ReviewOverlay,
  ctx: BuildContext,
): LineSummary {
  const periods = ctx.window.periods;
  const graded = ctx.gradedPeriods;
  const vacantAreaCodes = new Set(areas.filter((a) => a.vacant).map((a) => a.areaCode));
  const exVacantRows = includeRows.filter((r) => !vacantAreaCodes.has(r.areaCode));

  const quarters: LineSummary["quarters"] = {};
  for (const quarter of quartersInWindow(periods)) {
    const set = new Set(quarter.periods);
    quarters[quarter.label] = {
      includeOnly: sliceOf(totalRows(includeRows.filter((r) => set.has(r.period)), graded)),
      allProducts: sliceOf(totalRows(rows.filter((r) => set.has(r.period)), graded)),
      complete: quarter.complete,
    };
  }

  const byMonth: LineSummary["byMonth"] = {};
  for (const period of periods) {
    byMonth[period] = {
      includeOnly: sliceOf(totalRows(includeRows.filter((r) => r.period === period), graded)),
      allProducts: sliceOf(totalRows(rows.filter((r) => r.period === period), graded)),
    };
  }

  const includeOnly = sliceOf(totalRows(includeRows, graded));
  const allProducts = sliceOf(totalRows(rows, graded));
  return {
    includeOnly,
    allProducts,
    // The workbook's manual +280,000 Ivyronc reconciliation has no meaning against an engine that
    // already carries that order at its real area and month.
    withException: { includeOnly, allProducts },
    exVacant: { includeOnly: sliceOf(totalRows(exVacantRows, graded)) },
    exceptionValue: 0,
    quarters,
    byMonth,
    marketingCost: overlay.marketingCommitted,
    marketingPending: overlay.marketingPending,
    outstationCost: overlay.outstationClaimed,
    outstationApproved: overlay.outstationApproved,
    visits: overlay.visits,
    visitSplit: overlay.visitSplit,
    regularVisits: overlay.regularVisits,
    campaignVisits: overlay.campaignVisits,
    doubleVisits: overlay.doubleVisits,
    visitsAvgPerRepPerMonth: overlay.visitsAvgPerRepPerMonth,
    reps: new Set(rows.map((r) => r.repHrId).filter(Boolean)).size,
    visitingReps: overlay.visitingReps,
    customersTotal: overlay.customersTotal,
    customersByMonth: overlay.customersByMonth,
    customersAm: overlay.customersAm,
    customersPm: overlay.customersPm,
    customersPharmacy: overlay.customersPharmacy,
  };
}

// ── Per-line CRM activity, split out of the visit facts by where each rep stood ──

type RepAcc = {
  hrId: string;
  name: string | null;
  visits: number;
  regularVisits: number;
  campaignVisits: number;
  customers: Set<number>;
  months: Set<string>;
  dmSeatId: string | null;
  areaCode: string | null;
  lastPeriod: string;
};

type LineActivity = {
  perRep: Map<string, RepAcc>;
  byDmSeat: Map<string, { visits: number; byMonth: Map<string, number> }>;
  ridesByManager: Map<string, number>;
  activityMix: Map<string, number>;
  repsWithDm: number;
};

function newLineActivity(): LineActivity {
  return {
    perRep: new Map(), byDmSeat: new Map(), ridesByManager: new Map(),
    activityMix: new Map(), repsWithDm: 0,
  };
}

/**
 * Split every visit fact onto the line the rep who made it stood on that month.
 *
 * Rides are split the same way, per rep, which is why `VisitManagerFact` carries `ridesByRep`
 * rather than a bare count: a Training Manager riding with a CNS rep and a Pedia rep in the same
 * month has to appear on both lines with the right split, and a total alone cannot do that
 * without guessing.
 */
function buildLineActivity(
  visits: VisitsLoad,
  attribution: AttributionMap,
  /** The one span every figure answers — see SharedBuildContext.figureLabel. A fact outside it is
   *  skipped here for the same reason it is skipped in buildOverlays: the per-rep table and the
   *  activity mix must not cover months the sales figures beside them cannot. */
  figurePeriods: ReadonlySet<string>,
): Map<string, LineActivity> {
  const byLine = new Map<string, LineActivity>();
  const of = (lineCode: string): LineActivity => {
    let activity = byLine.get(lineCode);
    if (!activity) {
      activity = newLineActivity();
      byLine.set(lineCode, activity);
    }
    return activity;
  };

  const placementOf = (hrId: string, period: string): Placement | null =>
    hrId ? attribution.place(hrId, period) : null;

  for (const fact of visits.agents) {
    if (!figurePeriods.has(fact.period)) continue;
    const placement = placementOf(fact.agentHrId, fact.period);
    if (!placement?.lineCode) continue;
    const activity = of(placement.lineCode);

    let rep = activity.perRep.get(fact.agentHrId);
    if (!rep) {
      rep = {
        hrId: fact.agentHrId, name: fact.agentName,
        visits: 0, regularVisits: 0, campaignVisits: 0,
        customers: new Set(), months: new Set(),
        dmSeatId: null, areaCode: null, lastPeriod: "",
      };
      activity.perRep.set(fact.agentHrId, rep);
    }
    if (!rep.name && fact.agentName) rep.name = fact.agentName;
    rep.visits += fact.fieldVisits;
    rep.regularVisits += fact.regularVisits;
    rep.campaignVisits += fact.campaignVisits;
    for (const id of fact.customers) rep.customers.add(id);
    if (fact.fieldVisits > 0) rep.months.add(fact.period);
    if (fact.period >= rep.lastPeriod) {
      rep.lastPeriod = fact.period;
      rep.dmSeatId = placement.dmSeatId;
      rep.areaCode = placement.areaCode;
    }

    if (placement.dmSeatId && fact.fieldVisits > 0) {
      let seat = activity.byDmSeat.get(placement.dmSeatId);
      if (!seat) {
        seat = { visits: 0, byMonth: new Map() };
        activity.byDmSeat.set(placement.dmSeatId, seat);
      }
      seat.visits += fact.fieldVisits;
      seat.byMonth.set(fact.period, (seat.byMonth.get(fact.period) ?? 0) + fact.fieldVisits);
    }

    for (const [label, count] of fact.byLabel) {
      activity.activityMix.set(label, (activity.activityMix.get(label) ?? 0) + count);
    }
  }

  for (const fact of visits.managers) {
    if (!figurePeriods.has(fact.period)) continue;
    for (const [repHrId, rides] of fact.ridesByRep) {
      const placement = placementOf(repHrId, fact.period);
      if (!placement?.lineCode) continue;
      const activity = of(placement.lineCode);
      activity.ridesByManager.set(
        fact.managerHrId,
        (activity.ridesByManager.get(fact.managerHrId) ?? 0) + rides,
      );
    }
  }

  for (const activity of byLine.values()) {
    activity.repsWithDm = [...activity.perRep.values()].filter((r) => r.dmSeatId).length;
  }
  return byLine;
}

function buildDataset(
  line: ReviewLine,
  rows: AchievementRow[],
  areas: AreaSummary[],
  dms: DmSummary[],
  activity: LineActivity,
  ctx: BuildContext,
  /** This line's own role and people tables — never the company's. */
  roleFacts: RoleFacts,
): ReviewDataset {
  const includeCodes = INCLUDE_PRODUCT_CODES[line];
  const includeRows = rows.filter((r) => includeCodes.has(r.productCode.toUpperCase()));
  const lineCode = LINE_CODE[line];
  const overlay = ctx.overlays.line(lineCode);
  const periods = ctx.window.periods;
  const label = REVIEW_LINE_ORDER.find((l) => l.id === line)!.label;

  const dmBySeat = new Map(dms.filter((d) => d.dmSeatId).map((d) => [d.dmSeatId as string, d]));
  const areaNameByCode = new Map(areas.filter((a) => a.areaCode).map((a) => [a.areaCode as string, a.area]));

  const fillMonths = (map: Map<string, number>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const period of periods) out[period] = map.get(period) ?? 0;
    return out;
  };

  const perRep: RepVisit[] = [...activity.perRep.values()]
    .map((rep) => {
      const entry = ctx.directory.get(rep.hrId);
      const activeMonths = rep.months.size;
      return {
        agentHrId: entry?.hrId ?? rep.hrId,
        name: entry?.name ?? rep.name ?? `Unmapped HR id ${rep.hrId}`,
        hiringDate: entry?.hireDate ?? null,
        visits: rep.visits,
        regularVisits: rep.regularVisits,
        campaignVisits: rep.campaignVisits,
        activeMonths,
        avgPerMonth: activeMonths > 0 ? round2(rep.visits / activeMonths) : 0,
        customers: rep.customers.size,
        dm: rep.dmSeatId ? dmBySeat.get(rep.dmSeatId)?.dm ?? null : null,
        area: rep.areaCode ? areaNameByCode.get(rep.areaCode) ?? null : null,
      } satisfies RepVisit;
    })
    .sort((a, b) => b.visits - a.visits);

  const visitsByDm: ReviewDataset["visits"]["byDM"] = {};
  for (const [seatId, seat] of activity.byDmSeat) {
    const name = dmBySeat.get(seatId)?.dm;
    if (!name) continue;
    const months = [...seat.byMonth.values()].filter((v) => v > 0).length || 1;
    visitsByDm[name] = {
      visits: seat.visits,
      avgPerMonth: round2(seat.visits / months),
      byMonth: fillMonths(seat.byMonth),
    };
  }

  const marketingByDm: ReviewDataset["marketing"]["byDM"] = {};
  const outstationByDm: ReviewDataset["outstation"]["byDM"] = {};
  for (const dm of dms) {
    if (dm.marketingRequests > 0 || dm.marketingCost !== 0) {
      marketingByDm[dm.dm] = {
        cost: dm.marketingCost,
        requests: dm.marketingRequests,
        months: dm.marketingMonths,
        byMonth: dm.marketingByMonth,
      };
    }
    if (dm.outstationCost !== 0 || dm.outstationApproved !== 0) {
      outstationByDm[dm.dm] = {
        cost: dm.outstationCost,
        approved: dm.outstationApproved,
        rows: dm.outstationRows,
        months: dm.outstationMonths,
        byMonth: dm.outstationByMonth,
      };
    }
  }

  const byManager: Record<string, number> = {};
  for (const [managerHrId, rides] of activity.ridesByManager) {
    byManager[ctx.directory.get(managerHrId)?.name ?? `Unmapped HR id ${managerHrId}`] = rides;
  }

  const visitingReps = activity.perRep.size;

  return {
    // Overwritten by the loader when the customer-grain read was asked for. Null is the honest
    // default: this builder has no access to that source and must not imply an empty one.
    concentration: null,
    roles: roleFacts.roles,
    people: roleFacts.people,
    meta: {
      line: label,
      period: ctx.figureLabel,
      currency: "EGP",
      months: [...periods],
      monthLabels: periodColumnLabels(periods),
      generatedFrom: generatedFromLines(ctx.window),
      thresholds: { ...REVIEW_THRESHOLDS },
      rulings: {
        includeProducts: [...includeCodes].map((code) => ctx.names.product(code)).sort(),
        marketing: MARKETING_RULE,
        outstation: OUTSTATION_RULE,
        visits: VISITS_RULE,
        customers: CUSTOMERS_RULE,
        attribution:
          "Every non-sales figure is placed on the area, district and line the person held IN THAT " +
          "MONTH, taken from the same attribution the sales rows carry — never from today's seat tree.",
      },
    },
    line: buildLineSummary(rows, areas, includeRows, overlay, ctx),
    products: buildProducts(line, rows, ctx),
    dms,
    areas,
    marketing: {
      committed: overlay.marketingCommitted,
      pending: overlay.marketingPending,
      requests: overlay.marketingRequests,
      byDM: marketingByDm,
      monthsCovered: periods.filter((p) => (overlay.marketingByMonth[p] ?? 0) !== 0),
      note: MARKETING_RULE,
    },
    outstation: {
      claimed: overlay.outstationClaimed,
      approved: overlay.outstationApproved,
      rows: overlay.outstationRows,
      byDM: outstationByDm,
      monthsCovered: periods.filter((p) => (overlay.outstationByMonth[p] ?? 0) !== 0),
      components: overlay.outstationComponents,
      status: OUTSTATION_RULE,
    },
    visits: {
      available: overlay.visits > 0 || overlay.adminRows > 0,
      totalDeduped: overlay.visits,
      visitSplit: overlay.visitSplit,
      reps: visitingReps,
      avgPerRepPerMonth: overlay.visitsAvgPerRepPerMonth,
      byMonth: overlay.visitsByMonth,
      customersTotal: overlay.customersTotal,
      customersByMonth: overlay.customersByMonth,
      customersAm: overlay.customersAm,
      customersPm: overlay.customersPm,
      customersPharmacy: overlay.customersPharmacy,
      byDM: visitsByDm,
      repToDmCoverage: visitingReps > 0 ? round2(activity.repsWithDm / visitingReps) : 0,
      perRep,
      activityMix: [...activity.activityMix]
        .map(([label_, rows_]) => ({ label: label_, rows: rows_ }))
        .sort((a, b) => b.rows - a.rows),
    },
    doubleVisits: {
      total: [...activity.ridesByManager.values()].reduce((sum, n) => sum + n, 0),
      byManager,
    },
  };
}

function generatedFromLines(window: ReviewWindow): string[] {
  return [
    `SoS Monthly Closing — au.f_monthly_achievement, ${window.from} to ${window.to} (live)`,
    `${MARKETING_ORIGIN} (live)`,
    `${OUTSTATION_ORIGIN} (live)`,
    `${VISITS_ORIGIN} (live)`,
    `${CUSTOMERS_ORIGIN} (live)`,
    `${ROLES_ORIGIN} (live)`,
  ];
}

function buildCompany(
  // The shared half only: the company rollup re-adds the per-line slices, which already carry
  // their line's graded months, so it never grades anything itself.
  datasets: Record<ReviewLine, ReviewDataset>,
  ctx: SharedBuildContext,
  roles: RolesLoad,
): ReviewCompany {
  const periods = ctx.window.periods;
  const company = ctx.overlays.company;
  let sales = 0, target = 0, graded = 0, exSales = 0, exTarget = 0, exGraded = 0;
  let reps = 0, areasTotal = 0, areasVacant = 0;
  const byMonth: Record<string, { sales: number; target: number; graded: number }> = {};
  for (const period of periods) byMonth[period] = { sales: 0, target: 0, graded: 0 };

  const lines: CompanyLineRow[] = REVIEW_LINE_ORDER.map(({ id, label }) => {
    const ds = datasets[id];
    const ap = ds.line.allProducts;
    const ev = ds.line.exVacant.includeOnly;
    sales += ap.sales; target += ap.target; graded += ap.graded;
    exSales += ev.sales; exTarget += ev.target; exGraded += ev.graded;
    reps += ds.line.reps;
    for (const period of periods) {
      byMonth[period].sales += ds.line.byMonth[period]?.allProducts.sales ?? 0;
      byMonth[period].target += ds.line.byMonth[period]?.allProducts.target ?? 0;
      byMonth[period].graded += ds.line.byMonth[period]?.allProducts.graded ?? 0;
    }
    const vacant = ds.areas.filter((a) => a.vacant).length;
    areasTotal += ds.areas.length;
    areasVacant += vacant;

    // Only graded areas score, and only target-bearing seats count as districts.
    const gradedAreas = ds.areas.filter((a) => a.hasTarget && a.allProducts.ach != null);
    const seats = ds.dms.filter((d) => d.allProducts.target > 0);
    return {
      id,
      label,
      allProducts: ap,
      exVacant: ev,
      marketingCost: ds.line.marketingCost,
      outstationCost: ds.line.outstationCost,
      outstationApproved: ds.line.outstationApproved,
      visits: ds.line.visits,
      visitSplit: ds.line.visitSplit,
      visitsAvailable: ds.visits.available,
      doubleVisits: ds.line.doubleVisits,
      customersTotal: ds.line.customersTotal,
      customersAm: ds.line.customersAm,
      customersPm: ds.line.customersPm,
      customersPharmacy: ds.line.customersPharmacy,
      dms: seats.filter((d) => !d.vacant).length,
      dmsVacant: seats.filter((d) => d.vacant).length,
      areas: ds.areas.length,
      areasVacant: vacant,
      earners: gradedAreas.filter((a) => !a.vacant && (a.allProducts.ach ?? 0) >= 90).length,
      repFails: gradedAreas.filter((a) => !a.vacant && (a.allProducts.ach ?? 0) < REVIEW_THRESHOLDS.repFailBelow).length,
    };
  }).sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1));

  const dms = REVIEW_LINE_ORDER.flatMap(({ id, label }) =>
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
        customersAm: d.customersAm,
        customersPm: d.customersPm,
        customersPharmacy: d.customersPharmacy,
        // What judges the customers' pharmacy figure — see CompanyDmRow.visitSplit.
        visitSplit: d.visitSplit,
        doubleVisits: d.doubleVisits,
        visitsAvailable: datasets[id].visits.available,
      })),
  ).sort((a, b) => (b.allProducts.ach ?? -1) - (a.allProducts.ach ?? -1));

  // sum(graded) / sum(target) — the same division `sliceOf` performs one level down, so the
  // company headline agrees with every line, area, district and rep beneath it.
  //
  // This divided sum(SALES) by sum(target) until 2026-08-23, and that is not a rounding
  // difference. Measured on production over the default Jan–Aug 2026 window: 76,155,653 EGP of
  // actual over 58,255,860 EGP of target read 130.73%, where the honest grade is 50.67%. Mar–Jun
  // 2026 carry roughly 43.5M EGP of sales and no target row at all, so all of it landed in the
  // numerator against a denominator it was never part of. The first number on a page built to be
  // read in front of a head of department was inflated by eighty points, in the flattering
  // direction, while every figure under it was already correct.
  const slice = (c: number, s: number, t: number): Slice => ({
    sales: round2(s),
    target: round2(t),
    graded: round2(c),
    ach: t !== 0 ? round2((c / t) * 100) : null,
  });

  // The company customer count is a UNION across lines. The sum of the lines is above it by exactly
  // the number of customers more than one line covers — a cross-line "treasure", the owner's word,
  // and the interesting half of the sentence.
  //
  // "Customers", not "doctors". The three buckets are named apart because the union holds all of
  // them and a pharmacy is never a doctor (owner golden rule, 2026-09-21): on production's July
  // 2026, 1,030 of the 7,364 were pharmacies — one in seven, under a label that said doctors.
  const naiveSum = REVIEW_LINE_ORDER.reduce((sum, { id }) => sum + datasets[id].line.customersTotal, 0);
  const overlap = Math.max(0, naiveSum - company.customersTotal);
  const doctorNote =
    company.customersTotal === 0
      ? "No regular CRM visit in this window named a customer, so no customer count can be given for it."
      : `${company.customersTotal.toLocaleString("en-US")} unique customers company-wide — ` +
        `${company.customersAm.toLocaleString("en-US")} AM accounts · ` +
        `${company.customersPm.toLocaleString("en-US")} PM doctors · ` +
        // Phoenix CRM logs no pharmacy visit, so beside a started team's visits the count is
        // iReports360's alone — said in words, never a bare figure (src/lib/crm/visit-count-buckets.ts).
        `${formatPharmacyFigure(
          { am: company.customersAm, pm: company.customersPm, pharmacies: company.customersPharmacy },
          { formatNumber: (value) => value.toLocaleString("en-US"), fromVisits: company.visitSplit, label: "pharmacies", numberFirst: true },
        )}. Summing the ` +
        `lines' own counts gives ${naiveSum.toLocaleString("en-US")}; ${overlap.toLocaleString("en-US")} ` +
        `of those are the same customer covered by more than one line, so they are counted once here.`;

  return {
    meta: {
      period: ctx.figureLabel,
      currency: "EGP",
      months: [...periods],
      monthLabels: periodColumnLabels(periods),
      lines: REVIEW_LINE_ORDER.map((l) => l.label),
      doctorNote,
      generatedFrom: generatedFromLines(ctx.window),
      thresholds: { ...REVIEW_THRESHOLDS },
    },
    total: {
      allProducts: slice(graded, sales, target),
      exVacant: slice(exGraded, exSales, exTarget),
      marketingCost: company.marketingCommitted,
      marketingPending: company.marketingPending,
      outstationCost: company.outstationClaimed,
      outstationApproved: company.outstationApproved,
      visits: company.visits,
      visitSplit: company.visitSplit,
      doubleVisits: company.doubleVisits,
      reps,
      // The company overlay's own union, NOT the sum of the lines' figures: a rep who visits on two
      // lines is one person, and the tile beside the visit count has to be the number those visits
      // were actually made by. It printed `reps` — reps with SALES — until 2026-09-26: 85 against
      // 122 who really visited, so visits-per-rep read 44% high.
      visitingReps: company.visitingReps,
      customersTotal: company.customersTotal,
      customersByMonth: company.customersByMonth,
      customersAm: company.customersAm,
      customersPm: company.customersPm,
      customersPharmacy: company.customersPharmacy,
      customersNaiveSum: naiveSum,
      customersOverlap: overlap,
      areas: areasTotal,
      areasVacant,
      byMonth: Object.fromEntries(
        periods.map((p) => [p, slice(byMonth[p].graded, byMonth[p].sales, byMonth[p].target)]),
      ),
    },
    lines,
    dms,
    roles: roles.roles,
    people: roles.people,
  };
}

/**
 * 🔴 THE CUSTOMER-GRAIN LOAD IS DELIBERATELY NOT AN OPTION HERE, AND MUST NOT BECOME ONE.
 *
 * This bundle is wrapped in `unstable_cache`, keyed on the window, the adjustment and the
 * achievement stamp — and on NOTHING ABOUT THE VIEWER, because every figure in it is the same for
 * everyone who may open the page. The closing's customer-grain rows are not: El Qema's are removed
 * for everyone but the Super Admin. Putting them inside this bundle would let one Super Admin
 * request populate a cache entry that a district manager is then served, leaking the source through
 * a concentration share.
 *
 * It would also be the wrong SIZE. A line's customer list runs to thousands of rows per month, and
 * a >2MB `unstable_cache` entry throws in development, uncatchably, only there.
 *
 * So the rows are loaded per request instead, beside the cached bundle, by
 * `loadReviewConcentration` in service.ts. That function takes the viewer, and the page attaches
 * the result to whatever scope it is rendering.
 */

export type ReviewBundle = {
  window: ReviewWindow;
  coverage: ReviewCoverage;
  datasets: Record<ReviewLine, ReviewDataset>;
  company: ReviewCompany;
  provenance: ReviewProvenance;
};

/**
 * The months the review can be asked about — validated distributor uploads at or after the
 * engine's own history floor, ascending.
 *
 * Discovered, never hardcoded, so the picker cannot offer a month the data does not hold and a
 * new closing appears in the filter the moment it validates.
 */
export async function availableReviewPeriods(): Promise<string[]> {
  try {
    const periods = await listMonthlyClosingPeriods();
    return [...new Set(periods.filter((p) => p >= REVIEW_FLOOR))].sort();
  } catch {
    return [];
  }
}

/**
 * Build the whole review for one window.
 *
 * ONE range call for every month and all three lines — never one call per period. Each period is
 * a full attribution pass and every round trip crosses to eu-central-1.
 */
export async function loadReviewBundle(window: ReviewWindow, adjustment: string | null = null): Promise<ReviewBundle> {
  const [rawRows, areaNames, productNames, uploaded, marketing, outstation, visits, directory, lineIdByCode] =
    await Promise.all([
      loadAchievementRange(window.from, window.to),
      loadAllCanonicalAreaNames(),
      loadProductNameMap(),
      loadUploadedPeriodsInRange(window.from, window.to),
      loadMarketingFacts(window),
      loadOutstationFacts(window),
      loadVisitFacts(window),
      // The employee directory and the line-id lookup used to be loaded inside loadRoleFacts, which
      // therefore had to RACE buildAttributionMap and so could not place anybody on a line. With
      // coaching removed (owner ruling, 2026-09-26) the role builder has no I/O left, so both reads
      // join the one Promise.all here and the builder runs after the attribution map instead.
      loadReviewDirectory(),
      loadLineIdByCode(),
    ]);

  // Fayoum/Beni Suef fold onto one area for Pedia and CNS, exactly as they do on Monthly Closing.
  // Applied before any aggregation, or the two surfaces show different area lists.
  const rows = applyAchievementAreaMerges(rawRows);

  // Everyone the non-sales sources mention, so the live-tree fallback stays a named, countable set.
  const interested = new Set<string>();
  for (const fact of marketing.facts) if (fact.requesterHrId) interested.add(fact.requesterHrId);
  for (const fact of outstation.facts) if (fact.hrId) interested.add(fact.hrId);
  for (const fact of visits.agents) if (fact.agentHrId) interested.add(fact.agentHrId);
  for (const fact of visits.managers) interested.add(fact.managerHrId);

  const attribution = await buildAttributionMap(rows, interested);

  // ONE span for every figure on the page (owner ruling 2026-09-26): the requested window
  // intersected with the months whose distributor files have landed. The sales half has always
  // stopped here; now the spend and activity halves do too, and anything outside it is reported by
  // the coverage layer instead of being folded into a total that reads as if it belonged.
  const figurePeriodList = window.periods.filter((p) => uploaded.has(p));
  const figurePeriods = new Set(figurePeriodList);
  const figureLabel =
    figurePeriodList.length > 0
      ? windowLabel(figurePeriodList[0], figurePeriodList[figurePeriodList.length - 1])
      : window.label;

  const overlays = buildOverlays({
    window, rows, attribution, marketing, outstation, visits, figurePeriods,
  });
  const activityByLine = buildLineActivity(visits, attribution, figurePeriods);

  const names: Names = {
    area: (lineCode, code) => getMergedAreaName(lineCode, code) ?? areaNames.get(code) ?? "Unassigned area",
    product: (code) => productNames.get(code) ?? code,
    employee: (hrId) => directory.get(hrKey(hrId))?.name ?? "Unnamed employee",
  };

  // Role and people tables, company-wide and per line. Synchronous, and AFTER the attribution map,
  // so a line's tables hold that line's own people — until 2026-09-26 the company-wide rows were
  // rendered under a line heading with no caption at all.
  const roles = buildRoleFacts({
    window, visits, outstation, marketing, directory, lineIdByCode, attribution, figurePeriods,
  });

  const shared: SharedBuildContext = { window, names, overlays, directory, figureLabel };

  // The FULL row set still feeds buildAttributionMap above: a rep who appears only in a not-yet-
  // uploaded month still needs a seat, or that month's visits lose their area. It is the sales
  // maths that is held back, never the identity — which is why this filter sits here and not at
  // the top of the function.
  const gradedRows = gradedRowsOf(rows, uploaded);

  const byLine = groupBy(gradedRows, (r) => r.lineCode);
  const datasets = {} as Record<ReviewLine, ReviewDataset>;
  for (const { id } of REVIEW_LINE_ORDER) {
    const lineRows = byLine.get(LINE_CODE[id]) ?? [];
    // The graded months, decided ONCE for the whole line and handed to every grain beneath it —
    // the owner's 2026-09-26 ruling, and the only arrangement in which the areas sum to their
    // district, the districts sum to their line and the portal agrees with the admin page. See
    // BuildContext.gradedPeriods. Computed on the line's own rows, so the three lines never
    // borrow each other's months.
    const ctx: BuildContext = { ...shared, gradedPeriods: gradedPeriodsOf(lineRows) };
    const areas = buildAreas(id, lineRows, ctx);
    const dms = buildDms(id, lineRows, areas, ctx);
    const activity = activityByLine.get(LINE_CODE[id]) ?? newLineActivity();
    datasets[id] = buildDataset(id, lineRows, areas, dms, activity, ctx, roles.byLine[LINE_CODE[id]] ?? EMPTY_ROLE_FACTS);
  }

  // Rows the engine resolved to no line at all. Small but real, and they belong to no per-line
  // dataset — so they are counted here rather than dropped.
  const unlined = gradedRows.filter((r) => !r.lineCode);

  const lineProvenance: ReviewLineProvenance[] = REVIEW_LINE_ORDER.map(({ id, label }) => {
    const lineRows = byLine.get(LINE_CODE[id]) ?? [];
    const totals = totalRows(lineRows);
    const withTarget = [...new Set(lineRows.filter((r) => r.hasTarget).map((r) => r.period))].sort();
    const withRows = new Set(lineRows.map((r) => r.period));
    return {
      line: id,
      label,
      coveredValue: round2(totals.coveredActualValue),
      uncoveredValue: round2(totals.uncoveredActualValue),
      periodsWithTarget: withTarget,
      periodsWithoutTarget: window.periods.filter((p) => withRows.has(p) && !withTarget.includes(p)),
    };
  });

  // `rows`, not `gradedRows` — coverage has to report the value it held back, not inherit the
  // hole it created. Same reason `overlays.heldOut` is handed over: the spend and visits the figure
  // window excluded are named there, in words, rather than vanishing.
  const coverage = buildCoverage({
    window, rows, uploaded, marketing, outstation, visits, adjustment,
    unplaced: overlays.unplaced,
    heldOut: overlays.heldOut,
    figureWindow:
      figurePeriodList.length > 0 && figurePeriodList.length < window.periods.length
        ? { label: figureLabel, periods: figurePeriodList }
        : null,
  });

  const bundle: ReviewBundle = {
    window,
    coverage,
    datasets,
    company: buildCompany(datasets, shared, roles),
    provenance: {
      engine: "SoS Monthly Closing (au.f_monthly_achievement)",
      from: window.from,
      to: window.to,
      uploadedPeriods: [...uploaded].sort(),
      missingUploadPeriods: window.periods.filter((p) => !uploaded.has(p)),
      unlinedValue: round2(totalRows(unlined).actualValue),
      unlinedRows: unlined.length,
      lines: lineProvenance,
      unplaced: overlays.unplaced,
      visitsCollapsed: visits.collapsedRows,
      visitsFromExcludedAgents: visits.excludedAgentRows,
      restatementNotice: REVIEW_SOURCE_NOTICE,
    },
  };
  // A source that failed to read answered "no data" above, which the coverage layer states in words.
  // That is right for this render; the mark tells the five-minute cache in service.ts not to keep it.
  const sourceFailed = [marketing, outstation, visits, directory, lineIdByCode].some(isDegraded);
  return sourceFailed ? markDegraded(bundle) : bundle;
}

/**
 * The rows a window may be GRADED on: the ones whose month has a real distributor upload.
 *
 * `uploaded` already excludes the DIRECT / DirectReq pseudo-distributors, so a month carrying
 * nothing but approved Direct orders drops out here. That is the whole fix. Measured on production
 * for the default Jan-Aug 2026 window:
 *
 *   including August   29,774,892.80 / 75,764,795.31 = 39.30%
 *   excluding August   29,516,034.13 / 58,255,859.82 = 50.67%
 *
 * August contributes 258,858.67 EGP of covered actual and 17,508,935.49 of target, because its
 * targets are fully loaded and its distributor files have not arrived. Eleven points of a review
 * that somebody is sitting in.
 *
 * Kept separate from loadReviewBundle so the arithmetic above is testable without a database.
 */
export function gradedRowsOf(
  rows: readonly AchievementRow[],
  uploaded: ReadonlySet<string>,
): AchievementRow[] {
  return rows.filter((r) => uploaded.has(r.period));
}

// ── Coverage ─────────────────────────────────────────────────────────────────

/**
 * What this window actually holds, per source.
 *
 * The whole point of the module: a period with no data must SAY so. Sales can be complete while
 * marketing is empty and outstation is partial, and the review states exactly that, month by
 * month, rather than collapsing to one page-level flag that hides which half is missing.
 */
export function buildCoverage(input: {
  window: ReviewWindow;
  rows: readonly AchievementRow[];
  /** Months whose real distributor files have landed. Excludes the DIRECT / DirectReq
   *  pseudo-distributors — see loadUploadedPeriodsInRange. A window month missing from this set is
   *  still being collected, however many rows the engine returns for it. */
  uploaded: ReadonlySet<string>;
  marketing: MarketingLoad;
  outstation: OutstationLoad;
  visits: VisitsLoad;
  unplaced: UnplacedTotals;
  /** Spend and activity the figure window excluded — reported, never totalled. */
  heldOut?: HeldOutTotals;
  figureWindow?: ReviewCoverage["figureWindow"];
  adjustment: string | null;
}): ReviewCoverage {
  const { window, rows, uploaded } = input;

  // A month with rows but no distributor upload is not a month with sales — it is a month holding
  // whatever Direct orders happened to be approved so far, against its full target. See
  // ReviewCoverage.notUploaded: on the default Jan-Aug window this is the difference between a
  // 50.7% review and a 39.3% one.
  const notUploadedPeriods = window.periods.filter((p) => !uploaded.has(p));
  const heldOut = rows.filter((r) => !uploaded.has(r.period));
  const heldOutValue = round2(heldOut.reduce((sum, r) => sum + r.actualValue, 0));

  // The other half of the same sentence (owner ruling 2026-09-26). Those months no longer contribute
  // spend or visits either, so the note has to say what they DID hold — otherwise the exclusion is
  // the silent kind this whole layer exists to prevent.
  const alsoHeldOut = input.heldOut ?? null;
  const alsoHeldOutNote =
    alsoHeldOut &&
    (alsoHeldOut.marketingCommitted !== 0 ||
      alsoHeldOut.outstationClaimed !== 0 ||
      alsoHeldOut.visitRows > 0)
      ? ` Their spend and field activity are held out with them, and are real: ` +
        `${money(alsoHeldOut.marketingCommitted)} of committed marketing across ` +
        `${alsoHeldOut.marketingRequests.toLocaleString("en-US")} request${alsoHeldOut.marketingRequests === 1 ? "" : "s"}, ` +
        `${money(alsoHeldOut.outstationClaimed)} of claimed outstation across ` +
        `${alsoHeldOut.outstationRows.toLocaleString("en-US")} claim${alsoHeldOut.outstationRows === 1 ? "" : "s"}, and ` +
        `${alsoHeldOut.visitRows.toLocaleString("en-US")} CRM row${alsoHeldOut.visitRows === 1 ? "" : "s"} from ` +
        `${alsoHeldOut.visitAgents.toLocaleString("en-US")} ${alsoHeldOut.visitAgents === 1 ? "person" : "people"}. ` +
        `Every figure below covers the same months as the sales, so cost and activity can be read ` +
        `against them.`
      : "";

  const notUploadedNote =
    `The distributor files for ${describePeriods(notUploadedPeriods)} have not arrived yet. ` +
    `Those months hold only Direct orders — ${money(heldOutValue)} across ` +
    `${heldOut.length.toLocaleString("en-US")} row${heldOut.length === 1 ? "" : "s"} — which are approved one at a time all month, ` +
    `so they are held out of every sales, target and achievement figure below and reported here ` +
    `instead. Grading a month against its whole target before its sales have landed shows a ` +
    `collapse that has not happened.` +
    alsoHeldOutNote;

  // Sales coverage follows the upload ledger, not the row count. Targets do NOT: August's targets
  // really are loaded, and saying "targets are missing" would send someone to load them again.
  const salesPeriods = [...new Set(rows.map((r) => r.period))].filter((p) => uploaded.has(p)).sort();
  const targetPeriods = [...new Set(rows.filter((r) => r.hasTarget).map((r) => r.period))].sort();

  const sources: SourceCoverage[] = [
    buildSourceCoverage({
      source: "sales",
      label: "Sales",
      origin: "au.f_monthly_achievement (SoS Monthly Closing), via loadAchievementRange",
      rule: "Every attributed row the engine returns for the window, at (period, line, area, product) grain.",
      window,
      periodsWithData: salesPeriods,
      rows: rows.length - heldOut.length,
      partialNote: notUploadedPeriods.length > 0 ? notUploadedNote : undefined,
    }),
    buildSourceCoverage({
      source: "targets",
      label: "Targets",
      origin: "au.monthly_targets, resolved inside the same engine call",
      rule: "Achievement is all sales ÷ target, the Monthly Closing's own rule — inside a month every pound counts, and only months carrying no target at all are left out.",
      window,
      periodsWithData: targetPeriods,
      rows: rows.filter((r) => r.hasTarget).length,
      emptyNote:
        `No targets are loaded for ${window.label}. Sales figures below are real and complete; ` +
        `achievement cannot be computed for any month in this window, and is shown as "not gradeable" ` +
        `rather than as 0%.`,
    }),
    buildSourceCoverage({
      source: "marketing",
      label: "Marketing requests",
      origin: MARKETING_ORIGIN,
      rule: MARKETING_RULE,
      window,
      periodsWithData: input.marketing.periodsWithData,
      rows: input.marketing.totalRows,
      unattributedRows: input.unplaced.marketingRequests,
      unattributedNote:
        input.unplaced.marketingRequests > 0
          ? `${input.unplaced.marketingRequests} request(s) could not be placed on a district — their requester holds no sales attribution in this window. They are in the company total and in no district's.`
          : null,
    }),
    buildSourceCoverage({
      source: "outstation",
      label: "Outstation expenses",
      origin: OUTSTATION_ORIGIN,
      rule: OUTSTATION_RULE,
      window,
      periodsWithData: input.outstation.periodsWithData,
      rows: input.outstation.totalRows,
      unattributedRows: input.unplaced.outstationRows,
      unattributedNote:
        input.unplaced.outstationRows > 0
          ? `${input.unplaced.outstationRows} claim(s) could not be placed on a district. They are in the company total and in no district's.`
          : null,
    }),
    buildSourceCoverage({
      source: "visits",
      label: "CRM visits",
      origin: VISITS_ORIGIN,
      rule: VISITS_RULE,
      window,
      periodsWithData: input.visits.periodsWithData,
      rows: input.visits.totalRows,
      unattributedRows: input.visits.unattributableRows,
      unattributedNote:
        input.visits.unattributableRows > 0
          ? `${input.visits.unattributableRows} visit row(s) carry no HR id at all, so they reach no rep, area or district. They are counted here and in no territory total.`
          : null,
    }),
    buildSourceCoverage({
      source: "customers",
      // "Customers", not "Doctors": the count unions AM accounts, PM doctors and pharmacies, and a
      // pharmacy is never a doctor (owner golden rule). The three are reported apart everywhere.
      label: "Customers reached",
      origin: CUSTOMERS_ORIGIN,
      rule: CUSTOMERS_RULE,
      window,
      periodsWithData: input.visits.periodsWithData,
      rows: input.visits.totalRows,
    }),
  ];

  return buildReviewCoverage({
    window,
    sources,
    adjustment: input.adjustment,
    figureWindow: input.figureWindow ?? null,
    notUploaded:
      notUploadedPeriods.length > 0
        ? {
            periods: notUploadedPeriods,
            value: heldOutValue,
            rows: heldOut.length,
            note: notUploadedNote,
            alsoHeldOut: alsoHeldOut
              ? {
                  marketingRequests: alsoHeldOut.marketingRequests,
                  marketingCommitted: alsoHeldOut.marketingCommitted,
                  outstationRows: alsoHeldOut.outstationRows,
                  outstationClaimed: alsoHeldOut.outstationClaimed,
                  visitRows: alsoHeldOut.visitRows,
                  visitAgents: alsoHeldOut.visitAgents,
                }
              : null,
          }
        : null,
  });
}

/** Resolve a from/to request against what the data holds, then build it. The one entry point a
 *  page or route should call when it has raw request parameters. */
export async function loadReviewForRequest(
  fromParam: string | null | undefined,
  toParam: string | null | undefined,
): Promise<ReviewBundle> {
  const available = await availableReviewPeriods();
  const { window, adjustment } = resolveReviewWindow(fromParam, toParam, available);
  return loadReviewBundle(window, adjustment);
}

/** Exported for the empty-state paths so a failed load never renders as "sold nothing". */
export function emptySlice(): Slice {
  return { ...EMPTY_SLICE };
}

/**
 * Total a scoped subset of areas with the same rule the whole review uses.
 *
 * Since the 2026-09-26 ruling this is EXACT rather than approximate: every area slice was graded
 * against its own line's targeted months, so summing all of a line's areas reproduces the line's
 * own figure, and summing a district manager's areas reproduces the district's. Before it, each
 * area decided its own graded months and the sum fell short of the line it belonged to.
 */
export function totalAreas(areas: readonly AreaSummary[]): Slice {
  const total = emptyTotals();
  for (const area of areas) {
    total.actualValue += area.allProducts.sales;
    total.targetValue += area.allProducts.target;
    // `area.allProducts.graded`, not `area.allProducts.sales` behind a `hasTarget` flag: an area
    // that has a target on one product and none on another used to contribute BOTH products'
    // sales to the numerator. The slice now carries the key-grain figure the engine computed.
    total.gradedActualValue += area.allProducts.graded;
  }
  total.achievementValue = total.targetValue !== 0 ? total.gradedActualValue / total.targetValue : null;
  return sliceOf(total);
}
