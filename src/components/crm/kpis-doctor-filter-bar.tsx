"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { phxFieldClassName } from "@/components/ui/form-tokens";
import {
  EMPTY_KPI_DOCTOR_FILTER,
  countActiveKpiDoctorFilter,
  hasActiveKpiDoctorFilter,
  KPI_DOCTOR_SORTS,
  KPI_DOCTOR_SORT_LABEL,
  type KpiDoctorFacetOption,
  type KpiDoctorFacets,
  type KpiDoctorFilter,
} from "@/lib/crm/kpis-doctor-filters";
import { buildKpisQuery, type KpiFilterState } from "@/lib/crm/kpis-filters";
import { cn } from "@/lib/utils";

/**
 * The filters on the OPEN rep's doctor list — Frequency and Coverage.
 *
 * ## Why it sits on the list and not in the rep panel above
 *
 * The rep panel decides WHOSE list can be opened; this decides which of that rep's doctors you are
 * looking at, so it belongs beside the doctors. It carries the same `filters` the rep panel does,
 * with only `doctor` replaced, and goes through the one URL builder (`buildKpisQuery`), so a doctor
 * filter never loses the rep filters, the period or the open rep — and none of them loses it.
 *
 * ## Only plain data crosses the boundary
 *
 * Facets, filter state and strings — no functions (tests/rsc-client-function-props.test.ts). Its
 * runtime imports come from kpis-doctor-filters.ts and kpis-filters.ts, which import nothing server-side.
 *
 * Chips wrap and the search, number and date fields stay at `text-base`: the fits-the-screen rule
 * allows no horizontal scroll, and under 16px iOS zooms the page when a field is focused.
 */

const LABEL = "text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500";

const SEND =
  "border border-slate-900 bg-slate-900 px-4 py-2 text-phx-md font-black uppercase tracking-[0.12em] text-white transition-colors hover:bg-slate-700";

type ChipGroup = "bricks" | "statuses" | "seen" | "timing" | "grades" | "specialities";

// Brick leads: "filter by brick, got the doctors in it, know who is covered and who is not" (owner, 2026-10-29).
const GROUPS: ReadonlyArray<{ key: ChipGroup; title: string; hint: string }> = [
  { key: "bricks", title: "Brick", hint: "From the doctor's validated live photo." },
  { key: "statuses", title: "Verdict", hint: "The Frequency report's reading of each doctor." },
  { key: "seen", title: "Seen in the period", hint: "At least one visit counts as covered." },
  { key: "timing", title: "Timing", hint: "Only a doctor with no visit can be late." },
  { key: "grades", title: "Grade", hint: "A 3 visits, B 2, C 1." },
  { key: "specialities", title: "Speciality", hint: "As the plan records it." },
];

function toggled<T extends string>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

