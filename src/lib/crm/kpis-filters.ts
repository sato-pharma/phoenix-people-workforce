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
 * So this file imports NOTHING. The row it filters is described structurally (`KpiFilterableRow`)
 * rather than imported from the board, which also means the whole engine is fixture-testable with
 * no database anywhere near it.
 *
 * ## It adds no fourth KPI
 *
 * kpis-board.ts is explicit that the board "assembles the measures that were already right and adds
 * no fourth one". Nothing here invents a composite score. The bands are the SAME three measures cut
 * into ranges, and `callRateAttainmentPct` is the call rate expressed against the call rate's own
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

/** A rep row as the filter engine reads it. `KpiRepRow` satisfies this structurally. */
export type KpiFilterableRow = {
  repName: string;
  lineName: string | null;
  regionName: string | null;
  areaName: string | null;
  managerName: string | null;
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
  /** Verified calls as a percentage of what the AM+PM targets asked for. Null with no working days. */
  callRateAttainmentPct: number | null;

  plannedDoctors: number;
  /** The coverage denominator: doctors due by today, plus any seen early. Equals `plannedDoctors`
   * once the month is complete. */
  coverageDueDoctors: number;
  visitedDoctors: number;
  /** Planned doctors with no visit this month, DUE OR NOT. Bigger than the coverage shortfall
   * mid-month, and the board labels the two differently for exactly that reason. */
  missedDoctors: number;
  coveragePct: number;
  onPlanDoctors: number;
  underDoctors: number;
  overDoctors: number;
  notDueDoctors: number;
  frequencyPct: number;
  hasMeasurablePlan: boolean;
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
  return kpiBandOf(row.hasMeasurablePlan ? row.coveragePct : null);
}

/** Frequency band for a row, honouring `hasMeasurablePlan`. */
export function frequencyBandOf(row: KpiFilterableRow): KpiBand {
  return kpiBandOf(row.hasMeasurablePlan ? row.frequencyPct : null);
}

/**
 * Call-rate band, on attainment against the AM+PM targets.
 *
 * A rep who logged NOTHING is `noplan`, not `behind`: `hasCallRate` false means the CRM has no row
 * for him in this window at all, which can be leave, a sync gap or a genuinely idle month. Reading
 * "Behind" onto an absence would state as fact the one thing the data cannot tell you.
 */
export function callRateBandOf(row: KpiFilterableRow): KpiBand {
  if (!row.hasCallRate || row.callRateAttainmentPct == null) return "noplan";
  return kpiBandOf(row.callRateAttainmentPct);
}

// ── Flags ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The situations a manager actually goes looking for. Each is derived from fields already on the
 * row — no flag asks a question the board cannot answer from what it already fetched.
 */
export const KPI_FLAGS = [
  "never-reached",
  "no-calls",
  "no-plan",
  "campaign-heavy",
  "campaign-only-days",
  "under-visiting",
  "over-visiting",
  "below-target",
  "perfect-frequency",
] as const;

export type KpiFlag = (typeof KPI_FLAGS)[number];

export const KPI_FLAG_LABEL: Record<KpiFlag, string> = {
  "never-reached": "Never reached a planned doctor",
  "no-calls": "Logged no calls at all",
  "no-plan": "Carries no plan",
  "campaign-heavy": "Half or more of calls were campaign",
  "campaign-only-days": "Had campaign-only days",
  "under-visiting": "More below-plan doctors than above",
  "over-visiting": "Visited someone more than planned",
  "below-target": "Under the call-rate target",
  "perfect-frequency": "Every due doctor exactly on plan",
};

/** One line saying what the flag is FOR, shown under the label in the filter panel. */
export const KPI_FLAG_HINT: Record<KpiFlag, string> = {
  "never-reached": "Has planned doctors and visited none of them. The most urgent row on the board.",
  "no-calls": "No CRM row in this window — could be leave, a sync gap, or an idle period.",
  "no-plan": "Nothing was planned, so coverage and frequency have no denominator.",
  "campaign-heavy": "Campaign calls name no doctor, so this share of the work cannot be verified.",
  "campaign-only-days": "Days with campaign calls and not one verified visit.",
  "under-visiting": "Short of the plan more often than over it.",
  "over-visiting": "Over-visiting is a deviation, not a win — the owner's rule.",
  "below-target": "Verified calls came in under what the AM and PM targets asked for.",
  "perfect-frequency": "100% frequency. Exact is the only pass, so this is the real thing.",
};

