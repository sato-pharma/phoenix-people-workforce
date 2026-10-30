// Business Review — what the chosen window actually holds, per source.
//
// THE RULE THIS FILE EXISTS FOR: a period with no data must SAY it has no data. It must never
// render as a zero, an empty table, or a 0% achievement. Those three all read as "the business did
// nothing", and in a room where a manager is reviewing a head of department that is not a rounding
// error — it is an accusation.
//
// So every source reports its own coverage independently. Sales can be complete while marketing is
// empty and outstation is partial, and the review says exactly that, month by month, rather than
// collapsing to one page-level "no data" flag that hides which half is missing.
//
// `unattributedRows` is the second half of the same rule. A source row that cannot be placed on an
// area or a district is COUNTED and REPORTED, never dropped to make a total look tidy — the same
// standing rule the sales importers follow.

// period-format is a leaf (no imports), so the coverage banner can render client-side.
import { periodLabel } from "./period-format";
import type { ReviewWindow } from "./period";

export type ReviewSourceId =
  | "sales"
  | "targets"
  | "marketing"
  | "outstation"
  | "visits"
  | "customers";

export type CoverageStatus = "complete" | "partial" | "empty";

export type SourceCoverage = {
  source: ReviewSourceId;
  label: string;
  /** Where the numbers come from, named so a reader can go and check them. */
  origin: string;
  /** Which rows count toward the figure, in one sentence. */
  rule: string;
  status: CoverageStatus;
  periodsWithData: string[];
  periodsWithoutData: string[];
  rows: number;
  /** Rows this source held for the window that could not be placed on an area or a district. */
  unattributedRows: number;
  unattributedNote: string | null;
  /** Shown verbatim by the UI whenever status is not "complete". */
  note: string | null;
};

export type ReviewCoverage = {
  window: ReviewWindow;
  sources: SourceCoverage[];
  /** No sales rows at all in the window. The page must render the hard empty state and no tables. */
  empty: boolean;
  /** No targets anywhere in the window, so no achievement can be computed for any of it. */
  ungradeable: boolean;
  emptySources: ReviewSourceId[];
  partialSources: ReviewSourceId[];
  /** Set when the requested window had to be clamped — see resolveReviewWindow. */
  adjustment: string | null;
  /**
   * Months inside the window whose distributor files have not landed yet.
   *
   * NOT the same as "no rows", and that difference is the whole reason this field exists. A month
   * can carry Direct orders — one approved order writes a Source-of-Sales batch under the
   * `DirectReq` pseudo-distributor, and they trickle in one at a time all month — while not one of
   * the real distributor files has arrived. The engine returns those rows against the month's FULL
   * target, so any window containing such a month divides real sales by a target nobody has sold
   * against yet.
   *
   * August 2026 is exactly this shape: a single `DirectReq` batch, 321,916 EGP, against a
   * 17,508,935 EGP target. Left inside the window it drags a Jan-Aug review from 50.7% to 39.3% —
   * an eleven-point hole with nothing on the page to explain it, in the default view, in a room
   * where somebody is being reviewed on it.
   *
   * So these months are held out of the graded totals and named here instead, carrying the value
   * they DO hold. Holding a month out silently would be the same lie in the other direction.
   */
  notUploaded: {
    periods: string[];
    /** Actual EGP those months do hold, so the exclusion hides nothing. */
    value: number;
    rows: number;
    note: string;
    /**
     * What those months hold BESIDE sales — committed marketing, claimed outstation, visit rows and
     * the people who made them.
     *
     * Owner ruling 2026-09-26. Before it, a held-out month's SALES were excluded and named here
     * while its spend and visits stayed inside every total, so the page put three months of cost
     * against two months of sales under one heading — on the default Jul–Sep 2026 window, 48.8% of
     * committed marketing, 41.8% of outstation and 24.2% of field visits came from the month whose
     * sales were not there. Both halves stop at the same month now, and this is where the rest is
     * reported: named, never zeroed, never folded back into a total.
     */
    alsoHeldOut: {
      marketingRequests: number;
      marketingCommitted: number;
      outstationRows: number;
      outstationClaimed: number;
      visitRows: number;
      visitAgents: number;
    } | null;
  } | null;
  /**
   * The span every figure on the page answers.
   *
   * Null when it is the whole requested window, which is the ordinary case. It is set only when the
   * two differ — when the window reaches a month whose distributor files have not landed — and the
   * header prints THIS label rather than the requested range, because naming a range a third of
   * whose figures were never in it is the mislabel this field exists to end.
   */
  figureWindow: { label: string; periods: string[] } | null;
};

/** "2026-03, 2026-04 and 2026-05" — never an ellipsis, per the standing UI rule; a long run is
 *  collapsed to its endpoints instead, which stays readable without hiding anything. */