export function KpisDoctorFilterBar({
  basePath,
  facets,
  filters,
  month,
  period,
  rep,
  shown,
  tab,
  total,
  view,
}: {
  basePath: string;
  facets: KpiDoctorFacets;
  /** The whole filter state; only `doctor` changes here. */
  filters: KpiFilterState;
  month: string;
  period: string;
  rep: string | null;
  /** Doctors left after the filters, and on the rep's whole list. */
  shown: number;
  tab: string;
  total: number;
  view?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const doctor = filters.doctor;
  const [query, setQuery] = useState(doctor.query);
  const [visitsMin, setVisitsMin] = useState(doctor.visitsMin != null ? String(doctor.visitsMin) : "");
  const [visitsMax, setVisitsMax] = useState(doctor.visitsMax != null ? String(doctor.visitsMax) : "");
  const [lastFrom, setLastFrom] = useState(doctor.lastFrom);
  const [lastTo, setLastTo] = useState(doctor.lastTo);

  const active = hasActiveKpiDoctorFilter(doctor);
  const activeCount = countActiveKpiDoctorFilter(doctor);

  const push = (next: KpiDoctorFilter) => {
    startTransition(() =>
      router.push(`${basePath}?${buildKpisQuery({ month, period, rep, tab, view, filters: { ...filters, doctor: next } })}`),
    );
  };

  const wholeNumber = (raw: string): number | null => {
    const value = Number(raw);
    return raw.trim() !== "" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  };

  const applyFields = () => {
    let min = wholeNumber(visitsMin);
    let max = wholeNumber(visitsMax);
    if (min != null && max != null && min > max) [min, max] = [max, min];
    let from = lastFrom;
    let to = lastTo;
    if (from && to && from > to) [from, to] = [to, from];
    push({ ...doctor, query, visitsMin: min, visitsMax: max, lastFrom: from, lastTo: to });
  };

  const clearAll = () => {
    setQuery("");
    setVisitsMin("");
    setVisitsMax("");
    setLastFrom("");
    setLastTo("");
    push({ ...EMPTY_KPI_DOCTOR_FILTER, sort: doctor.sort, direction: doctor.direction });
  };

  const optionsOf = (key: ChipGroup): KpiDoctorFacetOption[] => facets[key];
  const selectedOf = (key: ChipGroup): string[] => doctor[key] as string[];

  return (
    <div className="border border-slate-200 bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50 px-3 py-2.5">
        <p className="text-phx-xs font-black uppercase tracking-[0.14em] text-slate-500">
          Filter this list
          {activeCount > 0 ? (
            <span className="ml-2 inline-flex h-4 min-w-4 items-center justify-center bg-orange-600 px-1 text-phx-xs font-black tabular-nums text-white">
              {activeCount}
            </span>
          ) : null}
        </p>
        <p className="text-phx-sm font-semibold text-slate-500">
          Showing <span className="tabular-nums text-slate-900">{shown}</span> of{" "}
          <span className="tabular-nums text-slate-900">{total}</span> doctors
          {pending ? " · updating…" : ""}
        </p>
      </div>

      <div className="space-y-3 px-3 py-3">
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            applyFields();
          }}
        >
          <label className="block">
            <span className={LABEL}>Search</span>
            <span className="mt-1 block">
              <input
                className={cn(phxFieldClassName, "min-w-0 text-base")}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Doctor name, speciality, grade or brick"
                type="search"
                value={query}
              />
            </span>
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="min-w-0 border border-slate-200 px-3 py-2">
              <legend className={`px-1 ${LABEL}`}>Visits made</legend>
              <div className="grid grid-cols-2 gap-2">
                <label className="block min-w-0">
                  <span className="sr-only">Visits made, from</span>
                  <input
                    className={cn(phxFieldClassName, "min-w-0 text-base tabular-nums")}
                    inputMode="numeric"
                    min={0}
                    onChange={(event) => setVisitsMin(event.target.value)}
                    placeholder="From"
                    step={1}
                    type="number"
                    value={visitsMin}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="sr-only">Visits made, up to</span>
                  <input
                    className={cn(phxFieldClassName, "min-w-0 text-base tabular-nums")}
                    inputMode="numeric"
                    min={0}
                    onChange={(event) => setVisitsMax(event.target.value)}
                    placeholder="Up to"
                    step={1}
                    type="number"
                    value={visitsMax}
                  />
                </label>
              </div>
            </fieldset>
            <fieldset className="min-w-0 border border-slate-200 px-3 py-2">
              <legend className={`px-1 ${LABEL}`}>Last visit between</legend>
              <div className="grid grid-cols-2 gap-2">
                <label className="block min-w-0">
                  <span className="sr-only">Last visit, from</span>
                  <input
                    className={cn(phxFieldClassName, "min-w-0 text-base")}
                    onChange={(event) => setLastFrom(event.target.value)}
                    type="date"
                    value={lastFrom}
                  />
                </label>
                <label className="block min-w-0">
                  <span className="sr-only">Last visit, up to</span>
                  <input
                    className={cn(phxFieldClassName, "min-w-0 text-base")}
                    onChange={(event) => setLastTo(event.target.value)}
                    type="date"
                    value={lastTo}
                  />
                </label>
              </div>
            </fieldset>
          </div>

          <div className="flex flex-wrap gap-2">
            <button className={SEND} disabled={pending} type="submit">
              Apply
            </button>
            {active ? (
              <button
                className="border border-slate-300 bg-white px-4 py-2 text-phx-md font-bold text-slate-600 transition-colors hover:border-rose-400 hover:text-rose-700"
                disabled={pending}
                onClick={clearAll}
                type="button"
              >
                Clear doctor filters
              </button>
            ) : null}
          </div>
        </form>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {GROUPS.map((group) => {
            const options = optionsOf(group.key);
            // One option cannot change a single row, and offering it implies the list holds other kinds.
            if (options.length <= 1) return null;
            const selected = selectedOf(group.key);
            return (
              <fieldset className="min-w-0 border border-slate-200 px-3 py-2" key={group.key}>
                <legend className={`px-1 ${LABEL}`}>{group.title}</legend>
                <p className="text-phx-xs leading-4 text-slate-400">{group.hint}</p>
                <div className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
                  {options.map((option) => {
                    const on = selected.includes(option.value);
                    return (
                      <label
                        className={
                          on
                            ? "inline-flex cursor-pointer items-center gap-1.5 border border-orange-500 bg-orange-50 px-2 py-1 text-phx-sm font-bold text-orange-900"
                            : "inline-flex cursor-pointer items-center gap-1.5 border border-slate-200 bg-white px-2 py-1 text-phx-sm font-semibold text-slate-700 transition-colors hover:border-slate-400"
                        }
                        key={option.value}
                      >
                        <input
                          checked={on}
                          className="h-3 w-3 accent-orange-600"
                          disabled={pending}
                          onChange={() =>
                            push({
                              ...doctor,
                              [group.key]: toggled(selected, option.value),
                            } as KpiDoctorFilter)
                          }
                          type="checkbox"
                        />
                        <span dir="auto">{option.label}</span>
                        <span className="tabular-nums text-slate-400">{option.count}</span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
            );
          })}
        </div>

        <fieldset className="min-w-0 border border-slate-200 px-3 py-2">
          <legend className={`px-1 ${LABEL}`}>Order by</legend>
          <div className="flex flex-wrap items-center gap-1.5">
            {KPI_DOCTOR_SORTS.map((sort) => {
              const on = doctor.sort === sort;
              return (
                <button
                  aria-pressed={on}
                  className={
                    on
                      ? "border border-orange-500 bg-orange-50 px-2 py-1 text-phx-sm font-bold text-orange-900"
                      : "border border-slate-200 bg-white px-2 py-1 text-phx-sm font-semibold text-slate-700 transition-colors hover:border-slate-400"
                  }
                  disabled={pending}
                  key={sort}
                  onClick={() =>
                    push(
                      on && sort !== "default"
                        ? { ...doctor, direction: doctor.direction === "asc" ? "desc" : "asc" }
                        : { ...doctor, sort, direction: sort === "visits" || sort === "last" ? "desc" : "asc" },
                    )
                  }
                  type="button"
                >
                  {KPI_DOCTOR_SORT_LABEL[sort]}
                  {on && sort !== "default" ? <span aria-hidden> {doctor.direction === "asc" ? "▲" : "▼"}</span> : null}
                </button>
              );
            })}
          </div>
        </fieldset>
      </div>
    </div>
  );
}
