"use client";

import * as React from "react";
import { ChevronDown, Search, X } from "lucide-react";

import { useDropdownPanelPlacement } from "@/hooks/use-dropdown-panel-placement";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

// Include-only multiselect, matching the sales filter visual language. Extracted
// out of roi-filter-engine.tsx so the Marketing Coverage Report's filter panel can
// share the exact same control instead of forking it. Square corners, wrapped text and a panel kept
// on the screen, as MultiSelectFilter; pinned by tests/multi-select-filter-fits.test.ts.
export function RoiMultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: Array<{ value: string; label: string; count?: number }>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [query, setQuery] = React.useState("");
  const { detailsRef, onSummaryClick, onToggle, panelStyle } = useDropdownPanelPlacement();
  const selectedSet = React.useMemo(() => new Set(selected), [selected]);
  const normalized = query.trim().toLowerCase();
  const visible = normalized
    ? options.filter((option) => option.label.toLowerCase().includes(normalized) || option.value.toLowerCase().includes(normalized))
    : options;
  const summary = selected.length === 0 ? "All" : `${selected.length} selected`;

  function toggle(value: string) {
    onChange(selectedSet.has(value) ? selected.filter((item) => item !== value) : [...selected, value]);
  }

  return (
    <details ref={detailsRef} className="group relative" onToggle={onToggle}>
      {/* The closed control keeps the FORM ground — its border, background and focus ring belong to
          the one form design (AGENTS.md §4), so only depth is added here, never the surface. */}
      <summary
        className="flex min-h-[58px] cursor-pointer list-none items-center justify-between gap-3 border border-phx-line bg-white px-3 py-2 shadow-[0_1px_2px_rgba(15,23,42,0.05),0_8px_18px_rgba(15,23,42,0.04)] outline-none transition hover:border-phx-accent-line focus-visible:border-phx-accent-line [&::-webkit-details-marker]:hidden"
        onClick={onSummaryClick}
      >
        <span className="min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-phx-sm font-black uppercase tracking-[0.14em] text-phx-ink-faint">
            <span className="min-w-0 break-words">{label}</span>
          </span>
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="min-w-0 break-words text-sm font-black text-phx-ink">{summary}</span>
            {selected.length > 0 ? (
              <span className="shrink-0 bg-phx-accent px-1 text-phx-xs font-black uppercase tracking-wide text-white">incl</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-phx-ink-faint transition group-open:rotate-180" />
      </summary>

      <div className="absolute left-0 top-full z-30 mt-2 w-[320px] max-w-full border border-phx-line bg-white shadow-[0_2px_4px_rgba(15,23,42,0.08),0_18px_44px_rgba(15,23,42,0.14)]" style={panelStyle}>
        <div className="flex items-center justify-end gap-2 border-b border-phx-line p-2 text-phx-xs font-black">
          <button type="button" aria-label={`Select all ${label}`} className="text-phx-ink-soft transition hover:text-phx-accent" onClick={() => onChange(options.map((option) => option.value))}>
            All
          </button>
          <span className="text-phx-line">|</span>
          <button
            type="button"
            aria-label={`Clear ${label} selection`}
            className="text-phx-ink-soft transition hover:text-phx-accent disabled:opacity-40"
            disabled={selected.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </button>
        </div>
        <div className="border-b border-phx-line p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-faint" />
            <input
              type="text"
              aria-label={`Search ${label.toLowerCase()}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className={cn(phxFieldClassName, "pl-8 pr-7")}
            />
            {query ? (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-phx-ink-faint transition hover:text-phx-accent">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs font-semibold text-phx-ink-faint">{options.length === 0 ? "No options." : "No matches."}</p>
          ) : (
            visible.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-sm text-phx-ink transition hover:bg-phx-paper">
                <input type="checkbox" aria-label={option.label} className="mt-0.5 h-4 w-4 shrink-0 accent-phx-accent" checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} />
                <span className="min-w-0 flex-1 break-words">{option.label}</span>
                {typeof option.count === "number" ? <span className="shrink-0 text-phx-xs font-bold text-phx-ink-faint">{option.count}</span> : null}
              </label>
            ))
          )}
        </div>
      </div>
    </details>
  );
}
