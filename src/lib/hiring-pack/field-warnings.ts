// A box that will not print, and a box printing on top of another one.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE FAILURE THIS NAMES. The drag clamps at zero on the top and left — `Math.max(0, …)` — and has
// no upper bound at all, while `.sheet` is `overflow: hidden`. So a box dragged past the RIGHT or
// BOTTOM edge is clipped in silence: it looks placed while it is being dragged, it is saved, and it
// prints nothing. Nothing on any screen says so, and the paper it does not appear on is a government
// form somebody signs.
//
// It is also invisible to the golden-rule scroll check, and for the same reason that check is blind
// to a clipped band: content that is clipped adds nothing to `scrollWidth`, so the page measures
// clean while a field hangs off the side of it.
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// A WARNING, NEVER A BLOCK, and that is a real decision rather than caution. Overlapping boxes are
// LEGITIMATE here: one of a pair is often hidden, or empty for most people — a rule that resolves to
// nothing prints nothing and leaves the space to its neighbour, which is exactly how two alternative
// spellings of an address share one line. Refusing the save would make a layout that works today
// impossible to express. Naming it costs nothing and answers the question the operator is actually
// asking, which is "why is this not on my printout".
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// PAGE SURFACES ONLY, said plainly rather than by returning nothing. A flow document has no page
// coordinates at all: its fields hang off a CSS anchor and their final position is decided by the
// browser, after the text above them has been laid out. Two anchored boxes cannot be compared
// without rendering the document, and an off-page test would have nothing to test against. Answering
// "no problems" for a surface this cannot examine would be a false clean bill, so the caller is told
// the check does not apply instead.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { documentSurface, type DocumentFieldRow } from "@/lib/hiring-pack/field-layout";
import { FORM1_PAGE_HEIGHT_PT, FORM1_PAGE_WIDTH_PT } from "@/lib/hiring-pack/form1-layout";
import { FORM6_PAGE_HEIGHT_PT, FORM6_PAGE_WIDTH_PT } from "@/lib/hiring-pack/form6-layout";
import {
  LABOUR_PAGE_HEIGHT_PT,
  LABOUR_PAGE_WIDTH_PT,
} from "@/lib/hiring-pack/labour-exit-layout";
import type { HiringPackDocument } from "@/lib/hiring-pack/types";

export type PageSize = { width: number; height: number };

/**
 * The printed size of one side of a page document, in points, or null for a flow document.
 *
 * READ FROM THE LAYOUT TABLES THEMSELVES rather than restated here. These are measurements off the
 * Authority's own artwork — Form 1 is 612.12 × 1008.12pt, which is not A4 and not US Letter — and a
 * second copy of a number like that drifts from the first the day the artwork is re-measured, with
 * the only symptom being a warning that fires slightly too early or too late.
 */
export function pageSizeFor(document: HiringPackDocument): PageSize | null {
  switch (document) {
    case "form1":
      return { height: FORM1_PAGE_HEIGHT_PT, width: FORM1_PAGE_WIDTH_PT };
    case "form6":
      return { height: FORM6_PAGE_HEIGHT_PT, width: FORM6_PAGE_WIDTH_PT };
    case "resignation":
    case "mutualTermination":
      return { height: LABOUR_PAGE_HEIGHT_PT, width: LABOUR_PAGE_WIDTH_PT };
    default:
      // Every flow document. Not a default for its own sake: `documentSurface` already answers the
      // same question, and the two are checked against each other in the tests so a new page
      // document that forgets to add a size here is caught rather than silently unwarned.
      return null;
  }
}

export type FieldWarning = {
  /** The field-layer row this is about. */
  rowId: string;
  kind: "off-page" | "overlap";
  /** One sentence, as the operator reads it. */
  message: string;
};

/** How far outside the page counts as outside it. */
const EDGE_TOLERANCE_PT = 0.5;

