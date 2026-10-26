/**
 * KPIs — the advanced filter, band and sort engine.
 *
 * DELIBERATELY DEPENDENCY-FREE, for exactly the reason kpis-tabs.ts is. The filter bar is a
 * `"use client"` component, so every RUNTIME value it imports drags that module's whole dependency
 * chain into the browser bundle. Importing these from kpis-board.ts would pull getRepDoctorLists →
 * the Supabase admin client → `node:crypto`, and the page 500s with
 * `UnhandledSchemeError: Reading from "node:crypto"` — a failure `tsc` cannot see, which is what
 * happened to the Reps Weekly Plans status filter on 2026-09-01.
 *
 * So this file imports NOTHING but its sibling kpis-doctor-filters.ts, itself dependency-free (the
 * doctor filters ride in the same URL, so the one builder below has to know their names). The row it filters is described structurally (`KpiFilterableRow`)
 * rather than imported from the board, which also means the whole engine is fixture-testable with
 * no database anywhere near it.
 *
 * ## It adds no fourth KPI
 *
 * kpis-board.ts is explicit that the board "assembles the measures that were already right and adds
 * no fourth one". Nothing here invents a composite score. The bands are the SAME three measures cut
 * into ranges, and the two attainment percentages express each call-rate target against its own
 * target — `attainmentPct` is already a field on CallRateSlice in call-rate.ts. A rep is never
 * ranked on a blended number, because a blended number would be a fourth measure wearing a hat.
 *
 * ## Everything rides in the URL
 *
 * Every filter is a query parameter, so a manager can send a colleague the exact board he is
 * looking at, and — the part that matters — every change re-runs the server-side scope gate. A
 * filter can only ever NARROW what the gate already allowed; it can never widen it. The filtering
 * runs after `joinKpiRows` has already dropped every rep outside the viewer's reach.
 */

import {
  EMPTY_KPI_DOCTOR_FILTER,
  KPI_DOCTOR_PARAM_KEYS,
  kpiDoctorFilterToParams,
  parseKpiDoctorFilter,
  type KpiDoctorFilter,
} from "@/lib/crm/kpis-doctor-filters";

/** A rep row as the filter engine reads it. `KpiRepRow` satisfies this structurally. */
export type KpiFilterableRow = {
  repName: string;
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
  managerName: string | null;
  /** Every manager above `managerName`, nearest first. Optional: a row without it is matched on its
   * direct manager alone, exactly as before. */
  managersAbove?: readonly string[] | null;
  jobTitle: string | null;

  workingDays: number;
  amRate: number | null;
  pmRate: number | null;
  amVerified: number;
  pmVerified: number;
  totalCalls: number;
  campaignCalls: number;
  campaignShare: number;
  campaignOnlyDays: number;
  hasCallRate: boolean;
  /** Ruling A1 (owner, 2026-09-21): real visits and no GPS check-in at all, so nothing could be
   * proved. See `KpiRepRow.noGpsFeed`. Optional so a row built without a call-rate feed reads false. */
  noGpsFeed?: boolean;
  /** Morning calls against the AM target and afternoon calls against the PM target — two figures,
   * never one. Null with no working days. The owner banned the blend on 2026-09-04; kpis-board.ts
   * carries the reasoning. */
  amAttainmentPct: number | null;
  pmAttainmentPct: number | null;
  /** Separate from AM/PM entirely (owner, 2026-09-05) — see PHARMACY_CALL_RATE_TARGET in
   * crm/call-rate.ts. `pharmacyAttainmentPct` is always null today; it exists so the day the owner
   * sets a target, only that constant needs to change. */
  pharmacyRate: number | null;
  pharmacyVerified: number;
  pharmacyAttainmentPct: number | null;

  /** THE DENOMINATOR OF BOTH PLAN KPIs — every doctor the plan names inside the scored window,
   * whether or not his day has arrived. See the window note in crm/kpis-board.ts. */
  plannedDoctors: number;
  visitedDoctors: number;
  /** Planned doctors with no visit inside the window. The coverage shortfall, and — now that both
   * sides count the whole window — the only shortfall this board has. */
  missedDoctors: number;
  coveragePct: number;
  /** Whether `coveragePct` clears the owner's 95% floor (2026-09-05). Null exactly when
   * `hasMeasurablePlan` is false — the same guard {@link coverageBandOf} already honours. */
  meetsCoverageFloor: boolean | null;
  onPlanDoctors: number;
  underDoctors: number;
  overDoctors: number;
  frequencyPct: number;
  hasMeasurablePlan: boolean;
  /** Set when the rep was hired inside the window and has worked too little of it to be judged —
   * see {@link kpiJustStartedOf}. Optional so a row built without a hire date reads as judged. */
  justStarted?: KpiJustStarted | null;
};

// ── Bands ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The four performance bands, plus the one that is not a performance at all.
 *
 * `noplan` is a band rather than a zero, and this is the single most important line in the file.
 * A rep with no planned doctors is NOT a 0% performer — `hasMeasurablePlan` exists precisely so he
 * cannot be ranked as one — so "Behind" must never swallow him. Filtering for `behind` returns
 * people who missed; filtering for `noplan` returns people the plan never asked anything of. Those
 * are two completely different conversations for a manager to have.
 */
export const KPI_BANDS = ["elite", "strong", "steady", "behind", "noplan"] as const;

export type KpiBand = (typeof KPI_BANDS)[number];

export const KPI_BAND_LABEL: Record<KpiBand, string> = {
  elite: "Elite · 90%+",
  strong: "Strong · 75–89%",
  steady: "Steady · 50–74%",
  behind: "Behind · under 50%",
  noplan: "Not measurable",
};

/** The short form, for a chip that sits inside a table cell. */
export const KPI_BAND_SHORT: Record<KpiBand, string> = {
  elite: "Elite",
  strong: "Strong",
  steady: "Steady",
  behind: "Behind",
  noplan: "No plan",
};

/** Cuts a percentage into a band. `null` — nothing to be a percentage of — is always `noplan`. */
export function kpiBandOf(value: number | null): KpiBand {
  if (value == null) return "noplan";
  if (value >= 90) return "elite";
  if (value >= 75) return "strong";
  if (value >= 50) return "steady";
  return "behind";
}

