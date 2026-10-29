// The Sales Review pack — the metric catalogue.
//
// Owner, 2026-09-26: "instead of spending time doing a presentation for sales review, he has the
// option to choose what metrics he wants, and then press export, and Phoenix does for him a
// comprehensive perfect corporate professional presentation." This file is the list he chooses
// from, approved verbatim on the same day.
//
// ONE DEFINITION, THREE RENDERERS. The picker, the PDF and the workbook all read this catalogue.
// A metric that exists in only two of the three is exactly how a pack ends up with a slide the
// Excel cannot explain, so nothing here is duplicated in a renderer: a renderer may decide how to
// DRAW a metric and never whether it exists, what it is called, or who may see it.
//
// 🔴 EVERYTHING THIS SCOPE CAN ANSWER, TICKED BY DEFAULT (owner, 2026-09-28): "show his all data …
// as he filters, the pack is exported." Until then a fresh pack opened with a curated handful, and
// ten of these metrics were drawn by nothing at all — a medical rep's pack came out as five sections
// with every field KPI missing. Now `defaultAt` equals `levels` on every entry: the picker offers the
// whole catalogue the scope can answer and ticks all of it; a viewer unticks what he does not want.
// The FILTER still decides what the figures cover, and nothing here can widen a scope.
//
// A METRIC IS OFFERED ONLY WHERE IT CAN BE ANSWERED. A medical rep has no districts beneath him
// and a district manager has no line comparison, so `levels` is not decoration — it is what stops
// the picker offering a tick that would export an empty slide. `levelsFor` below is the only way
// to ask.

import type { ReviewLine } from "../service";

/**
 * How wide the pack's subject is. NOT the viewer's role — an acting district manager and a
 * district manager are both `district` here, which is the point.
 */
export type PackLevel = "company" | "line" | "district" | "rep";

export const PACK_LEVELS: readonly PackLevel[] = ["company", "line", "district", "rep"];

export type MetricGroupId = "summary" | "sales" | "origin" | "activity" | "link" | "cost" | "people";

export type MetricGroup = {
  id: MetricGroupId;
  label: string;
  /** The question this whole group answers, for the picker's section heading. */
  question: string;
};

export const METRIC_GROUPS: readonly MetricGroup[] = [
  { id: "summary", label: "Summary", question: "The whole period on one page, in plain words." },
  { id: "sales", label: "Sales vs Target", question: "Ach %, sales and target, straight from the Monthly Closing." },
  { id: "origin", label: "Where the sales came from", question: "By brick, by customer and by channel." },
  { id: "activity", label: "Field work (CRM)", question: "KPIs, visits and Double Visits." },
  { id: "link", label: "Field work vs sales", question: "Did the visits go where the sales are?" },
  { id: "cost", label: "Marketing and Outstation", question: "What was spent, and what it brought back." },
  { id: "people", label: "Team performance", question: "The MRs and DSMs, one by one." },
];

export type ReviewMetricId =
  | "review-summary"
  | "achievement"
  | "achievement-ex-vacant"
  | "sales-vs-target"
  | "per-product"
  | "per-family"
  | "month-by-month"
  | "vs-previous-window"
  | "line-comparison"
  | "brick-spread"
  | "customer-concentration"
  | "channel-split"
  | "visits-split"
  | "customers-per-month"
  | "specialty-mix"
  | "coverage-frequency"
  | "crm-kpis"
  | "double-visits"
  | "marketing-committed"
  | "outstation-claimed"
  | "spend-per-point"
  | "marketing-vs-trend"
  | "rep-rows"
  | "role-activity"
  | "brick-work"
  | "area-work"
  | "class-a-missed"
  | "dv-focus"
  | "direct-orders"
  | "requests-return"
  | "awareness"
  | "cost-to-serve"
  | "team-scorecard";

