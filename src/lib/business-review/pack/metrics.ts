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
  { id: "summary", label: "In one page", question: "What does the period say, in plain words?" },
  { id: "sales", label: "Sales", question: "Did it hit the number?" },
  { id: "origin", label: "Where the money came from", question: "Which bricks, which customers, which channel?" },
  { id: "activity", label: "Field activity", question: "What did the team actually do?" },
  { id: "link", label: "Work against results", question: "Did the work go where the money is?" },
  { id: "cost", label: "Cost", question: "What did it cost, and was it worth it?" },
  { id: "people", label: "People", question: "Who did it?" },
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
    hint: "The whole period in plain sentences, drawn from the sections that follow.",
    id: "review-summary",
    label: "The period in one page",
    levels: ALL,
    needsFieldLink: true,
  },

  // ── Sales ───────────────────────────────────────────────────────────────────
  {
    defaultAt: ALL,
    group: "sales",
    hint: "Sales in targeted months over target, the Monthly Closing's own rule.",
    id: "achievement",
    label: "Achievement",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "sales",
    hint: "The same, with vacant territories left out — what the people in post delivered.",
    id: "achievement-ex-vacant",
    label: "Achievement excluding vacant",
    levels: MANAGER,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "The money and the target it was measured against.",
    id: "sales-vs-target",
    label: "Sales against target",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "Achievement per include product.",
    id: "per-product",
    label: "Per product",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "sales",
    hint: "The same, rolled up to product family.",
    id: "per-family",
    label: "Per family",
    levels: MANAGER,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "Every figure month by month, so the shape of the window is visible.",
    id: "month-by-month",
    label: "Month by month",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "sales",
    hint: "The same span immediately before this one, where the data reaches back that far.",
    id: "vs-previous-window",
    label: "Against the previous window",
    levels: ALL,
  },
  {
    defaultAt: ["company"],
    group: "sales",
    hint: "The three lines side by side.",
    id: "line-comparison",
    label: "Line comparison",
    levels: ["company"],
  },

  // ── Where the money came from ───────────────────────────────────────────────
  {
    group: "origin",
    hint: "Across all the bricks, almost all, or one — and which.",
    id: "brick-spread",
    label: "Brick spread",
    levels: ALL,
    needsClosingDetail: true,
    defaultAt: ALL,
  },
  {
    group: "origin",
    hint: "Whether the bulk of it is one customer, and how few carry half.",
    id: "customer-concentration",
    label: "Customer concentration",
    levels: ALL,
    needsClosingDetail: true,
    defaultAt: ALL,
  },
  {
    group: "origin",
    hint: "Distributor, wholesaler or direct order.",
    id: "channel-split",
    label: "Channel split",
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
    hint: "Against each rep's own plan: doctors reached, doctors seen exactly as planned, and AM · PM · pharmacy visits a day — the CRM KPIs board's own figures.",
    id: "crm-kpis",
    label: "Coverage, frequency and call rate",
    levels: ALL,
    needsCrmKpis: true,
  },
  {
    defaultAt: ALL,
    group: "activity",
    hint: "AM · PM · Pharmacies, three figures apart — never a combined call rate.",
    id: "visits-split",
    label: "Visits",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "activity",
    hint: "Unique customers reached in each month. A union per month, never a sum across them.",
    id: "customers-per-month",
    label: "Customers per month",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "activity",
    hint: "What the list is made of: doctors, against pharmacies, hospitals and accounts.",
    id: "specialty-mix",
    label: "Specialty mix of the list",
    levels: MANAGER,
  },
  {
    defaultAt: ALL,
    group: "activity",
    // Counts from the visits alone. "Coverage" and "frequency" are the owner's two PLAN KPIs, so they
    // are the metric above's words, never this one's.
    hint: "Different customers each person visited, and the regular visits each got on average.",
    id: "coverage-frequency",
    label: "Customers reached",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "activity",
    hint: "Rides delivered and received.",
    id: "double-visits",
    label: "Double visits",
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
    hint: "Each brick's sales beside its class A doctors, how many were visited, and the visits it got.",
    id: "brick-work",
    label: "Bricks: doctors, visits and sales",
    levels: CLOSE_UP,
    needsClosingDetail: true,
    needsFieldLink: true,
  },
  {
    defaultAt: MANAGER,
    group: "link",
    hint: "Each area's achievement beside its class A doctors reached, field days and ride days.",
    id: "area-work",
    label: "Areas: doctors, visits and achievement",
    levels: MANAGER,
    needsFieldLink: true,
  },
  {
    defaultAt: CLOSE_UP,
    group: "link",
    hint: "Every class A doctor on the list with no visit in the period, by name, per brick.",
    id: "class-a-missed",
    label: "Class A doctors not visited",
    levels: CLOSE_UP,
    needsFieldLink: true,
  },
  {
    defaultAt: MANAGER,
    group: "link",
    hint: "Ride days per rep against his fair share: never ridden, rarely ridden, or most of the rides.",
    id: "dv-focus",
    label: "Double visits: who gets the manager's days",
    levels: MANAGER,
    needsFieldLink: true,
  },
  {
    defaultAt: ALL,
    group: "link",
    hint: "Direct orders for the area's pharmacies, in the month Finance booked them.",
    id: "direct-orders",
    label: "Direct orders",
    levels: ALL,
    needsFieldLink: true,
  },

  // ── Cost ────────────────────────────────────────────────────────────────────
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Committed marketing requests.",
    id: "marketing-committed",
    label: "Marketing",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Outstation claimed, and the part HR has signed off.",
    id: "outstation-claimed",
    label: "Outstation expenses",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Marketing plus outstation per point of achievement. Lower is better.",
    id: "spend-per-point",
    label: "Spend per point",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "What each area costs, read against whether its own sales are growing or falling.",
    id: "marketing-vs-trend",
    label: "Marketing against the trend",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Each marketing request beside the sales it has brought back so far, against the ten times its cost it must.",
    id: "requests-return",
    label: "Marketing requests and what they brought",
    levels: ALL,
    needsFieldLink: true,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Market awareness activities in the area: held, approved or still waiting.",
    id: "awareness",
    label: "Awareness activities",
    levels: ALL,
    needsFieldLink: true,
  },
  {
    defaultAt: ALL,
    group: "cost",
    hint: "Outstation claimed per field day and per visit, and spend per 1,000 EGP of sales.",
    id: "cost-to-serve",
    label: "What the field work cost",
    levels: ALL,
    needsFieldLink: true,
  },

  // ── People ──────────────────────────────────────────────────────────────────
  {
    defaultAt: ALL,
    group: "people",
    hint: "Each rep's activity beside the achievement of the area he stands in.",
    id: "rep-rows",
    label: "Rep by rep",
    levels: ALL,
  },
  {
    defaultAt: MANAGER,
    group: "people",
    hint: "Activity by job function — reps, district managers, product and training managers.",
    id: "role-activity",
    label: "By role",
    levels: MANAGER,
  },
  {
    defaultAt: MANAGER,
    group: "people",
    hint: "One row per rep: area achievement, class A doctors reached, field days, ride days and cost.",
    id: "team-scorecard",
    label: "The team at a glance",
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