/** Coverage band for a row, honouring `hasMeasurablePlan`. */
export function coverageBandOf(row: KpiFilterableRow): KpiBand {
  if (row.justStarted) return "noplan";
  return kpiBandOf(row.hasMeasurablePlan ? row.coveragePct : null);
}

/**
 * Coverage floor — owner's own words, 2026-09-05: "coverage no less than 95%." Scores THIS board's
 * `coveragePct` (visitedDoctors / plannedDoctors, over the scored window) — not the grade-weighted
 * panel norms in sfe-doctor-coverage.ts, a different board scoring a different question ("did he
 * see this doctor the number of times his grade requires") over a different denominator (the
 * assigned 90-120 panel, not this window's plan). Measured on production for August 2026: 2 of 70
 * reps at or above it.
 */
export const COVERAGE_TARGET_FLOOR_PCT = 95;

/** Frequency band for a row, honouring `hasMeasurablePlan`. */
export function frequencyBandOf(row: KpiFilterableRow): KpiBand {
  if (row.justStarted) return "noplan";
  return kpiBandOf(row.hasMeasurablePlan ? row.frequencyPct : null);
}

/**
 * The AM band and the PM band — two bands, because there are two standards.
 *
 * A rep who logged NOTHING is `noplan`, not `behind`: `hasCallRate` false means the CRM has no row
 * for him in this window at all, which can be leave, a sync gap or a genuinely idle month. Reading
 * "Behind" onto an absence would state as fact the one thing the data cannot tell you.
 *
 * There is deliberately NO combined band. The owner's rule of 2026-09-04 is that AM is judged
 * against 2 and PM against 10, apart — and a band is a single verdict, so a combined one would be
 * the banned average wearing a colour.
 */
export function amBandOf(row: KpiFilterableRow): KpiBand {
  if (row.justStarted || !row.hasCallRate || row.amAttainmentPct == null) return "noplan";
  return kpiBandOf(row.amAttainmentPct);
}

export function pmBandOf(row: KpiFilterableRow): KpiBand {
  if (row.justStarted || !row.hasCallRate || row.pmAttainmentPct == null) return "noplan";
  return kpiBandOf(row.pmAttainmentPct);
}

// ── Flags ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The situations a manager actually goes looking for. Each is derived from fields already on the
 * row — no flag asks a question the board cannot answer from what it already fetched.
 */
export const KPI_FLAGS = [
  "just-started",
  "never-reached",
  "no-calls",
  "no-gps-feed",
  "no-plan",
  "campaign-heavy",
  "campaign-only-days",
  "under-visiting",
  "over-visiting",
  "below-am-target",
  "below-pm-target",
  "perfect-frequency",
  "below-coverage-floor",
] as const;

export type KpiFlag = (typeof KPI_FLAGS)[number];

export const KPI_FLAG_LABEL: Record<KpiFlag, string> = {
  "just-started": "Just started",
  "never-reached": "Never reached a planned doctor",
  "no-calls": "Logged no calls at all",
  "no-gps-feed": "No GPS feed",
  "no-plan": "Carries no plan",
  "campaign-heavy": "Half or more of calls were campaign",
  "campaign-only-days": "Had campaign-only days",
  "under-visiting": "More below-plan doctors than above",
  "over-visiting": "Visited someone more than planned",
  "below-am-target": "Under the AM target",
  "below-pm-target": "Under the PM target",
  "perfect-frequency": "Every due doctor exactly on plan",
  "below-coverage-floor": "Below the 95% coverage floor",
};

/** One line saying what the flag is FOR, shown under the label in the filter panel. */
export const KPI_FLAG_HINT: Record<KpiFlag, string> = {
  "just-started":
    "Hired inside this period and has worked under a third of its working days, so the board shows the figures and judges none of them.",
  "never-reached": "Has planned doctors and visited none of them. The most urgent row on the board.",
  "no-calls": "No CRM row in this window — could be leave, a sync gap, or an idle period.",
  "no-gps-feed":
    "Logged visits, but no GPS check-in reached the CRM from this account, so none could be proved. The proved rates are blank and the calls are left out of the team's call rate.",
  "no-plan": "Nothing was planned, so coverage and frequency have no denominator.",
  "campaign-heavy": "Campaign calls name no doctor, so this share of the work cannot be verified.",
  "campaign-only-days": "Days with campaign calls and not one verified visit.",
  "under-visiting": "Short of the plan more often than over it.",
  "over-visiting": "Over-visiting is a deviation, not a win — the owner's rule.",
  "below-am-target": "Verified morning calls came in under the AM target, judged on its own.",
  "below-pm-target": "Verified afternoon calls came in under the PM target, judged on its own.",
  "perfect-frequency": "100% frequency. Exact is the only pass, so this is the real thing.",
  "below-coverage-floor": "Owner's floor, 2026-09-05: coverage should be no less than 95%.",
};

/**
 * The flag wording that changes once the Phoenix KPI rules score a period (phase 6, after the CRM
 * cutover). Frequency then passes at the grade norm with extra visits allowed, so "exactly on plan"
 * would describe a rule that no longer exists.
 */
export const KPI_FLAG_LABEL_PHOENIX: Partial<Record<KpiFlag, string>> = {
  "perfect-frequency": "Every graded doctor at their grade norm",
  "under-visiting": "Doctors below their grade norm",
};

export const KPI_FLAG_HINT_PHOENIX: Partial<Record<KpiFlag, string>> = {
  "perfect-frequency": "100% frequency: every graded doctor got the visits their grade asks for. Extra visits are fine.",
  "under-visiting": "At least one graded doctor got fewer visits than their grade asks for.",
  "below-am-target": "Submitted morning visits came in under the AM target, judged on its own.",
  "below-pm-target": "Submitted afternoon visits came in under the PM target, judged on its own.",
};

/** A flag's label under the rules that scored the board. */
export function kpiFlagLabel(flag: KpiFlag, rules?: "legacy" | "phoenix"): string {
  return (rules === "phoenix" ? KPI_FLAG_LABEL_PHOENIX[flag] : undefined) ?? KPI_FLAG_LABEL[flag];
}

/** A flag's hint under the rules that scored the board. */
export function kpiFlagHint(flag: KpiFlag, rules?: "legacy" | "phoenix"): string {
  return (rules === "phoenix" ? KPI_FLAG_HINT_PHOENIX[flag] : undefined) ?? KPI_FLAG_HINT[flag];
}