/** Every flag that is true of this row. */
export function kpiFlagsOf(row: KpiFilterableRow): KpiFlag[] {
  const flags: KpiFlag[] = [];
  if (row.hasMeasurablePlan && row.visitedDoctors === 0) flags.push("never-reached");
  if (!row.hasCallRate || row.totalCalls === 0) flags.push("no-calls");
  if (!row.hasMeasurablePlan) flags.push("no-plan");
  if (row.campaignShare >= 0.5 && row.campaignCalls > 0) flags.push("campaign-heavy");
  if (row.campaignOnlyDays > 0) flags.push("campaign-only-days");
  if (row.underDoctors > 0 && row.underDoctors > row.overDoctors) flags.push("under-visiting");
  if (row.overDoctors > 0) flags.push("over-visiting");
  if (row.hasCallRate && row.callRateAttainmentPct != null && row.callRateAttainmentPct < 100) {
    flags.push("below-target");
  }
  if (row.hasMeasurablePlan && row.frequencyPct === 100) flags.push("perfect-frequency");
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
  "callrate",
  "am",
  "pm",
  "planned",
  "visited",
  "missed",
  "exact",
  "below",
  "above",
  "notdue",
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
  callrate: "Call-rate attainment",
  am: "AM rate",
  pm: "PM rate",
  planned: "Planned doctors",
  visited: "Covered doctors",
  missed: "Not reached",
  exact: "Exact",
  below: "Below",
  above: "Above",
  notdue: "Not due",
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
    case "callrate":
      return row.hasCallRate ? row.callRateAttainmentPct : null;
    case "am":
      return row.amRate;
    case "pm":
      return row.pmRate;
    case "planned":
      return row.plannedDoctors;
    case "visited":
      return row.visitedDoctors;
    case "missed":
      // The shortfall against the DUE list, not against the whole month — the same denominator the
      // percentage beside it uses. Sorting on `missedDoctors` here would rank a rep by how much of
      // next fortnight's plan he has not reached yet, which is nobody's performance.
      return row.coverageDueDoctors - row.visitedDoctors;
    case "exact":
      return row.onPlanDoctors;
    case "below":
      return row.underDoctors;
    case "above":
      return row.overDoctors;
    case "notdue":
      return row.notDueDoctors;
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

// ── Filter state ──────────────────────────────────────────────────────────────────────────────

export type KpiFilterState = {
  lines: string[];
  regions: string[];
  areas: string[];
  managers: string[];
  titles: string[];
  coverage: KpiBand[];
  frequency: KpiBand[];
  callRate: KpiBand[];
  flags: KpiFlag[];
  /** Free text matched against the rep's name, area, line and manager. */
  query: string;
  sort: KpiSortField;
  direction: KpiSortDirection;
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
  callRate: "rate",
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
  callRate: [],
  flags: [],
  query: "",
  sort: "rep",
  direction: "asc",
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
    filters.callRate.length > 0 ||
    filters.flags.length > 0 ||
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
    filters.callRate.length +
    filters.flags.length +
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
    callRate: keepKnown(splitParam(read(KPI_FILTER_PARAMS.callRate)), KPI_BANDS),
    flags: keepKnown(splitParam(read(KPI_FILTER_PARAMS.flags)), KPI_FLAGS),
    query: (read(KPI_FILTER_PARAMS.query) ?? "").trim().slice(0, 120),
    sort: (KPI_SORT_FIELDS as readonly string[]).includes(sortRaw) ? (sortRaw as KpiSortField) : "rep",
    direction: directionRaw === "desc" ? "desc" : "asc",
  };
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
  put(KPI_FILTER_PARAMS.callRate, filters.callRate);
  put(KPI_FILTER_PARAMS.flags, filters.flags);
  if (filters.query.trim()) out[KPI_FILTER_PARAMS.query] = filters.query.trim();
  if (filters.sort !== "rep") out[KPI_FILTER_PARAMS.sort] = filters.sort;
  if (filters.direction !== "asc") out[KPI_FILTER_PARAMS.direction] = filters.direction;
  return out;
}

/**
 * The ONE place a KPIs URL is built — the server view's every link and the client filter bar's
 * every push come through here.
 *
 * Two builders would be two answers the first time either changed, and the symptom is specific and
 * nasty: a sort link that quietly drops the area filter puts a WIDER set of reps on screen than the
 * manager asked for, under a heading that still says the filter is on. Month and tab are the only
 * things any caller may set positionally; everything else rides in the filter state.
 */