export function describePeriods(periods: readonly string[]): string {
  const labels = periods.map(periodLabel);
  if (labels.length === 0) return "";
  if (labels.length === 1) return labels[0];
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  if (labels.length > 4) return `${labels[0]} through ${labels[labels.length - 1]} (${labels.length} months)`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

export function buildSourceCoverage(input: {
  source: ReviewSourceId;
  label: string;
  origin: string;
  rule: string;
  window: ReviewWindow;
  /** Months this source returned at least one row for. */
  periodsWithData: readonly string[];
  rows: number;
  unattributedRows?: number;
  unattributedNote?: string | null;
  /** Overrides the generated sentence when a source needs to explain itself in its own words. */
  emptyNote?: string;
  /** Same, for the partial case. A source that knows WHY a month is missing should say so — "the
   *  distributor files have not arrived" and "nobody spent anything" are both `partial`, and a
   *  manager cannot act on the same sentence for both. */
  partialNote?: string;
}): SourceCoverage {
  const withData = input.window.periods.filter((p) => input.periodsWithData.includes(p));
  const without = input.window.periods.filter((p) => !input.periodsWithData.includes(p));
  const status: CoverageStatus = withData.length === 0 ? "empty" : without.length === 0 ? "complete" : "partial";

  // The banner prints "{label}: {note}", so the generated sentences never repeat the label. Repeating
  // it read "CRM visits is missing" and "No crm visits data" — wrong number, wrong case.
  let note: string | null = null;
  if (status === "empty") {
    note =
      input.emptyNote ??
      `Nothing is recorded for ${describePeriods(input.window.periods)}. ` +
        `This is not a zero — the source holds no rows at all for this window.`;
  } else if (status === "partial") {
    note =
      input.partialNote ??
      `Nothing is recorded for ${describePeriods(without)}. ` +
        (without.length === 1
          ? `That month adds nothing to the totals below and is not a zero.`
          : `Those months add nothing to the totals below and are not zeros.`);
  }

  return {
    source: input.source,
    label: input.label,
    origin: input.origin,
    rule: input.rule,
    status,
    periodsWithData: withData,
    periodsWithoutData: without,
    rows: input.rows,
    unattributedRows: input.unattributedRows ?? 0,
    unattributedNote: input.unattributedNote ?? null,
    note,
  };
}

export function buildReviewCoverage(input: {
  window: ReviewWindow;
  sources: SourceCoverage[];
  adjustment: string | null;
  notUploaded?: ReviewCoverage["notUploaded"];
  figureWindow?: ReviewCoverage["figureWindow"];
}): ReviewCoverage {
  const byId = new Map(input.sources.map((s) => [s.source, s]));
  return {
    window: input.window,
    sources: input.sources,
    empty: byId.get("sales")?.status === "empty",
    ungradeable: byId.get("targets")?.status === "empty",
    emptySources: input.sources.filter((s) => s.status === "empty").map((s) => s.source),
    partialSources: input.sources.filter((s) => s.status === "partial").map((s) => s.source),
    adjustment: input.adjustment,
    notUploaded: input.notUploaded ?? null,
    figureWindow: input.figureWindow ?? null,
  };
}

/** The span the page's figures answer, in words — the figure window when it is narrower than the
 *  one that was asked for, otherwise the window itself. One place, so header and export agree. */
export function figureWindowLabel(coverage: ReviewCoverage): string {
  return coverage.figureWindow?.label ?? coverage.window.label;
}

/**
 * The months the figures actually answer — the figure window's, or the requested window's when the
 * two are the same.
 *
 * 🔴 `meta.months` is the REQUESTED window, while `meta.period` is the FIGURE window, and a table
 * that iterates the first under a heading naming the second prints a column for a month that was
 * deliberately held out. It fills with `?? 0`, so the reader sees "0 customers in September" for a
 * rep who worked all September — the misleading zero §7 forbids. Measured 2026-09-28 on the 87 rep
 * packs: every one carried a SEP column of zeros, including reps with 151 customers in August,
 * while the cover of the same sheet said September's 13,450 CRM rows were held out and were real.
 */
export function figureWindowPeriods(
  coverage: Pick<ReviewCoverage, "figureWindow" | "window">,
): readonly string[] {
  return coverage.figureWindow?.periods ?? coverage.window.periods;
}

/**
 * The months the customer-grain figures — sales by brick, by customer and by channel — are read for:
 * the figure window's months, and never a month whose distributor files have not landed.
 *
 * 🔴 `figureWindow` is NULL when nothing was held out, which is the ORDINARY case, so the loader's
 * old `figureWindow?.periods ?? []` read NO months for every complete window: the brick, customer
 * and channel pages of every viewer's pack and portal page came back empty. Measured 2026-10-29 on
 * a rep's Jul–Sep pack: 0 · 0 · 0 on every channel beside EGP 222,448 of sales on its first page.
 * A window where no month's files have landed has a null figure window too; every one of its months
 * is `notUploaded`, so it still reads none.
 */
export function concentrationPeriods(
  coverage: Pick<ReviewCoverage, "figureWindow" | "notUploaded" | "window">,
): string[] {
  const heldOut = new Set(coverage.notUploaded?.periods ?? []);
  return figureWindowPeriods(coverage).filter((period) => !heldOut.has(period));
}

/** True when a figure fed by this source may be rendered as a number. When false the UI must
 *  print "no data" — never 0, and never a dash that reads like a zero. */
export function hasFigures(coverage: ReviewCoverage, source: ReviewSourceId): boolean {
  return coverage.sources.find((s) => s.source === source)?.status !== "empty";
}
