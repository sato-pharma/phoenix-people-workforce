// Business Review — dataset types.
//
// EVERY FIGURE HERE IS LIVE AND WINDOW-SCOPED. Sales, targets and achievement come from the
// canonical engine (au.f_monthly_achievement); marketing, outstation, CRM visits, double visits
// and doctor counts come from their own production tables through src/lib/business-review/sources/.
// Nothing is read from a committed workbook any more.
//
// MONTH KEYS ARE PERIODS ("2026-01"), NOT MONTH NAMES ("Jan"). Every `Record<string, …>` keyed
// "by month" below is keyed on the period. That is what makes a window spanning a year boundary
// possible at all — two Januaries in one window collided under the old key — and it sorts
// correctly for free. `meta.months` carries those keys in window order and `meta.monthLabels`
// carries the display text for the same positions, so a renderer iterates `months` and prints
// `monthLabels`.
//
// A ZERO IN THIS FILE IS A REAL ZERO. When a source holds no rows at all for the window, the
// figure is still 0 here and the truth is carried beside it in `ReviewCoverage` — the UI reads
// coverage FIRST and prints "no data" instead of the number. That split is deliberate: making
// every field nullable would push the same decision into a hundred render sites, and one missed
// `?? 0` would silently print the accusation this module exists to prevent.

import type { ReviewCoverage } from "./coverage";
import type { ReviewWindow } from "./period";
import type { ReviewPersonRow, ReviewRoleRow } from "./sources/roles";

export type { CoverageStatus, ReviewCoverage, ReviewSourceId, SourceCoverage } from "./coverage";
export type { ReviewWindow } from "./period";
export type { ReviewPersonRow, ReviewRoleRow } from "./sources/roles";

/**
 * One totals bucket: what was sold, what was asked for, and the percentage between them.
 *
 * `graded` is the half that is easy to leave out and impossible to reconstruct afterwards: the
 * numerator `ach` really divides. It travels with every Slice because **a percentage cannot be
 * re-aggregated — only the parts it divides can.** Any caller summing slices (company from lines,
 * family from SKUs, a district manager's own areas) must divide `sum(graded)` by `sum(target)`.
 *
 * WHAT "GRADED" MEANS, AND WHY IT IS NO LONGER "COVERED". Owner ruling 2026-09-05 — "FOLLOW THE
 * OLD MONTHLY CLOSING ... MUST BE 100% IDENTICAL" — so this page prints the number the Monthly
 * Closing prints. The closing carries two rules and both are in force here:
 *
 *   inside a month, EVERY pound counts, including sales on a product nobody targeted;
 *   across months, a month carrying no target at all is left out of the numerator entirely.
 *
 * The second rule is the closing's own "ALL MONTHS" row, and it exists because this page spans a
 * WINDOW while the closing covers one month. Mar–Jun 2026 hold sales and no target: counting them
 * against the targeted months' targets reads 77.55% where the closing's rule reads 35.26%.
 *
 * This field was called `covered` until 2026-09-05 and meant "actual on a key that HAS a target" —
 * the first rule inverted. It was renamed rather than quietly redefined, because a numerator that
 * changes meaning under an unchanged name is exactly how two screens start disagreeing again. The
 * old meaning survives as a coverage statistic (`VsTargetTotals.coveredActualValue`), reported
 * beside the percentage and never inside it.
 */
export type Slice = { sales: number; target: number; graded: number; ach: number | null };

export type AreaSummary = {
  area: string;
  /** Canonical area code. Null only for the "no area on the source row" bucket. */
  areaCode: string | null;
  /** The live DM seat this area was attributed to — the key portal scoping filters on. */
  dmSeatId: string | null;
  dm: string;
  /** Sales region this area sits in (Alex-BHR, Cairo, Delta (1)/(2), Giza, UE…).
   * Drives Regional-Manager scoping in the employee portal. */
  region: string;
  vacant: boolean;
  includeOnly: Slice;
  allProducts: Slice;
  hasTarget: boolean;
  ungradeable: boolean;
  hasReturns: boolean;
  products: Record<string, Slice>; // product name -> slice (include products)
  /** Include-only sales per window month, positionally aligned with `meta.months`. */
  trend: number[];
  /** Sales, target and achievement per window month. */
  byMonth: Record<string, Slice>;
  /** Distinct medical reps who carried sales in this area during the window. */
  reps: number;

  // ── Live field activity for the reps placed in this area, month by month ──
  visits: number;
  regularVisits: number;
  campaignVisits: number;
  visitsByMonth: Record<string, number>;
  /** Rides RECEIVED here — visits a manager rode along on. */
  doubleVisits: number;
  /** THE question the owner asked for by name: "this area had 200 customers in April, 300 in May."
   *  A union of the doctors a regular visit named, never a sum across reps. */
  customersTotal: number;
  customersByMonth: Record<string, number>;
  outstationClaimed: number;
  outstationApproved: number;
  marketingCommitted: number;
  marketingRequests: number;
};

