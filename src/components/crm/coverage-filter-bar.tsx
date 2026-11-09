"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  coverageSelectionIsActive,
  narrowCoverageOptions,
  pruneCoverageSelection,
  type CoverageFilterSelection,
  type CoverageFilterTree,
} from "@/lib/crm/coverage-filters";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// Region → Line → Area → Rep, the four controls both CRM coverage boards share.
//
// `CoverageScopeFields` is the cascade on its own so Doctor Coverage can sit it alongside its own
// Grade/Status/Type/Search controls in one grid, rather than stacking two filter bars that each
// own an Apply button. `CoverageFilterBar` is the whole bar, for boards whose only filters are
// these four plus the month.
//
// The narrowing runs HERE, in the browser, off the tree the server already sent. Doing it on the
// server would mean a round trip per select: pick a region, wait, then discover which lines exist.
// The tree is a few KB and `narrowCoverageOptions` is pure, so the dropdowns just re-narrow as you
// type. The Apply button is still what re-runs the query — and every filter travels as a URL
// parameter, so applying re-enters the server-side access gate instead of filtering rows the
// browser was already handed.

const SELECT_CLASS = cn(phxSelectClassName, "h-9 w-full px-2");
const LABEL_CLASS = "block text-phx-xs font-black uppercase tracking-[0.16em] text-slate-400";

export const COVERAGE_SELECT_CLASS = SELECT_CLASS;
export const COVERAGE_LABEL_CLASS = LABEL_CLASS;

/** Serializes a selection into URL parameters, omitting every level that is not set. */
export function appendCoverageParams(params: URLSearchParams, selection: CoverageFilterSelection) {
  if (selection.region) params.set("region", selection.region);
  if (selection.line) params.set("line", selection.line);
  if (selection.area) params.set("area", selection.area);
  if (selection.rep) params.set("rep", selection.rep);
  return params;
}

export function CoverageScopeFields({
  onChange,
  selection,
  tree,
}: {
  onChange: (next: CoverageFilterSelection) => void;
  selection: CoverageFilterSelection;
  tree: CoverageFilterTree;
}) {
  const options = narrowCoverageOptions(tree, selection);

  // Every change re-prunes, so choosing a region cannot leave an area from the previous one behind.
  const set = (patch: Partial<CoverageFilterSelection>) =>
    onChange(pruneCoverageSelection(tree, { ...selection, ...patch }));

  const field = (
    label: string,
    allLabel: string,
    value: string | undefined,
    list: Array<{ code: string; name: string }>,
    apply: (next: string | undefined) => void,
  ) => (
    <label className="space-y-1">
      <span className={LABEL_CLASS}>{label}</span>
      <select className={SELECT_CLASS} onChange={(event) => apply(event.target.value || undefined)} value={value ?? ""}>
        <option value="">{allLabel}</option>
        {list.map((option) => (
          <option key={option.code} value={option.code}>
            {option.name}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <>
      {field("Region", "All regions", selection.region, options.regions, (region) => set({ region }))}
      {field("Line", "All lines", selection.line, options.lines, (line) => set({ line }))}
      {field("Area", "All areas", selection.area, options.areas, (area) => set({ area }))}
      {field("Rep", "All reps", selection.rep, options.reps, (rep) => set({ rep }))}
    </>
  );
}

/**
 * The whole bar for a board whose only filters are the month plus the cascade.
 *
 * Month lives in here rather than in its own picker for the reason the doctor bar records: a
 * standalone month control pushes `?month=` alone, which silently drops every active filter, so the
 * board quietly shows something other than what the controls say.
 */
export function CoverageFilterBar({
  basePath,
  month,
  selection,
  tree,
}: {
  basePath: string;
  month: string;
  selection: CoverageFilterSelection;
  tree: CoverageFilterTree;
}) {
  const router = useRouter();
  const [draftMonth, setDraftMonth] = useState(month);
  const [draft, setDraft] = useState<CoverageFilterSelection>(selection);

  const push = (nextMonth: string, next: CoverageFilterSelection) => {
    const params = appendCoverageParams(new URLSearchParams(), next);
    params.set("month", nextMonth);
    router.push(`${basePath}?${params.toString()}`);
  };

  const clearAll = () => {
    setDraft({});
    push(draftMonth, {});
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <label className="space-y-1">
          <span className={LABEL_CLASS}>Month</span>
          <input
            className={SELECT_CLASS}
            onChange={(event) => setDraftMonth(event.target.value)}
            type="month"
            value={draftMonth}
          />
        </label>
        <CoverageScopeFields onChange={setDraft} selection={draft} tree={tree} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="h-9 border border-slate-200 bg-slate-900 px-4 text-phx-xs font-black uppercase tracking-[0.12em] text-white hover:bg-slate-700"
          onClick={() => push(draftMonth, draft)}
          type="button"
        >
          Apply
        </button>
        {coverageSelectionIsActive(selection) ? (
          <button
            className="h-9 border border-slate-200 bg-white px-4 text-phx-xs font-black uppercase tracking-[0.12em] text-slate-600 hover:border-orange-400"
            onClick={clearAll}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
        {coverageSelectionIsActive(selection) ? (
          <span className="whitespace-nowrap text-phx-xs font-semibold text-amber-700">
            Filtered — every figure below counts only the matching rows.
          </span>
        ) : null}
      </div>
    </div>
  );
}