/** Every flag that is true of this row. */
export function kpiFlagsOf(row: KpiFilterableRow): KpiFlag[] {
  // A rep too new to judge carries ONE flag and none of the verdicts: "never reached", "no calls",
  // "below the floor" and the rest are true of nearly anybody two working days in, and say nothing.
  if (row.justStarted) return ["just-started"];
  const flags: KpiFlag[] = [];
  if (row.hasMeasurablePlan && row.visitedDoctors === 0) flags.push("never-reached");
  if (!row.hasCallRate || row.totalCalls === 0) flags.push("no-calls");
  if (row.noGpsFeed) flags.push("no-gps-feed");
  if (!row.hasMeasurablePlan) flags.push("no-plan");
  if (row.campaignShare >= 0.5 && row.campaignCalls > 0) flags.push("campaign-heavy");
  if (row.campaignOnlyDays > 0) flags.push("campaign-only-days");
  if (row.underDoctors > 0 && row.underDoctors > row.overDoctors) flags.push("under-visiting");
  if (row.overDoctors > 0) flags.push("over-visiting");
  if (row.hasCallRate && row.amAttainmentPct != null && row.amAttainmentPct < 100) flags.push("below-am-target");
  if (row.hasCallRate && row.pmAttainmentPct != null && row.pmAttainmentPct < 100) flags.push("below-pm-target");
  if (row.hasMeasurablePlan && row.frequencyPct === 100) flags.push("perfect-frequency");
  if (row.meetsCoverageFloor === false) flags.push("below-coverage-floor");
  return flags;
}

// ── Sorting ───────────────────────────────────────────────────────────────────────────────────

export const KPI_SORT_FIELDS = [
  "rep",
  "line",
  "area",
  "manager",
  "coverage",
  "frequency",
  "am",
  "pm",
  "pharmacy",
  "planned",
  "visited",
  "missed",
  "exact",
  "below",
  "above",
  "calls",
  "campaign",
  "workingdays",
] as const;

export type KpiSortField = (typeof KPI_SORT_FIELDS)[number];

export const KPI_SORT_LABEL: Record<KpiSortField, string> = {
  rep: "Medical rep",
  line: "Line",
  area: "Area",
  manager: "Manager",
  coverage: "Coverage",
  frequency: "Frequency",
  am: "AM rate",
  pm: "PM rate",
  // No target exists yet (see PHARMACY_CALL_RATE_TARGET) — the label says "rate", never "% target".
  pharmacy: "Pharmacy rate",
  planned: "Planned doctors",
  visited: "Covered doctors",
  missed: "Not reached",
  exact: "Exact",
  below: "Below",
  above: "Above",
  calls: "Total calls",
  campaign: "Campaign share",
  workingdays: "Working days",
};

export type KpiSortDirection = "asc" | "desc";

/**
 * The sort key for a row, or `null` when the row has no honest value for that field.
 *
 * A null is NOT a zero here, and the sort below always parks nulls LAST whichever direction is
 * asked for. Sorting worst-first on coverage must surface the rep who missed 40 doctors, not the
 * three reps who were never given a plan — they would otherwise occupy the top of the "worst"
 * list permanently and push the real answer off the first screen.
 */
function sortKey(row: KpiFilterableRow, field: KpiSortField): number | string | null {
  switch (field) {
    case "rep":
      return row.repName || "";
    case "line":
      return row.lineName ?? "";
    case "area":
      return row.areaName ?? "";
    case "manager":
      return row.managerName ?? "";
    case "coverage":
      return row.hasMeasurablePlan ? row.coveragePct : null;
    case "frequency":
      return row.hasMeasurablePlan ? row.frequencyPct : null;
    case "am":
      return row.amRate;
    case "pm":
      return row.pmRate;
    case "pharmacy":
      return row.pharmacyRate;
    case "planned":
      return row.plannedDoctors;
    case "visited":
      return row.visitedDoctors;
    case "missed":
      // The shortfall against the WHOLE window, which is the denominator the percentage beside it
      // now uses too. Identical to `missedDoctors`, and derived rather than read so the column and
      // the sort can never drift onto two different bases again.
      return row.plannedDoctors - row.visitedDoctors;
    case "exact":
      return row.onPlanDoctors;
    case "below":
      return row.underDoctors;
    case "above":
      return row.overDoctors;
    case "calls":
      return row.totalCalls;
    case "campaign":
      return row.campaignShare;
    case "workingdays":
      return row.workingDays;
    default:
      return null;
  }
}

// ── Ranges ────────────────────────────────────────────────────────────────────────────────────

/**
 * The columns a manager can bound with a minimum and a maximum — every number the rep tables print.
 *
 * Bounds are on the figure as the table SHOWS it (to one decimal), so a rep printed as "90%" is never
 * filtered out of "90 and over" by a hidden 89.6. A rep with NOTHING to measure on the column (no
 * plan, no call-rate row) never passes a bound on it: an absence is not a zero, and a "coverage under
 * 50%" filter must not swallow the people who were simply never given a plan. Pharmacy rate is not
 * offered — it has no target and is always blank.
 */
export const KPI_RANGE_FIELDS = [
  "coverage",
  "frequency",
  "am",
  "pm",
  "planned",
  "visited",
  "missed",
  "exact",
  "below",
  "above",
  "calls",
  "campaign",
  "workingdays",
] as const;

export type KpiRangeField = (typeof KPI_RANGE_FIELDS)[number];

export const KPI_RANGE_LABEL: Record<KpiRangeField, string> = {
  coverage: "Coverage",
  frequency: "Frequency",
  am: "AM calls a day",
  pm: "PM calls a day",
  planned: "Planned doctors",
  visited: "Covered doctors",
  missed: "Not reached",
  exact: "Doctors exact",
  below: "Doctors below",
  above: "Doctors above",
  calls: "Total calls",
  campaign: "Campaign share",
  workingdays: "Working days",
};

/** The unit a field's bound is typed in, shown beside the input. */
export const KPI_RANGE_UNIT: Record<KpiRangeField, string> = {
  coverage: "%",
  frequency: "%",
  am: "a day",
  pm: "a day",
  planned: "doctors",
  visited: "doctors",
  missed: "doctors",
  exact: "doctors",
  below: "doctors",
  above: "doctors",
  calls: "calls",
  campaign: "%",
  workingdays: "days",
};

export type KpiRange = { min: number | null; max: number | null };
export type KpiRangeFilters = Partial<Record<KpiRangeField, KpiRange>>;

