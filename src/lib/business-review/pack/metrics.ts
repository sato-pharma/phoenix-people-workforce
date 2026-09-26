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

export type MetricGroupId = "sales" | "origin" | "activity" | "cost" | "people";

export type MetricGroup = {
  id: MetricGroupId;
  label: string;
  /** The question this whole group answers, for the picker's section heading. */
  question: string;
};

export const METRIC_GROUPS: readonly MetricGroup[] = [
  { id: "sales", label: "Sales", question: "Did it hit the number?" },
  { id: "origin", label: "Where the money came from", question: "Which bricks, which customers, which channel?" },
  { id: "activity", label: "Field activity", question: "What did the team actually do?" },
  { id: "cost", label: "Cost", question: "What did it cost, and was it worth it?" },
  { id: "people", label: "People", question: "Who did it?" },
];

export type ReviewMetricId =
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
  | "double-visits"
  | "marketing-committed"
  | "outstation-claimed"
  | "spend-per-point"
  | "marketing-vs-trend"
  | "rep-rows"
  | "role-activity";

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

/**
 * The catalogue. Order is presentation order — a pack renders its metrics in this sequence
 * whatever order they were ticked, so two people exporting the same metrics get the same deck.
 */
export const REVIEW_METRICS: readonly ReviewMetric[] = [
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
    defaultAt: [],
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
    defaultAt: [],
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
    defaultAt: MANAGER,
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
    defaultAt: ["district"],
  },
  {
    group: "origin",
    hint: "Whether the bulk of it is one customer, and how few carry half.",
    id: "customer-concentration",
    label: "Customer concentration",
    levels: ALL,
    needsClosingDetail: true,
    defaultAt: ["district"],
  },
  {
    group: "origin",
    hint: "Distributor, wholesaler or direct order.",
    id: "channel-split",
    label: "Channel split",
    levels: ALL,
    needsClosingDetail: true,
    defaultAt: ["district"],
  },

  // ── Field activity ──────────────────────────────────────────────────────────
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
    defaultAt: ALL,
    group: "activity",
    hint: "What the list is made of: doctors, against pharmacies, hospitals and accounts.",
    id: "specialty-mix",
    label: "Specialty mix of the list",
    levels: ALL,
  },
  {
    defaultAt: ALL,
    group: "activity",
    hint: "How much of the list was reached, and how often.",
    id: "coverage-frequency",
    label: "Coverage and frequency",
    levels: ALL,
  },
  {
    defaultAt: [],
    group: "activity",
    hint: "Rides delivered and received.",
    id: "double-visits",
    label: "Double visits",
    levels: MANAGER,
  },

  // ── Cost ────────────────────────────────────────────────────────────────────
  {
    defaultAt: MANAGER,
    group: "cost",
    hint: "Committed marketing requests.",
    id: "marketing-committed",
    label: "Marketing",
    levels: MANAGER,
  },
  {
    defaultAt: MANAGER,
    group: "cost",
    hint: "Outstation claimed, and the part HR has signed off.",
    id: "outstation-claimed",
    label: "Outstation expenses",
    levels: MANAGER,
  },
  {
    defaultAt: MANAGER,
    group: "cost",
    hint: "Marketing plus outstation per point of achievement. Lower is better.",
    id: "spend-per-point",
    label: "Spend per point",
    levels: MANAGER,
  },
  {
    defaultAt: MANAGER,
    group: "cost",
    hint: "What each area costs, read against whether its own sales are growing or falling.",
    id: "marketing-vs-trend",
    label: "Marketing against the trend",
    levels: MANAGER,
  },

  // ── People ──────────────────────────────────────────────────────────────────
  {
    defaultAt: ["line", "district"],
    group: "people",
    hint: "Each rep's activity beside the achievement of the area he stands in.",
    id: "rep-rows",
    label: "Rep by rep",
    levels: MANAGER,
  },
  {
    defaultAt: [],
    group: "people",
    hint: "Activity by job function — reps, district managers, product and training managers.",
    id: "role-activity",
    label: "By role",
    levels: ["company", "line"],
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
