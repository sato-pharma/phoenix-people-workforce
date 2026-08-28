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
      <summary className="flex h-[58px] cursor-pointer list-none items-center justify-between gap-3 rounded-[6px] border border-phx-line bg-white px-3 py-2 shadow-sm outline-none transition hover:border-phx-accent-line focus-visible:border-phx-accent-line [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
            {icon}
            {label}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="block truncate text-sm font-black text-phx-ink">{summary}</span>
            {count > 0 ? (
              <span
                className={cn(
                  "shrink-0 rounded-[3px] px-1 text-phx-3xs font-black uppercase tracking-wide text-white",
                  mode === "include" ? "bg-phx-accent" : "bg-phx-ink",
                )}
              >
                {mode === "include" ? "incl" : "excl"}
              </span>
            ) : null}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-phx-ink-faint transition group-open:rotate-180" />
      </summary>

      <div className="absolute left-0 top-full z-50 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-[6px] border border-phx-line bg-white shadow-lg">
        {/* Mode toggle + bulk actions */}
        <div className="flex items-center justify-between gap-2 border-b border-phx-line p-2">
          <div className="flex items-center rounded-[5px] border border-phx-line bg-phx-paper p-0.5">
            <button
              type="button"
              aria-label={`Include mode for ${label}`}
              onClick={() => onModeChange("include")}
              className={cn(
                "rounded-[4px] px-2 py-1 text-phx-2xs font-black uppercase tracking-wide transition",
                mode === "include" ? "bg-phx-accent text-white shadow-sm" : "text-phx-ink-soft hover:text-phx-ink",
              )}
            >
              Include
            </button>
            <button
              type="button"
              aria-label={`Exclude mode for ${label}`}
              onClick={() => onModeChange("exclude")}
              className={cn(
                "rounded-[4px] px-2 py-1 text-phx-2xs font-black uppercase tracking-wide transition",
                mode === "exclude" ? "bg-phx-ink text-white shadow-sm" : "text-phx-ink-soft hover:text-phx-ink",
              )}
            >
              Exclude
            </button>
          </div>
          <div className="flex items-center gap-2 text-phx-xs font-black">
            <button
              type="button"
              aria-label={`Select all ${label}`}
              className="text-phx-ink-soft transition hover:text-phx-accent"
              // "All" must mean "show every row," which is mode-dependent: in include mode that
              // means selecting every code (include + all codes = keep everything); in exclude
              // mode selecting every code would mean "exclude everything" (show ZERO rows) — the
              // opposite of what the button says — so exclude mode clears the selection instead
              // (exclude + no codes = keep everything).
              onClick={() => onSelectedChange(mode === "exclude" ? [] : options.map((option) => option.code))}
            >
              All
            </button>
            <span className="text-phx-line">|</span>
            <button
              type="button"
              aria-label={`Clear ${label} selection`}
              className="text-phx-ink-soft transition hover:text-phx-accent disabled:opacity-40"
              disabled={count === 0}
              onClick={() => onSelectedChange([])}
            >
              Clear
            </button>
          </div>
        </div>

        {searchable ? (
          <div className="border-b border-phx-line p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-faint" />
              <input
                type="text"
                aria-label={searchPlaceholder ?? `Search ${label.toLowerCase()}`}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={searchPlaceholder ?? `Search ${label.toLowerCase()}…`}
                className="h-8 w-full rounded-[5px] border border-phx-line bg-white pl-8 pr-7 text-sm font-medium text-phx-ink outline-none transition focus:border-phx-accent-line focus:ring-2 focus:ring-phx-accent/10"
              />
              {query ? (
                <button
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setQuery("")}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-phx-ink-faint transition hover:text-phx-accent"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="max-h-64 space-y-0.5 overflow-y-auto p-2">
          {visibleOptions.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs font-semibold text-phx-ink-faint">
              {options.length === 0 ? "No options." : "No matches."}
            </p>
          ) : (
            visibleOptions.map((option) => (
              <label
                key={option.code}
                className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm text-phx-ink transition hover:bg-phx-paper"
              >
                <input
                  type="checkbox"
                  aria-label={option.label}
                  className="h-4 w-4 accent-phx-accent"
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