export type DmSummary = {
  dm: string;
  /** The live DM seat. Null only for the "no district manager" catch-all bucket. */
  dmSeatId: string | null;
  /** Sales region this DM seat owns — the unit a Regional Manager is scoped to. */
  region: string;
  vacant: boolean;
  areas: string[];
  activeAreas: string[];
  includeOnly: Slice;
  activeIncludeOnly: Slice;
  allProducts: Slice;
  productAch: Record<string, number | null>;
  /** Same rollup as productAch but at family level (product family -> achievement %). */
  familyAch: Record<string, number | null>;
  trend: number[];
  marketingCost: number;
  marketingPending: number;
  marketingRequests: number;
  marketingMonths: number;
  marketingByMonth: Record<string, number>;
  /** Claimed excluding rejected. The column a district review asks about. */
  outstationCost: number;
  /** HR-signed-off only — the payroll gate. Much smaller than `outstationCost` before July 2026. */
  outstationApproved: number;
  outstationRows: number;
  outstationMonths: number;
  outstationByMonth: Record<string, number>;
  outstationApprovedByMonth: Record<string, number>;
  /** Rides received by this district's reps — additive with the areas below it. */
  doubleVisits: number;
  /** Rides this manager personally delivered. Their own coaching output, not the district's. */
  doubleVisitsLed: number;
  visits: number;
  regularVisits: number;
  campaignVisits: number;
  visitsAvgPerMonth: number;
  visitsByMonth: Record<string, number>;
  achByMonth: Record<string, number | null>;
  achByMonthActive: Record<string, number | null>;
  customersTotal: number;
  customersByMonth: Record<string, number>;
};

export type ProductRow = {
  product: string;
  family: string;
  include: boolean;
  byMonth: Record<string, Slice>;
  total: Slice;
};

export type LineSummary = {
  includeOnly: Slice;
  allProducts: Slice;
  withException: { includeOnly: Slice; allProducts: Slice };
  exVacant: { includeOnly: Slice };
  exceptionValue: number;
  /** Calendar quarters the window touches. A partly covered quarter is still listed, flagged
   *  `complete: false`, so two months of a quarter can never read as three. */
  quarters: Record<string, { includeOnly: Slice; allProducts: Slice; complete: boolean }>;
  byMonth: Record<string, { includeOnly: Slice; allProducts: Slice }>;
  marketingCost: number;
  marketingPending: number;
  outstationCost: number;
  outstationApproved: number;
  visits: number;
  regularVisits: number;
  campaignVisits: number;
  doubleVisits: number;
  visitsAvgPerRepPerMonth: number;
  /** Distinct medical reps who carried sales on this line during the window. */
  reps: number;
  /** Distinct reps who logged at least one field visit — the denominator above. */
  visitingReps: number;
  customersTotal: number;
  customersByMonth: Record<string, number>;
};

export type MarketingSummary = {
  /** Committed spend attributed to this line. */
  committed: number;
  /** Requested but not yet decided — shown separately, never added to committed. */
  pending: number;
  requests: number;
  byDM: Record<string, { cost: number; requests: number; months: number; byMonth: Record<string, number> }>;
  monthsCovered: string[];
  note: string;
};

export type OutstationSummary = {
  /** Claimed excluding rejected. */
  claimed: number;
  /** HR-signed-off only. */
  approved: number;
  rows: number;
  byDM: Record<
    string,
    { cost: number; approved: number; rows: number; months: number; byMonth: Record<string, number> }
  >;
  monthsCovered: string[];
  components: { travel: number; meeting: number; allowance: number; other: number };
  status: string;
};