export function buildKpisQuery(input: {
  month: string;
  /** The period KEY (`month`, `w1`…). Omitted from the URL when it is the whole month. */
  period: string;
  /** The active tab id. `summary` is the default and is omitted. */
  tab: string;
  filters: KpiFilterState;
}): string {
  const query = new URLSearchParams();
  query.set("month", input.month);
  if (input.period && input.period !== "month") query.set("period", input.period);
  if (input.tab && input.tab !== "summary") query.set("tab", input.tab);
  for (const [key, value] of Object.entries(kpiFiltersToParams(input.filters))) query.set(key, value);
  return query.toString();
}

/** Returns a copy of the state with one facet value toggled on or off. */
export function toggleKpiFacet(
  filters: KpiFilterState,
  facet: "lines" | "regions" | "areas" | "managers" | "titles" | "coverage" | "frequency" | "callRate" | "flags",
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
    if (!matchesFacet(filters.managers, row.managerName)) return false;
    if (!matchesFacet(filters.titles, row.jobTitle)) return false;
    if (filters.coverage.length > 0 && !filters.coverage.includes(coverageBandOf(row))) return false;
    if (filters.frequency.length > 0 && !filters.frequency.includes(frequencyBandOf(row))) return false;
    if (filters.callRate.length > 0 && !filters.callRate.includes(callRateBandOf(row))) return false;
    if (filters.flags.length > 0) {
      const rowFlags = kpiFlagsOf(row);
      if (!filters.flags.some((flag) => rowFlags.includes(flag))) return false;
    }
    if (!matchesQuery(row, filters.query)) return false;
    return true;
  });

  return sortKpiRows(filtered, filters.sort, filters.direction);
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
  callRate: KpiFacetOption[];
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
    managers: buildKpiFacet(rows, (row) => row.managerName),
    titles: buildKpiFacet(rows, (row) => row.jobTitle),
    coverage: bandFacet(rows, coverageBandOf),
    frequency: bandFacet(rows, frequencyBandOf),
    callRate: bandFacet(rows, callRateBandOf),
    flags: KPI_FLAGS.filter((flag) => (flagCounts.get(flag) ?? 0) > 0).map((flag) => ({
      value: flag,
      label: KPI_FLAG_LABEL[flag],
      count: flagCounts.get(flag) ?? 0,
    })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// WHO THE BOARD IS ABOUT — medical reps, and nobody else.
//
// Owner instruction, 2026-09-03: "only show medical reps in this page". Applied
// at the SOURCE rather than as a preselected filter chip, so every number on the
// page means the same thing: the denominator behind "Showing X of Y", the four
// gauge tiles, the three podiums and each tab's headline all count medical reps
// only. A default chip would have left the totals describing one population and
// the table another, which is the version of this that goes unnoticed.
//
// Measured on production the day it was applied, September 2026, Super Admin
// scope — the whole board was 70 rows:
//
//     Medical Representative    63   ← kept
//     District Sales Manager     6   ← dropped
//     Product Manager            1   ← dropped
//
// A manager and a rep are not comparable on these three measures. A DSM carries
// no doctor plan of his own, so he lands at "No plan" on coverage and frequency
// and drags the team averages toward a number that describes nobody; the single
// Product Manager is on the board only because he holds a CRM agent id at all.
//
// WHY AN UNRECORDED TITLE IS KEPT. Every one of the 70 rows above carried a
// title, so this branch changes nothing today — it exists for the row that
// arrives tomorrow. A CRM agent with no matching employee record has a null
// title, and dropping it would remove a working rep from his own manager's board
// with no error and no marker, which reads as "he covered nothing" rather than
// as a bug. Being visibly too generous is recoverable; being invisibly too
// strict is what costs a day. Such a row stays, and the Job title facet offers
// "Not recorded" so it can be found.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this job title a field medical rep?
 *
 * Substring rather than equality because the title is free text on the employee
 * record and both "Medical Rep" and "Medical Representative" are live in this
 * database — the two spellings that auto-provision the rep role. The `manager`
 * exclusion keeps a hypothetical "Medical Rep Manager" out; an acting district
 * manager is unaffected, because the owner's standing rule is that she keeps the
 * Medical Representative title and only her reps move.
 */
export function isMedicalRepTitle(jobTitle: string | null | undefined): boolean {
  const title = (jobTitle ?? "").trim().toLowerCase();
  if (!title) return true; // Unrecorded — see the block above. Deliberately kept.
  if (title.includes("manager")) return false;
  return title.includes("medical rep");
}

/** Narrow a scoped row set to the medical reps, before facets or totals are built. */
export function keepMedicalRepsOnly<T extends KpiFilterableRow>(rows: readonly T[]): T[] {
  return rows.filter((row) => isMedicalRepTitle(row.jobTitle));
}

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