/**
 * How much of two boxes must share space before it is worth saying anything.
 *
 * Boxes on a form sit in a grid and TOUCH constantly — a row of digit cells on Form 1 abuts its
 * neighbour by design, and rounding a coordinate to two decimals leaves fractional overlaps
 * everywhere. Warning on every touch would put a line under most of the table and train the operator
 * to ignore all of them, which costs more than the warning is worth. Four square points is about a
 * character's worth of genuine collision.
 */
const OVERLAP_TOLERANCE_SQ_PT = 4;

/** The overlapping area of two boxes, in square points. Zero when they merely touch. */
function overlapArea(a: DocumentFieldRow, b: DocumentFieldRow): number {
  const dx = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const dy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (dx <= 0 || dy <= 0) return 0;
  return dx * dy;
}

/**
 * Which of these boxes will not print, and which are printing on top of each other.
 *
 * PURE, AND GIVEN THE LABELS RATHER THAN LOOKING THEM UP, so the one thing worth pinning — the
 * geometry — can be pinned without a document, a database or a browser. `label` answers with what
 * the operator calls a row; anything it cannot name falls back to a description of the box.
 *
 * HIDDEN ROWS ARE SKIPPED ENTIRELY. A hidden override renders no box at all — `mergePagePlacements`
 * does `if (override.hidden) continue` — so it can neither fall off the page nor overlap anything.
 * Warning about one would send the operator looking for a box that is not there.
 */
export function fieldWarnings(
  document: HiringPackDocument,
  rows: readonly DocumentFieldRow[],
  label: (row: DocumentFieldRow) => string,
): FieldWarning[] {
  if (documentSurface(document) !== "page") return [];
  const page = pageSizeFor(document);
  if (!page) return [];

  const live = rows.filter((row) => !row.hidden && row.page !== null);
  const warnings: FieldWarning[] = [];

  for (const row of live) {
    const overRight = row.x + row.w > page.width + EDGE_TOLERANCE_PT;
    const overBottom = row.y + row.h > page.height + EDGE_TOLERANCE_PT;
    // Negative coordinates are unreachable by dragging, which clamps at zero — but they are
    // reachable through the fine-tune panel's number inputs, which take a typed value as given.
    const overLeft = row.x < -EDGE_TOLERANCE_PT;
    const overTop = row.y < -EDGE_TOLERANCE_PT;
    if (!overRight && !overBottom && !overLeft && !overTop) continue;

    const edges = [
      overRight ? "right" : null,
      overBottom ? "bottom" : null,
      overLeft ? "left" : null,
      overTop ? "top" : null,
    ].filter((edge): edge is string => edge !== null);

    warnings.push({
      kind: "off-page",
      message: `Outside the page — this will not print. It runs past the ${edges.join(" and ")} edge${
        edges.length === 1 ? "" : "s"
      }.`,
      rowId: row.id,
    });
  }

  // Each PAIR once, reported on BOTH rows. A collision is a property of the pair, and an operator
  // looking at either row needs to be told — naming it only on the second would mean the answer
  // depends on which one they happened to open.
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i];
      const b = live[j];
      if (a.page !== b.page) continue;
      if (overlapArea(a, b) <= OVERLAP_TOLERANCE_SQ_PT) continue;
      warnings.push({ kind: "overlap", message: `Overlaps ${label(b)}.`, rowId: a.id });
      warnings.push({ kind: "overlap", message: `Overlaps ${label(a)}.`, rowId: b.id });
    }
  }

  return warnings;
}

/** The warnings for each row, keyed by row id — the shape the table reads. */
export function fieldWarningsByRow(
  document: HiringPackDocument,
  rows: readonly DocumentFieldRow[],
  label: (row: DocumentFieldRow) => string,
): Record<string, FieldWarning[]> {
  const byRow: Record<string, FieldWarning[]> = {};
  for (const warning of fieldWarnings(document, rows, label)) {
    (byRow[warning.rowId] ??= []).push(warning);
  }
  return byRow;
}