/** The figure a range is tested against, or null when the row has nothing honest on that column. */
function rangeValue(row: KpiFilterableRow, field: KpiRangeField): number | null {
  switch (field) {
    case "coverage":
      return row.hasMeasurablePlan ? row.coveragePct : null;
    case "frequency":
      return row.hasMeasurablePlan ? row.frequencyPct : null;
    case "am":
      return row.amRate;
    case "pm":
      return row.pmRate;
    case "planned":
      return row.plannedDoctors;
    case "visited":
      return row.visitedDoctors;
    case "missed":
      return row.plannedDoctors - row.visitedDoctors;
    case "exact":
      return row.onPlanDoctors;
    case "below":
      return row.underDoctors;
    case "above":
      return row.overDoctors;
    case "calls":
      return row.totalCalls;
    case "campaign":
      return row.totalCalls > 0 ? row.campaignShare * 100 : null;
    case "workingdays":
      return row.workingDays;
    default:
      return null;
  }
}

function roundForRange(value: number): number {
  return Math.round(value * 10) / 10;
}

/** Whether the row sits inside every bound. A bound that names no number is not a bound. */
export function matchesKpiRanges(row: KpiFilterableRow, ranges: KpiRangeFilters): boolean {
  for (const field of KPI_RANGE_FIELDS) {
    const range = ranges[field];
    if (!range || (range.min == null && range.max == null)) continue;
    const raw = rangeValue(row, field);
    if (raw == null) return false;
    const value = roundForRange(raw);
    if (range.min != null && value < range.min) return false;
    if (range.max != null && value > range.max) return false;
  }
  return true;
}

/** How many columns carry a bound — one filter each, whichever of min and max (or both) is set. */
export function countKpiRanges(ranges: KpiRangeFilters): number {
  return KPI_RANGE_FIELDS.filter((field) => {
    const range = ranges[field];
    return range != null && (range.min != null || range.max != null);
  }).length;
}

/** The URL parameter a range rides in: `r_coverage=50..90`, either end blank for open. */
export const KPI_RANGE_PARAM_PREFIX = "r_";

function rangeNumber(raw: string): number | null {
  const text = raw.trim();
  if (text === "") return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 1000000 ? roundForRange(value) : null;
}

/**
 * A range from the two boxes a manager typed in. Blank or unreadable is an open end, both open is no
 * range at all, and a minimum typed above the maximum is swapped rather than matching nobody.
 */
export function kpiRangeFromInputs(low: string, high: string): KpiRange | null {
  let min = rangeNumber(low);
  let max = rangeNumber(high);
  if (min == null && max == null) return null;
  if (min != null && max != null && min > max) [min, max] = [max, min];
  return { min, max };
}

function parseRange(raw: string | undefined): KpiRange | null {
  if (!raw || !raw.includes("..")) return null;
  const [low = "", high = ""] = raw.split("..");
  return kpiRangeFromInputs(low, high);
}

function rangeParam(range: KpiRange): string {
  return `${range.min ?? ""}..${range.max ?? ""}`;
}

// ── Filter state ──────────────────────────────────────────────────────────────────────────────

export type KpiFilterState = {
  lines: string[];
  regions: string[];
  areas: string[];
  managers: string[];
  titles: string[];
  coverage: KpiBand[];
  frequency: KpiBand[];
  amRate: KpiBand[];
  pmRate: KpiBand[];
  flags: KpiFlag[];
  /** Minimum and maximum on any number column — see {@link KPI_RANGE_FIELDS}. No entry, no bound. */
  ranges: KpiRangeFilters;
  /** Free text matched against the rep's name, area, line and manager. */
  query: string;
  sort: KpiSortField;
  direction: KpiSortDirection;
  /**
   * The filters on the OPEN rep's doctor list (Frequency and Coverage). They change nothing about
   * which reps are on the board — `applyKpiFilters` never reads them — and live in this state so the
   * one URL builder carries them through every link, as it does everything else.
   */
  doctor: KpiDoctorFilter;
};

/** The URL parameter each facet rides in. Short, because they stack up in one address bar. */
export const KPI_FILTER_PARAMS = {
  lines: "line",
  regions: "region",
  areas: "area",
  managers: "manager",
  titles: "title",
  coverage: "cov",
  frequency: "freq",
  amRate: "amrate",
  pmRate: "pmrate",
  flags: "flag",
  query: "q",
  sort: "sort",
  direction: "dir",
} as const;

export const EMPTY_KPI_FILTERS: KpiFilterState = {
  lines: [],
  regions: [],
  areas: [],
  managers: [],
  titles: [],
  coverage: [],
  frequency: [],
  amRate: [],
  pmRate: [],
  flags: [],
  ranges: {},
  query: "",
  sort: "rep",
  direction: "asc",
  doctor: EMPTY_KPI_DOCTOR_FILTER,
};

/** Whether anything is actually filtering. Sort order alone is not a filter. */
export function hasActiveKpiFilters(filters: KpiFilterState): boolean {
  return (
    filters.lines.length > 0 ||
    filters.regions.length > 0 ||
    filters.areas.length > 0 ||
    filters.managers.length > 0 ||
    filters.titles.length > 0 ||
    filters.coverage.length > 0 ||
    filters.frequency.length > 0 ||
    filters.amRate.length > 0 ||
    filters.pmRate.length > 0 ||
    filters.flags.length > 0 ||
    countKpiRanges(filters.ranges) > 0 ||
    filters.query.trim().length > 0
  );
}

/** How many facet selections are live — the number on the "Filters" button. */
export function countActiveKpiFilters(filters: KpiFilterState): number {
  return (
    filters.lines.length +
    filters.regions.length +
    filters.areas.length +
    filters.managers.length +
    filters.titles.length +
    filters.coverage.length +
    filters.frequency.length +
    filters.amRate.length +
    filters.pmRate.length +
    filters.flags.length +
    countKpiRanges(filters.ranges) +
    (filters.query.trim() ? 1 : 0)
  );
}

/** Splits a `a,b,c` parameter. Blank entries are dropped rather than becoming an empty facet. */
function splitParam(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    ),
  );
}

function keepKnown<T extends string>(values: string[], allowed: readonly T[]): T[] {
  const set = new Set<string>(allowed);
  return values.filter((value): value is T => set.has(value));
}