export type ReviewMetric = {
  id: ReviewMetricId;
  group: MetricGroupId;
  label: string;
  /** One line under the checkbox: what it answers, in plain words. */
  hint: string;
  /** The levels that can answer it. Never offered anywhere else. */
  levels: readonly PackLevel[];
  /**
   * True when it needs the Monthly Closing's customer-grain rows — a heavier load than the rest of
   * the page. The picker groups these so a viewer can see what he is asking for, and the loader
   * skips the whole read when none is ticked.
   */
  needsClosingDetail?: boolean;
  /**
   * True when it needs the linked field facts — the reps' CRM lists, their visits and ride days, and
   * the direct orders, marketing requests and awareness activities of the pack's own areas. Read at
   * export time for the viewer's scope only (sources/field-link.ts), and skipped when none is ticked.
   */
  needsFieldLink?: boolean;
  /**
   * True when it needs the CRM KPIs board's own rows — each rep's coverage and frequency against his
   * plan and his AM · PM · pharmacy call rate — one board per month of the window, read for the
   * viewer (sources/crm-kpis.ts), and skipped when none is ticked.
   */
  needsCrmKpis?: boolean;
  /**
   * The levels where this metric is TICKED in a fresh pack — not a single boolean, because a
   * company pack and a rep pack want different presentations out of the same catalogue. Empty
   * means opt-in everywhere.
   *
   * A pack of everything is not a presentation, and the three customer-grain metrics are the heavy
   * read, so they default on only at DISTRICT level, which is where "is he selling from one brick"
   * is actually actionable.
   */
  defaultAt: readonly PackLevel[];
};

const ALL: readonly PackLevel[] = PACK_LEVELS;
const MANAGER: readonly PackLevel[] = ["company", "line", "district"];
/** A territory small enough to be read brick by brick and doctor by doctor. */
const CLOSE_UP: readonly PackLevel[] = ["district", "rep"];

/**
 * The catalogue. Order is presentation order — a pack renders its metrics in this sequence
 * whatever order they were ticked, so two people exporting the same metrics get the same deck.
 */
