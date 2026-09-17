"use client";

import { ChevronDown, Search, X } from "lucide-react";
import * as React from "react";

import { useDropdownPanelPlacement } from "@/hooks/use-dropdown-panel-placement";
import { cn } from "@/lib/utils";

// Reusable multi-select filter with an include / exclude mode. A `<details>`-based dropdown that
// matches the Weekly `WeekDropdown` and the MonthlyClosing `MultiSelect` visual language (58px field,
// dark summary line, orange-accent checkboxes, square corners). Deliberately generic — it carries no
// product/distributor/region-specific logic, so a single component drives every sales filter.
//
// Square corners, text that wraps and a panel that stays on the screen are the owner's golden rules
// (AGENTS.md §4), pinned by tests/multi-select-filter-fits.test.ts. The panel is placed by
// useDropdownPanelPlacement: a trigger in the right half of its room hangs it from its right edge,
// and no panel crosses the screen's edge or `main`'s.
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
  const panel = useDropdownPanelPlacement();

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
    <details
      ref={panel.detailsRef}
      className={cn("group relative", disabled && "pointer-events-none opacity-50", className)}
      onToggle={panel.onToggle}
    >
      <summary
        className="flex min-h-[58px] cursor-pointer list-none items-center justify-between gap-3 border border-phx-line bg-white px-3 py-2 shadow-sm outline-none transition hover:border-phx-accent-line focus-visible:border-phx-accent-line [&::-webkit-details-marker]:hidden"
        onClick={panel.onSummaryClick}
      >
        <span className="min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-phx-2xs font-black uppercase tracking-[0.14em] text-phx-ink-faint">
            {icon}
            <span className="min-w-0 break-words">{label}</span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-words text-sm font-black text-phx-ink">{summary}</span>
            {count > 0 ? (
              <span
                className={cn(
                  "shrink-0 px-1 text-phx-3xs font-black uppercase tracking-wide text-white",
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

      <div
        className="absolute left-0 top-full z-50 mt-2 w-[320px] max-w-full border border-phx-line bg-white shadow-lg"
        style={panel.panelStyle}
      >
        {/* Mode toggle + bulk actions */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line p-2">
          <div className="flex items-center border border-phx-line bg-phx-paper p-0.5">
            <button
              type="button"
              aria-label={`Include mode for ${label}`}
              onClick={() => onModeChange("include")}
              className={cn(
                "px-2 py-1 text-phx-2xs font-black uppercase tracking-wide transition",
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
                "px-2 py-1 text-phx-2xs font-black uppercase tracking-wide transition",
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
                className="h-8 w-full border border-phx-line bg-white pl-8 pr-7 text-sm font-medium text-phx-ink outline-none transition focus:border-phx-accent-line focus:ring-2 focus:ring-phx-accent/10"
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
                className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-sm text-phx-ink transition hover:bg-phx-paper"
              >
                <input
                  type="checkbox"
                  aria-label={option.label}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-phx-accent"
                  checked={selectedSet.has(option.code)}
                  onChange={() => onSelectedChange(toggle(selected, option.code))}
                />
                <span className="min-w-0 break-words">{option.label}</span>
              </label>
            ))
          )}
        </div>
      </div>
    </details>
  );
}