/**
 * Reads the filter state out of the URL.
 *
 * An unrecognised value is DROPPED, never rendered as an empty result. The same rule
 * `resolveKpiTab` follows and for the same reason: a blank board reads as "these reps did
 * nothing", which is a statement about people rather than about a typo in a query string.
 */
export function parseKpiFilters(params: Record<string, string | string[] | undefined>): KpiFilterState {
  const read = (key: string): string | undefined => {
    const value = params[key];
    if (Array.isArray(value)) return value[0];
    return value;
  };

  const sortRaw = (read(KPI_FILTER_PARAMS.sort) ?? "").trim().toLowerCase();
  const directionRaw = (read(KPI_FILTER_PARAMS.direction) ?? "").trim().toLowerCase();

  return {
    lines: splitParam(read(KPI_FILTER_PARAMS.lines)),
    regions: splitParam(read(KPI_FILTER_PARAMS.regions)),
    areas: splitParam(read(KPI_FILTER_PARAMS.areas)),
    managers: splitParam(read(KPI_FILTER_PARAMS.managers)),
    titles: splitParam(read(KPI_FILTER_PARAMS.titles)),
    coverage: keepKnown(splitParam(read(KPI_FILTER_PARAMS.coverage)), KPI_BANDS),
    frequency: keepKnown(splitParam(read(KPI_FILTER_PARAMS.frequency)), KPI_BANDS),
    amRate: keepKnown(splitParam(read(KPI_FILTER_PARAMS.amRate)), KPI_BANDS),
    pmRate: keepKnown(splitParam(read(KPI_FILTER_PARAMS.pmRate)), KPI_BANDS),
    flags: keepKnown(splitParam(read(KPI_FILTER_PARAMS.flags)), KPI_FLAGS),
    ranges: parseRanges(read),
    query: (read(KPI_FILTER_PARAMS.query) ?? "").trim().slice(0, 120),
    sort: (KPI_SORT_FIELDS as readonly string[]).includes(sortRaw) ? (sortRaw as KpiSortField) : "rep",
    direction: directionRaw === "desc" ? "desc" : "asc",
    doctor: parseKpiDoctorFilter(params),
  };
}

function parseRanges(read: (key: string) => string | undefined): KpiRangeFilters {
  const ranges: KpiRangeFilters = {};
  for (const field of KPI_RANGE_FIELDS) {
    const range = parseRange(read(`${KPI_RANGE_PARAM_PREFIX}${field}`));
    if (range) ranges[field] = range;
  }
  return ranges;
}

/** Serialises the state back into query parameters, omitting everything at its default. */
export function kpiFiltersToParams(filters: KpiFilterState): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: string, values: string[]) => {
    if (values.length > 0) out[key] = values.join(",");
  };
  put(KPI_FILTER_PARAMS.lines, filters.lines);
  put(KPI_FILTER_PARAMS.regions, filters.regions);
  put(KPI_FILTER_PARAMS.areas, filters.areas);
  put(KPI_FILTER_PARAMS.managers, filters.managers);
  put(KPI_FILTER_PARAMS.titles, filters.titles);
  put(KPI_FILTER_PARAMS.coverage, filters.coverage);
  put(KPI_FILTER_PARAMS.frequency, filters.frequency);
  put(KPI_FILTER_PARAMS.amRate, filters.amRate);
  put(KPI_FILTER_PARAMS.pmRate, filters.pmRate);
  put(KPI_FILTER_PARAMS.flags, filters.flags);
  for (const field of KPI_RANGE_FIELDS) {
    const range = filters.ranges[field];
    if (range && (range.min != null || range.max != null)) out[`${KPI_RANGE_PARAM_PREFIX}${field}`] = rangeParam(range);
  }
  if (filters.query.trim()) out[KPI_FILTER_PARAMS.query] = filters.query.trim();
  if (filters.sort !== "rep") out[KPI_FILTER_PARAMS.sort] = filters.sort;
  if (filters.direction !== "asc") out[KPI_FILTER_PARAMS.direction] = filters.direction;
  Object.assign(out, kpiDoctorFilterToParams(filters.doctor));
  return out;
}

/**
 * The ONE place a KPIs URL is built — the server view's every link and the client filter bar's
 * every push come through here.
 *
 * Two builders would be two answers the first time either changed, and the symptom is specific and
 * nasty: a sort link that quietly drops the area filter puts a WIDER set of reps on screen than the
 * manager asked for, under a heading that still says the filter is on. Month, period, tab and the
 * open rep are the only things any caller may set positionally; everything else rides in the filter
 * state.
 */
export function buildKpisQuery(input: {
  month: string;
  /** The period KEY (`month`, `w1`…). Omitted from the URL when it is the whole month. */
  period: string;
  /** The active tab id. `summary` is the default and is omitted. */
  tab: string;
  filters: KpiFilterState;
  /**
   * The rep whose doctor list the Coverage tab has open (the row's `coverageRepKey`). Written ONLY
   * on that tab, so moving to another tab closes the list instead of carrying a stale `rep` along.
   * The server re-checks it against the reps the viewer may see, so the URL can never widen scope.
   */
  rep?: string | null;
  /**
   * The Weekly tab's roll-up (`month`, `quarter`, `semester`) and the measure its rep table reads.
   * Written ONLY on that tab and only when not the default, exactly like `rep` on Coverage — so
   * leaving the tab drops them rather than carrying them somewhere they mean nothing.
   */
  trend?: string | null;
  measure?: string | null;
  /**
   * The call-rate report's view (`total`, `am`, `pm`). Written ONLY on the Call Rate tab and only when
   * not the default, like `rep` on Coverage. Spelled out here rather than imported, as `trend` is;
   * tests/kpis-reports-split.test.ts pins that the names and the default agree with crm/kpis-tabs.ts.
   */
  view?: string | null;
}): string {
  const query = new URLSearchParams();
  const weekly = input.tab === "weekly";
  query.set("month", input.month);
  // The Weekly tab lays out every week of the month itself, so a period on it would mean nothing:
  // it is left out, and moving to another tab from there opens that tab on the whole month.
  if (!weekly && input.period && input.period !== "month") query.set("period", input.period);
  if (input.tab && input.tab !== "summary") query.set("tab", input.tab);
  // One rep's doctors open on the Coverage tab AND on the Frequency tab: the same list, read two ways.
  if (input.rep && (input.tab === "coverage" || input.tab === "frequency")) query.set("rep", input.rep);
  if (input.tab === "call-rate" && input.view && input.view !== "total") query.set("view", input.view);
  // The names and defaults are crm/kpis-trend-options.ts's KPI_TREND_PARAMS, spelled out rather than
  // imported so this file keeps importing nothing; tests/kpis-trend.test.ts pins that they agree.
  if (weekly && input.trend && input.trend !== "month") query.set("trend", input.trend);
  if (weekly && input.measure && input.measure !== "am") query.set("measure", input.measure);
  // The doctor filters narrow ONE rep's list, so they travel only on the two tabs that print it —
  // anywhere else they would sit in the address bar describing nothing. Not conditional on `rep`: a
  // board holding a single rep opens his list unasked, with no `rep` in the URL at all.
  const doctorListOpen = input.tab === "coverage" || input.tab === "frequency";
  for (const [key, value] of Object.entries(kpiFiltersToParams(input.filters))) {
    if (!doctorListOpen && KPI_DOCTOR_PARAM_KEYS.includes(key)) continue;
    query.set(key, value);
  }
  return query.toString();
}