export const REVIEW_METRICS: readonly ReviewMetric[] = [
  // ── In one page ─────────────────────────────────────────────────────────────
  //
  // Owner, 2026-10-01: "built on maturity level … a medical rep's BR must show all data but simple
  // and easy for him to understand." The pack opens on one page of plain sentences drawn from the
  // very sections that follow — his sales, his bricks, his class A doctors, who rode with him, what
  // his area's direct orders and requests brought, what it cost — so he reads his period before he
  // reads a table.
  {
    defaultAt: ALL,
    group: "summary",
    hint: "One page in plain words, drawn from every section you tick below.",
    id: "review-summary",
    label: "Review summary",
    levels: ALL,
    needsFieldLink: true,
  },

  // ── Sales ───────────────────────────────────────────────────────────────────
  {
    defaultAt: ALL,
    group: "sales",
    hint: "Sales ÷ target in the targeted months — the Monthly Closing rule.",
    id: "achievement",
    label: "Ach %",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "sales",
    hint: "The same Ach % with vacant areas left out — what the team in post delivered.",
    id: "achievement-ex-vacant",
    label: "Ach % without vacant areas",
    levels: MANAGER,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "Sales value beside its target, in EGP.",
    id: "sales-vs-target",
    label: "Sales vs Target (EGP)",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "One row per include product.",
    id: "per-product",
    label: "Ach % by product",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "sales",
    hint: "The same, grouped by product family.",
    id: "per-family",
    label: "Ach % by family",
    levels: MANAGER,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "Sales, target and Ach % for each month of the period.",
    id: "month-by-month",
    label: "Month by month",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "The same number of months just before this period, where the data goes back that far.",
    id: "vs-previous-window",
    label: "Vs the previous period",
    levels: ALL,
  },
  {
    defaultAt: ["company"],
    group: "sales",
    hint: "The three lines side by side.",
    id: "line-comparison",
    label: "CNS · Anti Infective · Pedia",
    levels: ["company"],
  },

  // ── Where the money came from ───────────────────────────────────────────────
  {
    group: "origin",
    hint: "How many bricks carry the sales, and which bricks lead.",
    id: "brick-spread",
    label: "Sales by brick",
    levels: ALL,
    needsClosingDetail: true,
    defaultAt: ALL,
  },
  {
    group: "origin",
    hint: "How much of the sales sits with the biggest customers.",
    id: "customer-concentration",
    label: "Top customers",
    levels: ALL,
    needsClosingDetail: true,
    defaultAt: ALL,
  },
  {
    group: "origin",
    hint: "Distributor, store or direct order.",
    id: "channel-split",
    label: "Sales by channel",
    levels: ALL,
    needsClosingDetail: true,
    defaultAt: ALL,
  },

  // ── Field activity ──────────────────────────────────────────────────────────
  //
  // The CRM's own KPIs first (owner, 2026-10-01: "add all three"): each rep against HIS plan, and his
  // call rate, AM against 2 a day and PM against 10 — apart, never averaged. Read from the CRM KPIs
  // board itself, so a figure here is the figure that board prints for the same rep and month.
  {
    defaultAt: ALL,
    group: "activity",
    hint: "Each MR against their own plan, exactly as the KPIs board shows it. Call Rate is AM · PM · Pharmacies, apart.",
    id: "crm-kpis",
    label: "KPIs — Coverage, Frequency, Call Rate",
    levels: ALL,
    needsCrmKpis: true,
  },
  {
    defaultAt: ALL,
    group: "activity",
    hint: "Three counts, always apart — never added into one.",
    id: "visits-split",
    label: "Visits — AM · PM · Pharmacies",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "activity",
    hint: "Different customers seen in each month.",
    id: "customers-per-month",
    label: "Customers visited per month",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "activity",
    hint: "What the CRM list is made of: doctors, pharmacies, hospitals and accounts.",
    id: "specialty-mix",
    label: "List by specialty",
    levels: MANAGER,
  },
  {
    defaultAt: ALL,
    group: "activity",
    // Counts from the visits alone. "Coverage" and "frequency" are the owner's two PLAN KPIs, so they
    // are the metric above's words, never this one's.
    hint: "Different customers each person visited, and their average regular visits.",
    id: "coverage-frequency",
    label: "Customers reached",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "activity",
    hint: "Double Visits made by the managers and received by the MRs.",
    id: "double-visits",
    label: "Double Visits",
    levels: ALL,
  },

  // ── Work against results (owner, 2026-10-01) ────────────────────────────────
  //
  // "Every brick contains how many class A doctors and I visit how many, versus this area or brick
  // sales … if a DM over-focused some MRs in double visits and forgot others." The CRM list, the
  // visits, the rides and the Monthly Closing's own brick sales, laid side by side.
  {
    defaultAt: CLOSE_UP,
    group: "link",
    hint: "Each brick's sales beside its Class A doctors, how many were visited, and how many visits it got.",
    id: "brick-work",
    label: "Each brick: Class A doctors, visits and sales",
    levels: CLOSE_UP,
    needsClosingDetail: true,
    needsFieldLink: true,
  },
  {
    defaultAt: MANAGER,
    group: "link",
    hint: "Each area's Ach % beside Class A doctors reached, field days and DV days.",
    id: "area-work",
    label: "Each area: Class A doctors, field days and Ach %",
    levels: MANAGER,
    needsFieldLink: true,
  },
  {
    defaultAt: CLOSE_UP,
    group: "link",
    hint: "Every Class A doctor with no visit in the period, by name, brick by brick.",
    id: "class-a-missed",
    label: "Class A doctors not visited",
    levels: CLOSE_UP,
    needsFieldLink: true,
  },
  {
    defaultAt: MANAGER,
    group: "link",
    hint: "Who got the manager's DV days: never visited with, rarely, or most of the days.",
    id: "dv-focus",
    label: "Double Visit share per MR",
    levels: MANAGER,
    needsFieldLink: true,
  },
  {
    defaultAt: ALL,
    group: "link",
    hint: "Direct orders for the area's pharmacies, in the month Finance booked them.",
    id: "direct-orders",
    label: "Direct Orders",
    levels: ALL,
    needsFieldLink: true,
  },

  // ── Cost ────────────────────────────────────────────────────────────────────
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Committed marketing requests and their value.",
    id: "marketing-committed",
    label: "Marketing Requests",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Outstation claimed, and the part HR approved.",
    id: "outstation-claimed",
    label: "Outstation Expenses",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Marketing + outstation for each point of Ach %. Lower is better.",
    id: "spend-per-point",
    label: "Cost per 1% Ach",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Each area's spend beside whether its sales are growing or falling.",
    id: "marketing-vs-trend",
    label: "Marketing vs the sales trend",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Each marketing request beside the sales it has brought back so far — the target is 10× its cost.",
    id: "requests-return",
    label: "Marketing ROI",
    levels: ALL,
    needsFieldLink: true,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Market Awareness activities in the area: done, approved or still waiting.",
    id: "awareness",
    label: "Market Awareness",
    levels: ALL,
    needsFieldLink: true,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Outstation per field day and per visit, and per 1,000 EGP of sales.",
    id: "cost-to-serve",
    label: "Outstation per field day",
    levels: ALL,
    needsFieldLink: true,
  },

  // ── People ──────────────────────────────────────────────────────────────────
  {
    defaultAt: ALL,
    group: "people",
    hint: "Each MR's field work beside the Ach % of their area.",
    id: "rep-rows",
    label: "MRs one by one",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "people",
    hint: "Field work by job title — MRs, DSMs, product managers and training managers.",
    id: "role-activity",
    label: "By job title",
    levels: MANAGER,
  },
  {
    defaultAt: MANAGER,
    group: "people",
    hint: "One row per MR: area Ach %, Class A doctors reached, field days, DV days and cost.",
    id: "team-scorecard",
    label: "Team scorecard",
    levels: MANAGER,
    needsFieldLink: true,
  },
];

