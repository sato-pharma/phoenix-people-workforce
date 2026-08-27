"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import {
  appendCoverageParams,
  COVERAGE_LABEL_CLASS,
  COVERAGE_SELECT_CLASS,
  CoverageScopeFields,
} from "@/components/crm/coverage-filter-bar";
import { coverageSelectionIsActive, type CoverageFilterSelection, type CoverageFilterTree } from "@/lib/crm/coverage-filters";
import type { DoctorCoverageAppliedFilters } from "@/lib/crm/sfe-doctor-coverage";

// Month + scope + filters in ONE control that pushes every parameter together.
//
// They cannot be separate: the old MonthPicker pushed `?month=...` alone, so changing the month
// with a filter active silently dropped the filter — the board would quietly show something other
// than what the controls said. Everything is a URL parameter, so each change re-runs the
// server-side access gate rather than filtering a payload already sent to the browser.
//
// The grid is five wide on desktop so the rows mean something: Month and the Region → Line → Area
// → Rep cascade fill the first, and the doctor-level filters fill the second. The cascade itself
// is shared with Brick Coverage — see coverage-filter-bar.tsx.

const SELECT_CLASS = COVERAGE_SELECT_CLASS;
const LABEL_CLASS = COVERAGE_LABEL_CLASS;

export function DoctorCoverageFilterBar({
  applied,
  basePath,
  month,
  scope,
  tree,
}: {
  applied: DoctorCoverageAppliedFilters;
  basePath: string;
  month: string;
  scope: CoverageFilterSelection;
  tree: CoverageFilterTree;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({
    grade: applied.grade ?? "",
    kind: applied.kind ?? "",
    month,
    search: applied.search ?? "",
    status: applied.status ?? "",
  });
  const [draftScope, setDraftScope] = useState<CoverageFilterSelection>(scope);

  const push = (next: typeof draft, nextScope: CoverageFilterSelection) => {
    const params = appendCoverageParams(new URLSearchParams(), nextScope);
    params.set("month", next.month);
    if (next.grade) params.set("grade", next.grade);
    if (next.kind) params.set("kind", next.kind);
    if (next.status) params.set("status", next.status);
    if (next.search.trim()) params.set("search", next.search.trim());
    router.push(`${basePath}?${params.toString()}`);
  };

  const clearAll = () => {
    const cleared = { grade: "", kind: "", month: draft.month, search: "", status: "" };
    setDraft(cleared);
    setDraftScope({});
    push(cleared, {});
  };

  // The Rep select moved into the shared cascade, so "anything in force" now spans both halves.
  const anyActive = applied.active || coverageSelectionIsActive(scope);

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <label className="space-y-1">
          <span className={LABEL_CLASS}>Month</span>
          <input
            className={SELECT_CLASS}
            onChange={(event) => setDraft({ ...draft, month: event.target.value })}
            type="month"
            value={draft.month}
          />
        </label>

        <CoverageScopeFields onChange={setDraftScope} selection={draftScope} tree={tree} />

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Grade</span>
          <select className={SELECT_CLASS} onChange={(e) => setDraft({ ...draft, grade: e.target.value })} value={draft.grade}>
            <option value="">All grades</option>
            <option value="A">A</option>
            <option value="B">B</option>
            <option value="C">C</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Status</span>
          <select className={SELECT_CLASS} onChange={(e) => setDraft({ ...draft, status: e.target.value })} value={draft.status}>
            <option value="">All statuses</option>
            <option value="green">Covered</option>
            <option value="yellow">Under-visited</option>
            <option value="red">Not visited</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Type</span>
          <select className={SELECT_CLASS} onChange={(e) => setDraft({ ...draft, kind: e.target.value })} value={draft.kind}>
            <option value="">Doctors &amp; accounts</option>
            <option value="sp">Doctors only (SP)</option>
            <option value="hcp">Accounts only (HCP)</option>
          </select>
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Search</span>
          <input
            className={SELECT_CLASS}
            onChange={(event) => setDraft({ ...draft, search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") push(draft, draftScope);
            }}
            placeholder="Doctor, specialty or rep"
            type="search"
            value={draft.search}
          />
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button
          className="h-9 border border-slate-200 bg-slate-900 px-4 text-[11px] font-black uppercase tracking-[0.12em] text-white hover:bg-slate-700"
          onClick={() => push(draft, draftScope)}
          type="button"
        >
          Apply
        </button>
        {anyActive ? (
          <button
            className="h-9 border border-slate-200 bg-white px-4 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600 hover:border-orange-400"
            onClick={clearAll}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
        {anyActive ? (
          <span className="whitespace-nowrap text-[11px] font-semibold text-amber-700">
            Filtered — every figure below counts only the matching rows.
          </span>
        ) : null}
      </div>
    </div>
  );
}