/** Returns a copy of the state with one facet value toggled on or off. */
export function toggleKpiFacet(
  filters: KpiFilterState,
  facet:
    | "lines"
    | "regions"
    | "areas"
    | "managers"
    | "titles"
    | "coverage"
    | "frequency"
    | "amRate"
    | "pmRate"
    | "flags",
  value: string,
): KpiFilterState {
  const current = filters[facet] as string[];
  const next = current.includes(value) ? current.filter((entry) => entry !== value) : [...current, value];
  return { ...filters, [facet]: next } as KpiFilterState;
}

/**
 * The state a column header should move to when it is clicked.
 *
 * Clicking a NEW column starts descending for every numeric measure and ascending for the three
 * text ones. That is not a stylistic choice: a manager clicking "Coverage" is looking for the best
 * or the worst, and ascending-first would open on the reps with no measurable plan parked at the
 * bottom and 0% at the top — technically an answer, never the question. Clicking the column that is
 * already sorted flips it.
 */
export function nextKpiSort(filters: KpiFilterState, field: KpiSortField): KpiFilterState {
  const textual = field === "rep" || field === "line" || field === "area" || field === "manager";
  if (filters.sort === field) {
    return { ...filters, direction: filters.direction === "asc" ? "desc" : "asc" };
  }
  return { ...filters, sort: field, direction: textual ? "asc" : "desc" };
}

// ── Applying ──────────────────────────────────────────────────────────────────────────────────