const BY_ID = new Map<ReviewMetricId, ReviewMetric>(REVIEW_METRICS.map((m) => [m.id, m]));

export function metricById(id: ReviewMetricId): ReviewMetric | undefined {
  return BY_ID.get(id);
}

/** Every metric this level can actually answer, in presentation order. */
export function metricsForLevel(level: PackLevel): ReviewMetric[] {
  return REVIEW_METRICS.filter((m) => m.levels.includes(level));
}

/** The ticks a fresh pack opens with at this level. */
export function defaultSelectionFor(level: PackLevel): ReviewMetricId[] {
  return metricsForLevel(level)
    .filter((m) => m.defaultAt.includes(level))
    .map((m) => m.id);
}

/**
 * Narrow a requested selection to what this level can answer, preserving catalogue order.
 *
 * A pack is addressable by URL, so a district manager can be handed a link built at company level.
 * Dropping what he cannot answer is the only safe reading — rendering an empty Line comparison
 * slide would tell him his line has no data, which is a different and untrue statement.
 */
export function narrowSelection(
  requested: readonly string[],
  level: PackLevel,
): ReviewMetricId[] {
  const wanted = new Set(requested);
  return metricsForLevel(level)
    .filter((m) => wanted.has(m.id))
    .map((m) => m.id);
}

/** True when any chosen metric needs the closing's customer-grain rows. */
export function needsClosingDetail(selection: readonly ReviewMetricId[]): boolean {
  return selection.some((id) => BY_ID.get(id)?.needsClosingDetail === true);
}

/** True when any chosen metric needs the linked field facts (lists, visits, rides, orders). */
export function needsFieldLink(selection: readonly ReviewMetricId[]): boolean {
  return selection.some((id) => BY_ID.get(id)?.needsFieldLink === true);
}

/** True when any chosen metric needs the CRM KPIs board's rows (plan coverage, frequency, call rate). */
export function needsCrmKpis(selection: readonly ReviewMetricId[]): boolean {
  return selection.some((id) => BY_ID.get(id)?.needsCrmKpis === true);
}

/** What the pack is about, for its cover: "Pedia line", "Cairo district", "All company". */
export type PackSubject = {
  level: PackLevel;
  /** The subject's own name — a district manager's name, a line's label, an area. */
  title: string;
  /** The line it sits on, where there is exactly one. */
  line: ReviewLine | null;
  /** The window every figure answers, already resolved to the FIGURE window. */
  windowLabel: string;
};
