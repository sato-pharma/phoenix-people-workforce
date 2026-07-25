"use client";

import { ChevronDown, Search, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";

// Reusable multi-select filter with an include / exclude mode. A `<details>`-based dropdown that
// matches the Weekly `WeekDropdown` and the MonthlyClosing `MultiSelect` visual language (58px field,
// dark summary line, orange-accent checkboxes, square corners). Deliberately generic — it carries no
// product/distributor/region-specific logic, so a single component drives every sales filter.
//
// Semantics (both modes): an EMPTY selection means "All" (no narrowing).
//   include + codes -> keep only those codes.
//   exclude + codes -> keep everything except those codes.

export type MultiSelectFilterMode = "include" | "exclude";
export type MultiSelectFilterOption = { code: string; label: string };

type MultiSelectFilterProps = {
  label: string;
  icon?: React.ReactNode;
  options: MultiSelectFilterOption[];
  selected: string[];
  mode: MultiSelectFilterMode;
  onSelectedChange: (next: string[]) => void;
  onModeChange: (next: MultiSelectFilterMode) => void;
  /** Show the in-dropdown search box. Default true. */
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Chip text when nothing is selected. Default "All". */
  allLabel?: string;
  className?: string;
  disabled?: boolean;
};

function toggle(list: string[], code: string): string[] {
  return list.includes(code) ? list.filter((item) => item !== code) : [...list, code];
}

export function MultiSelectFilter({
  label,
  icon,
  options,
  selected,
  mode,
  onSelectedChange,
  onModeChange,
  searchable = true,
  searchPlaceholder,
  allLabel = "All",
  className,
  disabled = false,
}: MultiSelectFilterProps) {
  const [query, setQuery] = React.useState("");

  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const normalizedQuery = query.trim().toLowerCase();
  const visibleOptions = React.useMemo(() => {
    if (!normalizedQuery) return options;
    return options.filter(
      (option) =>
        option.label.toLowerCase().includes(normalizedQuery) || option.code.toLowerCase().includes(normalizedQuery),
    );
  }, [options, normalizedQuery]);

  const count = selected.length;
  const summary =
    count === 0 ? allLabel : mode === "include" ? `${count} included` : `All except ${count}`;

  return (
    <details className={cn("group relative", disabled && "pointer-events-none opacity-50", className)}>
      <summary className="flex h-[58px] cursor-pointer list-none items-center justify-between gap-3 rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm outline-none transition hover:border-[#FDBA74] focus-visible:border-[#FDBA74] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">
            {icon}
            {label}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="block truncate text-sm font-black text-[#0F172A]">{summary}</span>
            {count > 0 ? (
              <span
                className={cn(
                  "shrink-0 rounded-[3px] px-1 text-[9px] font-black uppercase tracking-wide text-white",
                  mode === "include" ? "bg-[#F97316]" : "bg-[#0F172A]",
                )}
              >
                {mode === "include" ? "incl" : "excl"}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[#94A3B8] transition group-open:rotate-180" />
      </summary>

      <div className="absolute left-0 top-full z-50 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-[6px] border border-[#E2E8F0] bg-white shadow-lg">
        {/* Mode toggle + bulk actions */}
        <div className="flex items-center justify-between gap-2 border-b border-[#E2E8F0] p-2">
          <div className="flex items-center rounded-[5px] border border-[#E2E8F0] bg-[#F8FAFC] p-0.5">
            <button
              type="button"
              aria-label={`Include mode for ${label}`}
              onClick={() => onModeChange("include")}
              className={cn(
                "rounded-[4px] px-2 py-1 text-[10px] font-black uppercase tracking-wide transition",
                mode === "include" ? "bg-[#F97316] text-white shadow-sm" : "text-[#64748B] hover:text-[#0F172A]",
              )}
            >
              Include
            </button>
            <button
              type="button"
              aria-label={`Exclude mode for ${label}`}
              onClick={() => onModeChange("exclude")}
              className={cn(
                "rounded-[4px] px-2 py-1 text-[10px] font-black uppercase tracking-wide transition",
                mode === "exclude" ? "bg-[#0F172A] text-white shadow-sm" : "text-[#64748B] hover:text-[#0F172A]",
              )}
            >
              Exclude
            </button>
          </div>
          <div className="flex items-center gap-2 text-[11px] font-black">
            <button
              type="button"
              aria-label={`Select all ${label}`}
              className="text-[#64748B] transition hover:text-[#F97316]"
              // "All" must mean "show every row," which is mode-dependent: in include mode that
              // means selecting every code (include + all codes = keep everything); in exclude
              // mode selecting every code would mean "exclude everything" (show ZERO rows) — the
              // opposite of what the button says — so exclude mode clears the selection instead
              // (exclude + no codes = keep everything).
              onClick={() => onSelectedChange(mode === "exclude" ? [] : options.map((option) => option.code))}
            >
              All
            </button>
            <span className="text-[#E2E8F0]">|</span>
            <button
              type="button"
              aria-label={`Clear ${label} selection`}
              className="text-[#64748B] transition hover:text-[#F97316] disabled:opacity-40"
              disabled={count === 0}
              onClick={() => onSelectedChange([])}
            >
              Clear
            </button>
          </div>
        </div>

        {searchable ? (
          <div className="border-b border-[#E2E8F0] p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]" />
              <input
                type="text"
                aria-label={searchPlaceholder ?? `Search ${label.toLowerCase()}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
                className="h-8 w-full rounded-[5px] border border-[#E2E8F0] bg-white pl-8 pr-7 text-sm font-medium text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/10"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94A3B8] transition hover:text-[#F97316]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="max-h-64 space-y-0.5 overflow-y-auto p-2">
          {visibleOptions.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs font-semibold text-[#94A3B8]">
              {options.length === 0 ? "No options." : "No matches."}
            </p>
          ) : (
            visibleOptions.map((option) => (
              <label
                key={option.code}
                className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm text-[#0F172A] transition hover:bg-[#F8FAFC]"
              >
                <input
                  type="checkbox"
                  aria-label={option.label}
                  className="h-4 w-4 accent-[#F97316]"
                  checked={selectedSet.has(option.code)}
                  onChange={() => onSelectedChange(toggle(selected, option.code))}
                />
                <span className="truncate">{option.label}</span>
              </label>
            ))
          )}
        </div>
      </div>
    </details>
  );
}