/** Case- and space-insensitive compare, so "Anti Infective" from a URL matches the stored name. */
function normalizeFacet(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

/**
 * "Reports to" keeps a rep under ANY manager chosen on his chain — his district manager, the
 * regional manager above him, the national sales manager above that. Matching the direct manager
 * alone meant a National Sales Manager could never be found on this board (owner, 2026-10-20).
 */
function matchesManagerFacet(selected: string[], row: KpiFilterableRow): boolean {
  if (selected.length === 0) return true;
  if (matchesFacet(selected, row.managerName)) return true;
  return (row.managersAbove ?? []).some((name) => normalizeFacet(name) !== "" && matchesFacet(selected, name));
}

/** The "Reports to" options: each rep counted under his direct manager AND every manager above. */
export function buildKpiManagerFacet(rows: readonly KpiFilterableRow[]): KpiFacetOption[] {
  const counts = new Map<string, { label: string; count: number }>();
  const add = (value: string, label: string) => {
    const existing = counts.get(value);
    if (existing) existing.count += 1;
    else counts.set(value, { label, count: 1 });
  };
  for (const row of rows) {
    const direct = row.managerName?.trim() ?? "";
    if (!direct) {
      add(UNASSIGNED_FACET_KEY, UNASSIGNED_FACET_LABEL);
      continue;
    }
    const names = new Set<string>([direct]);
    for (const above of row.managersAbove ?? []) {
      const name = above?.trim();
      if (name) names.add(name);
    }
    for (const name of names) add(name, name);
  }
  return Array.from(counts, ([value, entry]) => ({ value, label: entry.label, count: entry.count })).sort(
    (left, right) => {
      if (left.value === UNASSIGNED_FACET_KEY) return 1;
      if (right.value === UNASSIGNED_FACET_KEY) return -1;
      return left.label.localeCompare(right.label);
    },
  );
}

function matchesFacet(selected: string[], value: string | null): boolean {
  if (selected.length === 0) return true;
  const target = normalizeFacet(value);
  // An explicit "(none)" selection is how a manager asks for the rows whose line or area never
  // resolved — the population most likely to be a data defect, and invisible without this.
  return selected.some((choice) =>
    normalizeFacet(choice) === UNASSIGNED_FACET_KEY ? target === "" : normalizeFacet(choice) === target,
  );
}

/** The value a facet uses for "this row has no such value". */
export const UNASSIGNED_FACET_KEY = "(none)";
export const UNASSIGNED_FACET_LABEL = "Not recorded";

function matchesQuery(row: KpiFilterableRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const haystack = [row.repName, row.lineName, row.regionName, row.areaName, row.managerName, row.jobTitle]
    .filter((part): part is string => Boolean(part))
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/**
 * Filters and sorts. Facets are AND-ed across dimensions and OR-ed within one — the behaviour every
 * filter panel has, and the only one that lets "Pedia AND (Giza OR Cairo)" be expressed at all.
 *
 * Flags are OR-ed too, deliberately: a manager ticking "never reached" and "logged no calls" is
 * asking to see everyone in trouble, not the (usually empty) intersection of both.
 */
export function applyKpiFilters<T extends KpiFilterableRow>(rows: readonly T[], filters: KpiFilterState): T[] {
  const filtered = rows.filter((row) => {
    if (!matchesFacet(filters.lines, row.lineName)) return false;
    if (!matchesFacet(filters.regions, row.regionName)) return false;
    if (!matchesFacet(filters.areas, row.areaName)) return false;
    if (!matchesManagerFacet(filters.managers, row)) return false;
    if (!matchesFacet(filters.titles, row.jobTitle)) return false;
    if (filters.coverage.length > 0 && !filters.coverage.includes(coverageBandOf(row))) return false;
    if (filters.frequency.length > 0 && !filters.frequency.includes(frequencyBandOf(row))) return false;
    if (filters.amRate.length > 0 && !filters.amRate.includes(amBandOf(row))) return false;
    if (filters.pmRate.length > 0 && !filters.pmRate.includes(pmBandOf(row))) return false;
    if (filters.flags.length > 0) {
      const rowFlags = kpiFlagsOf(row);
      if (!filters.flags.some((flag) => rowFlags.includes(flag))) return false;
    }
    if (!matchesKpiRanges(row, filters.ranges)) return false;
    if (!matchesQuery(row, filters.query)) return false;
    return true;
  });

  return sortKpiRows(filtered, filters.sort, filters.direction);
}

/**
 * A MANAGER row as the filter engine reads it — crm/kpis-manager-rows.ts's `KpiManagerRow`
 * satisfies it structurally (owner, 2026-10-20: "add manager row"). Described here rather than
 * imported, for the same bundle reason as {@link KpiFilterableRow}.
 */
export type KpiManagerFilterableRow = {
  /** The manager himself. */
  name: string;
  jobTitle: string | null;
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
  /** His own manager's name. */
  reportsTo: string | null;
  /** The managers above `reportsTo`, nearest first. */
  managersAbove: readonly string[];
};

/**
 * Line, region, area and job title narrow a manager row by HIS OWN record, but only where that
 * record HAS the field: a National Sales Manager whose record names no area is not hidden by an area
 * filter he has nothing to be compared on. Where the field is recorded it must match, exactly as on
 * a rep row.
 */
function matchesWhereRecorded(selected: string[], value: string | null): boolean {
  if (selected.length === 0 || normalizeFacet(value) === "") return true;
  return matchesFacet(selected, value);
}

/**
 * "Reports to" keeps the chosen manager's OWN row and every manager row beneath him — the same reach
 * it gives the rep rows. "Not recorded" asks for the reps whose manager is not on file, and no
 * manager row is built from those, so it keeps none.
 */
function matchesManagerRowFacet(selected: string[], row: KpiManagerFilterableRow): boolean {
  if (selected.length === 0) return true;
  const chosen = selected.map(normalizeFacet).filter((choice) => choice !== "" && choice !== UNASSIGNED_FACET_KEY);
  return [row.name, row.reportsTo, ...row.managersAbove].some((name) => {
    const target = normalizeFacet(name);
    return target !== "" && chosen.includes(target);
  });
}

/**
 * Narrows the manager rows by the SAME filter state as the rep rows. They are built from the scoped
 * rep rows before any filter, so a manager's averages never change with a filter; a filter only
 * decides which manager rows are shown. The bands, flags and ranges judge one rep's own work and are
 * not applied here; the order is the tree order the rows were built in, whatever the rep sort.
 */
export function applyKpiManagerFilters<T extends KpiManagerFilterableRow>(rows: readonly T[], filters: KpiFilterState): T[] {
  const needle = filters.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (!matchesWhereRecorded(filters.lines, row.lineName)) return false;
    if (!matchesWhereRecorded(filters.regions, row.regionName)) return false;
    if (!matchesWhereRecorded(filters.areas, row.areaName)) return false;
    if (!matchesWhereRecorded(filters.titles, row.jobTitle)) return false;
    if (!matchesManagerRowFacet(filters.managers, row)) return false;
    if (needle) {
      const haystack = [row.name, row.jobTitle, row.lineName, row.regionName, row.areaName, row.reportsTo]
        .filter((part): part is string => Boolean(part))
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });
}

/** Sorts a copy. Nulls park last in BOTH directions — see the note on `sortKey`. */
export function sortKpiRows<T extends KpiFilterableRow>(
  rows: readonly T[],
  field: KpiSortField,
  direction: KpiSortDirection,
): T[] {
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((left, right) => {
    const a = sortKey(left, field);
    const b = sortKey(right, field);
    if (a == null && b == null) return left.repName.localeCompare(right.repName);
    if (a == null) return 1;
    if (b == null) return -1;
    if (typeof a === "string" || typeof b === "string") {
      const compared = String(a).localeCompare(String(b));
      return compared !== 0 ? compared * sign : left.repName.localeCompare(right.repName);
    }
    if (a === b) return left.repName.localeCompare(right.repName);
    return (a < b ? -1 : 1) * sign;
  });
}

// ── Facets ────────────────────────────────────────────────────────────────────────────────────

export type KpiFacetOption = { value: string; label: string; count: number };

/**
 * Builds one facet's options from the rows the viewer can actually see.
 *
 * Options come from the DATA, never from a fixed list. A District Manager filtering by area is
 * offered his own three areas, not the company's ninety — offering a choice that returns an empty
 * board is worse than not offering it, because an empty board reads as "nobody did anything".
 *
 * Counts are computed against the rows passed in, so the panel can say "Giza 6" rather than making
 * a manager click to find out whether the filter is worth applying.
 */
export function buildKpiFacet(
  rows: readonly KpiFilterableRow[],
  pick: (row: KpiFilterableRow) => string | null,
): KpiFacetOption[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const row of rows) {
    const raw = pick(row)?.trim() ?? "";
    const value = raw || UNASSIGNED_FACET_KEY;
    const label = raw || UNASSIGNED_FACET_LABEL;
    const existing = counts.get(value);
    if (existing) existing.count += 1;
    else counts.set(value, { label, count: 1 });
  }
  return Array.from(counts, ([value, entry]) => ({ value, label: entry.label, count: entry.count })).sort(
    (left, right) => {
      // "Not recorded" always sits last: it is a data-quality bucket, not a place.
      if (left.value === UNASSIGNED_FACET_KEY) return 1;
      if (right.value === UNASSIGNED_FACET_KEY) return -1;
      return left.label.localeCompare(right.label);
    },
  );
}

export type KpiFacets = {
  lines: KpiFacetOption[];
  regions: KpiFacetOption[];
  areas: KpiFacetOption[];
  managers: KpiFacetOption[];
  titles: KpiFacetOption[];
  coverage: KpiFacetOption[];
  frequency: KpiFacetOption[];
  amRate: KpiFacetOption[];
  pmRate: KpiFacetOption[];
  flags: KpiFacetOption[];
};

