// Business Review — the period window.
//
// The review used to be a fixed six months (2026-01..2026-06) with month buckets keyed on the
// English month name ("Jan".."Jun"). Both facts are gone: the window is whatever the viewer picks,
// and every by-month record is keyed on the bare period ("2026-01"), which sorts correctly, never
// collides across years, and needs no lookup table.
//
// Formatting lives in period-format.ts, a leaf module with no imports, so client components can
// render month headers without pulling the sales domain into the browser bundle. It is re-exported
// here so server-side callers have one place to import from.

import { SALES_HISTORY_FLOOR } from "@/lib/sales/vs-target";
import { enumeratePeriods } from "@/lib/sales/sos-coverage";

import { isReviewPeriod, periodLabel, windowLabel } from "./period-format";

export {
  PERIOD_PATTERN,
  isReviewPeriod,
  isSingleYear,
  periodColumnLabel,
  periodColumnLabels,
  periodLabel,
  periodShortLabel,
  quartersInWindow,
  windowLabel,
} from "./period-format";

/** The first month the canonical engine holds anything for. Re-exported so the review's own
 *  floor is visibly the engine's data floor and not a second, drifting constant. */
export const REVIEW_FLOOR = SALES_HISTORY_FLOOR;

export type ReviewWindow = {
  from: string;
  to: string;
  /** Every month in the window, inclusive, ascending. Never empty for a resolved window. */
  periods: string[];
  /** "Jan – Jun 2026" / "Dec 2025 – Feb 2026" / "Apr 2026". */
  label: string;
};

export type WindowResolution = {
  window: ReviewWindow;
  /** Non-null when the request could not be honoured verbatim. The UI must show this — a
   *  silently corrected window is a wrong answer wearing a right answer's label. */
  adjustment: string | null;
};

/**
 * Turn two request parameters into a window that is guaranteed to be renderable.
 *
 * `available` is the list of months the data actually holds, ascending. It is discovered, never
 * hardcoded, so the picker cannot offer a month that does not exist and a bookmarked URL from
 * three months ago degrades to a stated adjustment rather than an empty page.
 *
 * Everything here is a clamp, not a rejection: the review always renders SOMETHING, and says
 * what it did. The one thing it must never do is silently answer a different question.
 */
export function resolveReviewWindow(
  fromParam: string | null | undefined,
  toParam: string | null | undefined,
  available: readonly string[],
): WindowResolution {
  const floor = available.length > 0 ? available[0] : REVIEW_FLOOR;
  const ceiling = available.length > 0 ? available[available.length - 1] : REVIEW_FLOOR;

  const notes: string[] = [];
  let from = isReviewPeriod(fromParam) ? fromParam : null;
  let to = isReviewPeriod(toParam) ? toParam : null;

  if (fromParam != null && fromParam !== "" && from == null) notes.push(`"${fromParam}" is not a month`);
  if (toParam != null && toParam !== "" && to == null) notes.push(`"${toParam}" is not a month`);

  // A single bound given on its own means "this month" rather than "from here to forever".
  if (from == null && to != null) from = to;
  if (to == null && from != null) to = from;

  if (from == null || to == null) {
    from = floor;
    to = ceiling;
  }

  if (from > to) {
    notes.push(`${periodLabel(from)} is after ${periodLabel(to)}, so the two were swapped`);
    [from, to] = [to, from];
  }
  if (from < floor) {
    notes.push(`data starts at ${periodLabel(floor)}, so the window was moved forward`);
    from = floor;
  }
  if (to > ceiling) {
    notes.push(`data ends at ${periodLabel(ceiling)}, so the window was pulled back`);
    to = ceiling;
  }
  if (from > to) {
    from = floor;
    to = ceiling;
  }

  const periods = enumeratePeriods(from, to);
  return {
    window: { from, to, periods, label: windowLabel(from, to) },
    adjustment: notes.length > 0 ? notes.join("; ") : null,
  };
}
