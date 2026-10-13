// Refresh must not throw away what the reader was looking at.
//
// The Closing Matrix's reload() cleared the region / area / product filter every time, for all
// three of its callers. Two of them are right to: change the LINE and the areas and products are
// different things, so the old selection is meaningless. The third is the REFRESH button — same
// line, same month, same pickers — and clearing there cost the reader their filter every time they
// asked for today's numbers, with nothing saying it had happened. A manager watching one region
// through an upload re-selected it on every press.
//
// Keeping it needs one guard. Refresh exists precisely because the closing can CHANGE underneath
// the screen — a re-upload, a geography version, an area merge taking effect — so a selection can
// name something the refreshed matrix no longer has. Left in place that filter matches nothing and
// the grid reads as empty; dropped in silence it is the same defect in the other direction. So the
// kept filter is narrowed to what the new matrix actually offers, and what fell out is NAMED.
//
// Pure, and in the lib rather than the component, so the rule can be tested without a browser.

import type { MonthlyClosingFilterOptions } from "@/lib/sales/monthly-closing-filter-options";

/**
 * The shape of the Monthly Closing filter, as the pickers keep it
 * (MonthlyClosingFilter in components/sales/monthly-closing-filters.tsx). Declared structurally so
 * this module stays a leaf — the component's own type flows through the generic unchanged.
 */
type ClosingFilterShape = {
  areaCodes: string[];
  productCodes: string[];
  regionCodes: string[];
  search: string;
};

export type ClosingFilterNarrowing<T extends ClosingFilterShape> = {
  /** The filter with every selection the new matrix cannot honour removed. */
  filter: T;
  /** The codes that were dropped, in the order they were selected. Empty when nothing fell out. */
  droppedCodes: string[];
};

/**
 * Narrow a filter the reader already had to the options a freshly loaded matrix offers.
 *
 * `search` is never touched: it is what they typed, it matches text rather than a code, and a term
 * that currently finds nothing is a search result, not a stale selection.
 */
export function narrowClosingFilterToOptions<T extends ClosingFilterShape>(
  filter: T,
  options: MonthlyClosingFilterOptions,
): ClosingFilterNarrowing<T> {
  const droppedCodes: string[] = [];

  const keep = (selected: string[], available: readonly { code: string }[]): string[] => {
    const codes = new Set(available.map((option) => option.code));
    const kept: string[] = [];
    for (const code of selected) {
      if (codes.has(code)) kept.push(code);
      else droppedCodes.push(code);
    }
    return kept;
  };

  const areaCodes = keep(filter.areaCodes ?? [], options.areas);
  const productCodes = keep(filter.productCodes ?? [], options.products);
  const regionCodes = keep(filter.regionCodes ?? [], options.regions);

  if (droppedCodes.length === 0) return { droppedCodes, filter };
  return { droppedCodes, filter: { ...filter, areaCodes, productCodes, regionCodes } };
}

/**
 * The sentence shown when a refresh dropped part of the filter. `labels` are the human names the
 * pickers showed for those codes — names, never codes, on screen (AGENTS.md §4).
 */
export function describeDroppedFilterChoices(labels: readonly string[]): string | null {
  const named = labels.map((label) => String(label ?? "").trim()).filter(Boolean);
  if (named.length === 0) return null;
  const list = named.length === 1
    ? named[0]
    : `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}`;
  return named.length === 1
    ? `${list} is no longer in this closing, so it was removed from your filter. Everything else you had selected is still applied.`
    : `${list} are no longer in this closing, so they were removed from your filter. Everything else you had selected is still applied.`;
}