function bandFacet(rows: readonly KpiFilterableRow[], band: (row: KpiFilterableRow) => KpiBand): KpiFacetOption[] {
  const counts = new Map<KpiBand, number>();
  for (const row of rows) {
    const value = band(row);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  // Bands render in their own fixed order — worst-to-best would be a different statement each time
  // the data moved — and a band nobody is in is dropped rather than shown as a dead zero.
  return KPI_BANDS.filter((value) => (counts.get(value) ?? 0) > 0).map((value) => ({
    value,
    label: KPI_BAND_LABEL[value],
    count: counts.get(value) ?? 0,
  }));
}

/** Every facet, counted against the UNFILTERED scoped rows. */
export function buildKpiFacets(rows: readonly KpiFilterableRow[]): KpiFacets {
  const flagCounts = new Map<KpiFlag, number>();
  for (const row of rows) {
    for (const flag of kpiFlagsOf(row)) flagCounts.set(flag, (flagCounts.get(flag) ?? 0) + 1);
  }

  return {
    lines: buildKpiFacet(rows, (row) => row.lineName),
    regions: buildKpiFacet(rows, (row) => row.regionName),
    areas: buildKpiFacet(rows, (row) => row.areaName),
    managers: buildKpiManagerFacet(rows),
    titles: buildKpiFacet(rows, (row) => row.jobTitle),
    coverage: bandFacet(rows, coverageBandOf),
    frequency: bandFacet(rows, frequencyBandOf),
    amRate: bandFacet(rows, amBandOf),
    pmRate: bandFacet(rows, pmBandOf),
    flags: KPI_FLAGS.filter((flag) => (flagCounts.get(flag) ?? 0) > 0).map((flag) => ({
      value: flag,
      label: KPI_FLAG_LABEL[flag],
      count: flagCounts.get(flag) ?? 0,
    })),
  };
}

// MEDICAL REPS ONLY lives in crm/medical-rep.ts — `keepMedicalRepsOnly`, called by
// crm/kpis-board.ts at the source. It used to live here as a second implementation of a rule the
// Reps Plans board already owned; the two agreed on every live row and disagreed on one branch.
// Do not reintroduce a copy: this file's no-imports rule is about SERVER modules, and medical-rep.ts
// imports nothing at all, so there is no bundle reason to have a local one.
//
// It still decides the REP rows, and so every facet, count, band, total and podium above. Managers
// reach the board since 2026-10-20 (owner: "add manager row") as a SEPARATE list of averages —
// crm/kpis-manager-rows.ts, `board.managers` — filtered by `applyKpiManagerFilters` and never mixed
// into the rep rows or anything counted from them.

// ─────────────────────────────────────────────────────────────────────────────
// WHEN A PERCENTAGE IS A POSITION AND NOT YET A SCORE.
//
// Coverage is doctors reached over doctors planned; frequency is doctors seen
// the right number of times over doctors due. Both climb through a month as the
// list is worked, so both are structurally low at the start of one — and a low
// number under a confident sentence reads as a verdict on the team.
//
// Measured on production 2026-09-03, two working days into September:
//
//     Sep 1–2, first two working days     40.2% coverage
//     Aug 1–2, first two working days     40.1% coverage
//     August, whole closed month          71.4% coverage
//
// The team was performing within a tenth of a point of the previous month at the
// same point in it. The board nonetheless headlined "Most of the planned list
// has not been reached at all yet", because 39% is below the Behind threshold.
// The arithmetic was right; the sentence was an accusation the data could not
// support, and it would have been read by every manager on the board.
//
// The figures are never suppressed — the tiles and tables show every number.
// What this gates is the JUDGEMENT, which is the only part that was wrong.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The share of a window that must be worked before its percentages are judged.
 *
 * A THIRD rather than a fixed number of days, because windows differ: a third of
 * a 22-day month is seven days and a third of a five-day week is under two, and
 * each is roughly the point past which a shortfall stops being explicable by the
 * calendar alone.
 */
export const KPI_VERDICT_THRESHOLD = 1 / 3;

/**
 * The Period select's value for "a range I typed", as opposed to a month or one of its week blocks.
 *
 * It never reaches `repsPlansRange` — the picker switches into a mode on it and then navigates on
 * the real `from..to` key. A stray `?period=custom` in a hand-edited URL matches neither the range
 * pattern nor `w[1-5]`, so it falls through to the whole month, which is the right answer for a
 * period nobody finished choosing.
 */
export const KPI_CUSTOM_PERIOD_VALUE = "custom";

/**
 * Has too little of the window been worked for its percentages to mean anything?
 *
 * Both arguments are working-day counts: how many have been worked, and how many
 * the window contains. Zero worked is NOT "too early" — that is a window with no
 * data at all, which the board already answers separately and must not relabel.
 */
export function isTooEarlyToScore(workingDays: number, workingDaysInWindow: number): boolean {
  if (workingDaysInWindow <= 0 || workingDays <= 0) return false;
  return workingDays / workingDaysInWindow < KPI_VERDICT_THRESHOLD;
}

/** A rep too new to judge, and how far in she is. */
export type KpiJustStarted = {
  /** Her own working days in the scored window — hire date onward, holidays removed. */
  workingDaysIn: number;
};

/**
 * A REP HIRED INSIDE THE WINDOW IS NOT JUDGED UNTIL SHE HAS WORKED A THIRD OF IT (owner, 2026-10-26:
 * a rep two working days in read "Never reached a planned doctor", "Logged no calls at all", "Below
 * floor" and a 0% overall). The same bar the board already holds the whole team to —
 * {@link KPI_VERDICT_THRESHOLD} of the window's working days, through {@link isTooEarlyToScore} —
 * applied to HER days, never a second number.
 *
 * Only for a hire date AFTER the window's first day: a rep employed from the start shares the team's
 * calendar and is the team gate's business. Zero days in is just started too — hired today, or on a
 * Thursday — where `isTooEarlyToScore` deliberately answers false for the team's "no data at all".
 */
export function kpiJustStartedOf(input: {
  hireDate: string | null | undefined;
  dateFrom: string;
  /** Her own working days through the call-rate window's end. */
  workingDaysIn: number;
  /** The working days the whole window holds. */
  workingDaysInWindow: number;
}): KpiJustStarted | null {
  const hire = input.hireDate?.slice(0, 10) ?? null;
  if (!hire || hire <= input.dateFrom || input.workingDaysInWindow <= 0) return null;
  const days = Math.max(0, input.workingDaysIn);
  if (days > 0 && !isTooEarlyToScore(days, input.workingDaysInWindow)) return null;
  return { workingDaysIn: days };
}
