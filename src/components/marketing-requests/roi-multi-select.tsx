"use client";

import * as React from "react";
import { ChevronDown, Search, X } from "lucide-react";

// Include-only multiselect, matching the sales filter visual language. Extracted
// out of roi-filter-engine.tsx so the Marketing Coverage Report's filter panel can
// share the exact same control instead of forking it.
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
    <details className="group relative">
      <summary className="flex h-[58px] cursor-pointer list-none items-center justify-between gap-3 rounded-[6px] border border-[#E2E8F0] bg-white px-3 py-2 shadow-sm outline-none transition hover:border-[#FDBA74] focus-visible:border-[#FDBA74] [&::-webkit-details-marker]:hidden">
        <span className="min-w-0">
          <span className="mb-1 flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.14em] text-[#94A3B8]">{label}</span>
          <span className="flex items-center gap-1.5">
            <span className="block truncate text-sm font-black text-[#0F172A]">{summary}</span>
            {selected.length > 0 ? (
              <span className="shrink-0 rounded-[3px] bg-[#F97316] px-1 text-[9px] font-black uppercase tracking-wide text-white">incl</span>
            ) : null}
          </span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-[#94A3B8] transition group-open:rotate-180" />
      </summary>

      <div className="absolute left-0 top-full z-30 mt-2 w-[min(320px,calc(100vw-2rem))] rounded-[6px] border border-[#E2E8F0] bg-white shadow-lg">
        <div className="flex items-center justify-end gap-2 border-b border-[#E2E8F0] p-2 text-[11px] font-black">
          <button type="button" className="text-[#64748B] transition hover:text-[#F97316]" onClick={() => onChange(options.map((option) => option.value))}>
            All
          </button>
          <span className="text-[#E2E8F0]">|</span>
          <button
            type="button"
            className="text-[#64748B] transition hover:text-[#F97316] disabled:opacity-40"
            disabled={selected.length === 0}
            onClick={() => onChange([])}
          >
            Clear
          </button>
        </div>
        <div className="border-b border-[#E2E8F0] p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]" />
            <input
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${label.toLowerCase()}…`}
              className="h-8 w-full rounded-[5px] border border-[#E2E8F0] bg-white pl-8 pr-7 text-sm font-medium text-[#0F172A] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/10"
            />
            {query ? (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 -translate-y-1/2 text-[#94A3B8] transition hover:text-[#F97316]">
                <X className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        </div>
        <div className="max-h-64 space-y-0.5 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs font-semibold text-[#94A3B8]">{options.length === 0 ? "No options." : "No matches."}</p>
          ) : (
            visible.map((option) => (
              <label key={option.value} className="flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-sm text-[#0F172A] transition hover:bg-[#F8FAFC]">
                <input type="checkbox" className="h-4 w-4 accent-[#F97316]" checked={selectedSet.has(option.value)} onChange={() => toggle(option.value)} />
                <span className="flex-1 truncate">{option.label}</span>
                {typeof option.count === "number" ? <span className="shrink-0 text-[11px] font-bold text-[#94A3B8]">{option.count}</span> : null}
              </label>
            ))
          )}
        </div>
      </div>
    </details>
  );
}