export type RepVisit = {
  agentHrId: string;
  name: string;
  hiringDate: string | null;
  visits: number;
  regularVisits: number;
  campaignVisits: number;
  activeMonths: number;
  avgPerMonth: number;
  customers: number;
  dm: string | null;
  area: string | null;
};

export type VisitsSummary = {
  /** False when this window holds no CRM visit rows at all — "no data", never "zero visits". */
  available: boolean;
  totalDeduped: number;
  reps: number;
  avgPerRepPerMonth: number;
  byMonth: Record<string, number>;
  customersTotal: number;
  customersByMonth: Record<string, number>;
  byDM: Record<string, { visits: number; avgPerMonth: number; byMonth: Record<string, number> }>;
  /** Share of this line's visiting reps that resolve to a district, 0..1. */
  repToDmCoverage: number;
  perRep: RepVisit[];
  /** The activity mix in the CRM's own display labels — Regular, Campaign, Meetings, Admin Work… */
  activityMix: { label: string; rows: number }[];
};

export type ReviewMeta = {
  line: string;
  /** Display label for the window — "Jan – Jun 2026". */
  period: string;
  currency: string;
  /** Period keys, in window order. Index every by-month record with these. */
  months: string[];
  /** Display labels for the same positions. */
  monthLabels: string[];
  generatedFrom: string[];
  thresholds: { repFailBelow: number; dsmFailBelow: number };
  /** The standing rules this dataset was built under, in plain words. */
  rulings: Record<string, string | string[]>;
};

export type ReviewDataset = {
  meta: ReviewMeta;
  line: LineSummary;
  products: ProductRow[];
  dms: DmSummary[];
  areas: AreaSummary[];
  marketing: MarketingSummary;
  outstation: OutstationSummary;
  visits: VisitsSummary;
  doubleVisits: { total: number; byManager: Record<string, number> };
};

/** One line's row in the company comparison table. */
export type CompanyLineRow = {
  id: string;
  label: string;
  allProducts: Slice;
  exVacant: Slice;
  marketingCost: number;
  outstationCost: number;
  outstationApproved: number;
  visits: number;
  visitsAvailable: boolean;
  doubleVisits: number;
  customersTotal: number;
  dms: number;
  dmsVacant: number;
  areas: number;
  areasVacant: number;
  earners: number;
  repFails: number;
};

/** One DM's row in the cross-line DSM league table (target-less buckets excluded). */
export type CompanyDmRow = {
  dm: string;
  line: string;
  lineId: string;
  vacant: boolean;
  allProducts: Slice;
  marketingCost: number;
  outstationCost: number;
  visitsAvgPerMonth: number;
  customersTotal: number;
  doubleVisits: number;
  visitsAvailable: boolean;
};

/** Cross-line rollup. Achievement is sum(sales)/sum(target), never an average of line percentages;
 * `customersTotal` is a true union of doctor ids across lines, not the sum of the per-line counts. */
export type ReviewCompany = {
  meta: {
    period: string;
    currency: string;
    months: string[];
    monthLabels: string[];
    lines: string[];
    doctorNote: string;
    generatedFrom: string[];
    thresholds: { repFailBelow: number; dsmFailBelow: number };
  };
  total: {
    allProducts: Slice;
    exVacant: Slice;
    marketingCost: number;
    marketingPending: number;
    outstationCost: number;
    outstationApproved: number;
    visits: number;
    doubleVisits: number;
    reps: number;
    customersTotal: number;
    customersByMonth: Record<string, number>;
    /** Sum of the lines' own doctor counts — above `customersTotal` by the cross-line overlap. */
    customersNaiveSum: number;
    customersOverlap: number;
    areas: number;
    areasVacant: number;
    byMonth: Record<string, Slice>;
  };
  lines: CompanyLineRow[];
  dms: CompanyDmRow[];
  /** Activity by job role, and the named limits of each. */
  roles: ReviewRoleRow[];
  /** The individuals behind the role table, ranked by recorded activity. */
  people: ReviewPersonRow[];
};

/** Everything a page needs to render one window: the data, the window it answers, and an honest
 *  account of what the window does and does not hold. */
export type BusinessReviewData = {
  window: ReviewWindow;
  coverage: ReviewCoverage;
  company: ReviewCompany;
  datasets: Record<string, ReviewDataset>;
};
