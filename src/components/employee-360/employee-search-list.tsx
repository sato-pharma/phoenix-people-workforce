"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  ArrowRight,
  Flag,
  GraduationCap,
  Map as MapIcon,
  Package,
  Search,
  SlidersHorizontal,
  Stethoscope,
  Users,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";
import {
  EMPLOYEE_360_ROLE_META,
  EMPLOYEE_360_ROLE_ORDER,
  type Employee360RoleCategory,
} from "@/lib/employee-360/roles";

export type Employee360ListItem = {
  hrId: string;
  displayName: string;
  jobTitle: string | null;
  lineName: string | null;
  areaName: string | null;
  regionName: string | null;
  managerName: string | null;
  employmentStatus: string | null;
  category: Employee360RoleCategory;
};

const TAB_ICON: Record<Employee360RoleCategory, LucideIcon> = {
  "medical-rep": Stethoscope,
  "district-manager": Users,
  "regional-manager": MapIcon,
  "national-sales-manager": Flag,
  "product-manager": Package,
  "training-manager": GraduationCap,
};

type FilterKey = "lineName" | "areaName" | "managerName";

const FILTERS: { key: FilterKey; label: string }[] = [
  { key: "lineName", label: "Line" },
  { key: "areaName", label: "Area" },
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
  const countByCategory = useMemo(() => {
    const map = new Map<Employee360RoleCategory, number>();
    for (const e of employees) map.set(e.category, (map.get(e.category) ?? 0) + 1);
    return map;
  }, [employees]);

  // Tabs only for role families that actually have someone visible to this viewer.
  const tabs = useMemo(
    () => EMPLOYEE_360_ROLE_ORDER.filter((c) => (countByCategory.get(c) ?? 0) > 0),
    [countByCategory],
  );

  const [activeTab, setActiveTab] = useState<Employee360RoleCategory>(tabs[0] ?? "medical-rep");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Record<FilterKey, string>>({ lineName: "", areaName: "", managerName: "" });
  const [showFilters, setShowFilters] = useState(false);

  const inTab = useMemo(() => employees.filter((e) => e.category === activeTab), [employees, activeTab]);

  const options = useMemo(
    () => ({
      lineName: uniqueSorted(inTab.map((e) => e.lineName)),
      areaName: uniqueSorted(inTab.map((e) => e.areaName)),
      managerName: uniqueSorted(inTab.map((e) => e.managerName)),
    }),
    [inTab],
  );

  const activeFilterCount = Object.values(filters).filter(Boolean).length;

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return inTab.filter((e) => {
      if (filters.lineName && e.lineName !== filters.lineName) return false;
      if (filters.areaName && e.areaName !== filters.areaName) return false;
      if (filters.managerName && e.managerName !== filters.managerName) return false;
      if (!q) return true;
      return [e.displayName, e.hrId, e.jobTitle, e.lineName, e.areaName, e.regionName, e.managerName]
        .filter(Boolean)
        .some((field) => String(field).toLowerCase().includes(q));
    });
  }, [inTab, query, filters]);

  const clearAll = () => {
    setQuery("");
    setFilters({ lineName: "", areaName: "", managerName: "" });
  };

  const switchTab = (c: Employee360RoleCategory) => {
    setActiveTab(c);
    clearAll();
    setShowFilters(false);
  };

  const meta = EMPLOYEE_360_ROLE_META[activeTab];

  return (
    <div className="space-y-4">
      {/* Role tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {tabs.map((c) => {
          const Icon = TAB_ICON[c];
          const active = c === activeTab;
          return (
            <button
              key={c}
              type="button"
              onClick={() => switchTab(c)}
              className={cn(
                "flex shrink-0 items-center gap-2 rounded-full border px-4 py-2 text-sm font-bold transition",
                active
                  ? "border-orange-500 bg-orange-500 text-white shadow-[0_6px_16px_rgba(249,115,22,0.28)]"
                  : "border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:bg-slate-50",
              )}
            >
              <Icon className="h-4 w-4" />
              {EMPLOYEE_360_ROLE_META[c].tab}
              <span
                className={cn(
                  "flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[10px] font-black",
                  active ? "bg-white/25 text-white" : "bg-slate-100 text-slate-500",
                )}
              >
                {countByCategory.get(c) ?? 0}
              </span>
            </button>
          );
        })}
      </div>

      <p className="px-0.5 text-xs text-slate-500">{meta.description}</p>

      {/* Search + filters */}
      <div className="rounded-[18px] border border-slate-200 bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
        <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${meta.label.toLowerCase()} by name, HR ID, line, area or manager…`}
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
          <div className="grid grid-cols-1 gap-3 border-t border-slate-200 p-4 sm:grid-cols-3">
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
          {filtered.length} of {inTab.length} {meta.label.toLowerCase()}
        </span>
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-[18px] border border-dashed border-slate-300 bg-white p-10 text-center">
          <p className="text-sm font-semibold text-slate-500">No matches in {meta.label}.</p>
          {query || activeFilterCount > 0 ? (
            <button type="button" onClick={clearAll} className="mt-2 text-xs font-bold text-orange-600 hover:underline">
              Clear search and filters
            </button>
          ) : null}
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
