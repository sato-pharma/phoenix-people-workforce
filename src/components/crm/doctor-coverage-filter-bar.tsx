"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { DoctorCoverageAppliedFilters } from "@/lib/crm/sfe-doctor-coverage";

// Month + filters in ONE control that pushes every parameter together.
//
// They cannot be separate: the old MonthPicker pushed `?month=...` alone, so changing the month
// with a filter active silently dropped the filter — the board would quietly show something other
// than what the controls said. Everything is a URL parameter, so each change re-runs the
// server-side access gate rather than filtering a payload already sent to the browser.

const SELECT_CLASS =
  "h-9 w-full border border-slate-200 bg-white px-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400";
const LABEL_CLASS = "block text-[9px] font-black uppercase tracking-[0.16em] text-slate-400";

export function DoctorCoverageFilterBar({
  applied,
  basePath,
  month,
  repOptions,
}: {
  applied: DoctorCoverageAppliedFilters;
  basePath: string;
  month: string;
  repOptions: Array<{ repKey: string; repName: string }>;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState({
    grade: applied.grade ?? "",
    kind: applied.kind ?? "",
    month,
    rep: applied.repKey ?? "",
    search: applied.search ?? "",
    status: applied.status ?? "",
  });

  const push = (next: typeof draft) => {
    const params = new URLSearchParams();
    params.set("month", next.month);
    if (next.grade) params.set("grade", next.grade);
    if (next.kind) params.set("kind", next.kind);
    if (next.rep) params.set("rep", next.rep);
    if (next.status) params.set("status", next.status);
    if (next.search.trim()) params.set("search", next.search.trim());
    router.push(`${basePath}?${params.toString()}`);
  };

  const clearAll = () => {
    const cleared = { grade: "", kind: "", month: draft.month, rep: "", search: "", status: "" };
    setDraft(cleared);
    push(cleared);
  };

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <label className="space-y-1">
          <span className={LABEL_CLASS}>Month</span>
          <input
            className={SELECT_CLASS}
            onChange={(event) => setDraft({ ...draft, month: event.target.value })}
            type="month"
            value={draft.month}
          />
        </label>

        <label className="space-y-1">
          <span className={LABEL_CLASS}>Rep</span>
          <select className={SELECT_CLASS} onChange={(e) => setDraft({ ...draft, rep: e.target.value })} value={draft.rep}>
            <option value="">All reps</option>
            {repOptions.map((rep) => (
              <option key={rep.repKey} value={rep.repKey}>
                {rep.repName}
              </option>
            ))}
          </select>
        </label>

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
            <option value="red">Lapsed</option>
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
              if (event.key === "Enter") push(draft);
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
          onClick={() => push(draft)}
          type="button"
        >
          Apply
        </button>
        {applied.active ? (
          <button
            className="h-9 border border-slate-200 bg-white px-4 text-[11px] font-black uppercase tracking-[0.12em] text-slate-600 hover:border-orange-400"
            onClick={clearAll}
            type="button"
          >
            Clear filters
          </button>
        ) : null}
        {applied.active ? (
          <span className="whitespace-nowrap text-[11px] font-semibold text-amber-700">
            Filtered — every figure below counts only the matching rows.
          </span>
        ) : null}
      </div>
    </div>
  );
}
