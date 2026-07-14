"use client";

import Link from "next/link";
import { ArrowRight, Search, SlidersHorizontal, X } from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

export type Employee360ListItem = {
  hrId: string;
  displayName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  managerName: string | null;
  employmentStatus: string | null;
};

type FilterKey = "lineName" | "areaName" | "jobTitle" | "managerName";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "lineName", label: "Line" },
  { key: "areaName", label: "Area" },
  { key: "jobTitle", label: "Job title" },
  { key: "managerName", label: "Manager" },
];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const joined = parts.map((part) => part[0] ?? "").join("");
  return joined ? joined.toUpperCase() : "—";
}

const AVATAR_TONES = [
  "from-orange-500 to-amber-600",
  "from-sky-600 to-indigo-700",
  "from-emerald-600 to-teal-700",
  "from-violet-600 to-purple-700",
  "from-rose-600 to-pink-700",
  "from-slate-700 to-slate-900",
];

function avatarTone(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

function uniqueSorted(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => Boolean(v && v.trim())))).sort((a, b) =>
    a.localeCompare(b),
  );
}

export function EmployeeSearchList({ employees }: { employees: Employee360ListItem[] }) {
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<FilterKey, string>>({
    lineName: "",
    areaName: "",
    jobTitle: "",
    managerName: "",
  });
  const [showFilters, setShowFilters] = useState(false);

  const options = useMemo(
    () => ({
      lineName: uniqueSorted(employees.map((e) => e.lineName)),
      areaName: uniqueSorted(employees.map((e) => e.areaName)),
      jobTitle: uniqueSorted(employees.map((e) => e.jobTitle)),
      managerName: uniqueSorted(employees.map((e) => e.managerName)),
    }),
    [employees],
  );

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return employees.filter((e) => {
      if (filters.lineName && e.lineName !== filters.lineName) return false;
      if (filters.areaName && e.areaName !== filters.areaName) return false;
      if (filters.jobTitle && e.jobTitle !== filters.jobTitle) return false;
      if (filters.managerName && e.managerName !== filters.managerName) return false;
      if (!q) return true;
      return [e.displayName, e.hrId, e.jobTitle, e.lineName, e.areaName, e.regionName, e.managerName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [employees, query, filters]);

  const clearAll = () => {
    setQuery("");
    setFilters({ lineName: "", areaName: "", jobTitle: "", managerName: "" });
  };

  return (
    <div className="space-y-4">
      <div className="rounded-[18px] border border-slate-200 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search by name, HR ID, job title, line, area or manager…"
              className="h-11 w-full rounded-lg border border-slate-300 bg-white pl-9 pr-3 text-sm text-slate-900 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
              aria-label="Search employees"
            />
          </div>
          <button
            type="button"
            onClick={() => setShowFilters((v) => !v)}
            className={cn(
              "flex h-11 shrink-0 items-center justify-center gap-2 rounded-lg border px-4 text-sm font-bold transition",
              showFilters || activeFilterCount > 0
                ? "border-orange-500 bg-orange-50 text-orange-700"
                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-50",
            )}
          >
            <SlidersHorizontal className="h-4 w-4" />
            Filters
            {activeFilterCount > 0 ? (
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-orange-600 text-[10px] font-black text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </button>
        </div>

        {showFilters ? (
          <div className="grid grid-cols-1 gap-3 border-t border-slate-200 p-4 sm:grid-cols-2 lg:grid-cols-4">
            {FILTERS.map(({ key, label }) => (
              <label key={key} className="block">
                <span className="mb-1.5 block text-[11px] font-black uppercase tracking-wide text-slate-500">
                  {label}
                </span>
                <select
                  value={filters[key]}
                  onChange={(event) => setFilters((prev) => ({ ...prev, [key]: event.target.value }))}
                  className="h-10 w-full cursor-pointer rounded-lg border border-slate-300 bg-white px-2.5 text-sm text-slate-900 outline-none transition focus:border-orange-500 focus:ring-2 focus:ring-orange-500/20"
                >
                  <option value="">All {label.toLowerCase()}s</option>
                  {options[key].map((value) => (
                    <option key={value} value={value}>
                      {value}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        ) : null}

        {activeFilterCount > 0 || query ? (
          <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
            {query ? <FilterPill label={`"${query}"`} onClear={() => setQuery("")} /> : null}
            {FILTERS.map(({ key, label }) =>
              filters[key] ? (
                <FilterPill
                  key={key}
                  label={`${label}: ${filters[key]}`}
                  onClear={() => setFilters((prev) => ({ ...prev, [key]: "" }))}
                />
              ) : null,
            )}
            <button
              type="button"
              onClick={clearAll}
              className="ml-auto text-xs font-bold text-slate-500 underline-offset-2 hover:text-orange-600 hover:underline"
            >
              Clear all
            </button>
          </div>
        ) : null}
      </div>

      <div className="flex items-center justify-between text-xs font-semibold text-slate-500">
        <span>
          {filtered.length} of {employees.length} employees
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-[18px] border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm font-semibold text-slate-500">No matches.</p>
          <button type="button" onClick={clearAll} className="mt-2 text-xs font-bold text-orange-600 hover:underline">
            Clear search and filters
          </button>
        </div>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {filtered.map((e) => (
            <li key={e.hrId}>
              <Link
                href={`/employee-360/${encodeURIComponent(e.hrId)}`}
                className="group flex h-full items-start gap-3 rounded-[16px] border border-slate-200 bg-white p-4 shadow-sm transition hover:-translate-y-0.5 hover:border-orange-300 hover:shadow-[0_16px_32px_rgba(15,23,42,0.08)]"
              >
                <span
                  aria-hidden
                  className={cn(
                    "flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gradient-to-br text-xs font-black text-white",
                    avatarTone(e.hrId),
                  )}
                >
                  {initials(e.displayName)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-bold text-slate-900">{e.displayName}</span>
                    {e.employmentStatus && e.employmentStatus !== "active" ? (
                      <span className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-amber-700">
                        {e.employmentStatus.replace(/_/g, " ")}
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 truncate text-xs text-slate-500">{e.jobTitle || "—"}</div>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-slate-400">
                    <span className="rounded border border-slate-200 px-1.5 py-0.5 font-mono font-semibold text-slate-500">
                      {e.hrId.toUpperCase()}
                    </span>
                    {[e.lineName, e.areaName || e.regionName].filter(Boolean).map((v) => (
                      <span key={v}>{v}</span>
                    ))}
                  </div>
                  {e.managerName ? (
                    <div className="mt-1 truncate text-[11px] text-slate-400">Reports to {e.managerName}</div>
                  ) : null}
                </div>
                <ArrowRight className="mt-1 h-4 w-4 shrink-0 text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-orange-500" />
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterPill({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 py-1 pl-3 pr-1.5 text-xs font-semibold text-orange-700">
      {label}
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label}`}
        className="flex h-4 w-4 items-center justify-center rounded-full text-orange-500 hover:bg-orange-200 hover:text-orange-800"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
