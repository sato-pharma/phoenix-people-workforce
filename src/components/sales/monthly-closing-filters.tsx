"use client";

import { ChevronDown, RotateCcw, Search } from "lucide-react";
import { useMemo } from "react";

import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";

export type MonthlyClosingFilter = {
  areaCodes: string[];
  productCodes: string[];
  regionCodes: string[];
  search: string;
};

export const emptyMonthlyClosingFilter: MonthlyClosingFilter = {
  areaCodes: [],
  productCodes: [],
  regionCodes: [],
  search: "",
};

type Option = { code: string; label: string; regionCode?: string };

function toggle(list: string[], code: string) {
  return list.includes(code) ? list.filter((item) => item !== code) : [...list, code];
}

function MultiSelect({
  label,
  onClear,
  onToggle,
  options,
  selected,
}: {
  label: string;
  onClear: () => void;
  onToggle: (code: string) => void;
  options: Option[];
  selected: string[];
}) {
  const count = selected.length;
  return (
    <details className="group relative">
      <summary className="flex h-10 cursor-pointer list-none items-center gap-2 border border-phx-line bg-white px-3 text-sm font-semibold text-phx-ink transition hover:border-phx-accent-line [&::-webkit-details-marker]:hidden">
        {label}
        {count > 0 ? (
          <span className="bg-phx-accent px-1.5 text-xs font-black text-white">{count}</span>
        ) : (
          <span className="text-xs font-normal text-slate-400">All</span>
        )}
        <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
      </summary>
      {/* z-50 on purpose: the closing matrix's sticky Area / Area Name headers sit at z-40, and an
          equal z-index would let the later-in-DOM table header paint over this panel and eat its
          clicks. Keep this above whatever the table uses. */}
      <div className="absolute left-0 z-50 mt-1 max-h-72 w-64 overflow-auto border border-phx-line bg-white p-2 shadow-[0_18px_42px_rgba(15,23,42,0.16)]">
        <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-2">
          <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">{count} selected</span>
          <button className="text-xs font-bold text-phx-accent hover:underline" onClick={onClear} type="button">Clear</button>
        </div>
        {/*
          `items-start` + `break-words` on each option, never `truncate`: this is the list you pick
          an area from, so cutting the end of a name hides the very thing being chosen. Measured on
          2026-09-26 at 1440px, two real options were being cut with an ellipsis — "Dokki -
          Mohandseen - Bolak (GZ2)" lost 32px and "Imbaba - Imbaba Centers (GZ3)" lost 14px.
          Nothing is truncated with an ellipsis (AGENTS.md §4), so a long option takes a second
          line and the checkbox stays aligned to the first one.
        */}
        {options.length === 0 ? (
          <p className="px-2 py-3 text-xs text-slate-400">No options.</p>
        ) : (
          options.map((option) => (
            <label
              className="flex cursor-pointer items-start gap-2 px-2 py-1.5 text-sm text-slate-700 transition hover:bg-orange-50/60"
              key={option.code}
            >
              <input
                checked={selected.includes(option.code)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-phx-accent"
                onChange={() => onToggle(option.code)}
                type="checkbox"
              />
              <span className="min-w-0 break-words">{option.label}</span>
            </label>
          ))
        )}
      </div>
    </details>
  );
}

export function MonthlyClosingFilters({
  areas,
  onChange,
  products,
  regions,
  value,
}: {
  areas: Option[];
  onChange: (next: MonthlyClosingFilter) => void;
  products: Option[];
  regions: Option[];
  value: MonthlyClosingFilter;
}) {
  // Areas narrow to the selected regions; prune any area selections that fall out of scope.
  const visibleAreas = useMemo(
    () =>
      value.regionCodes.length === 0
        ? areas
        : areas.filter((area) => area.regionCode && value.regionCodes.includes(area.regionCode)),
    [areas, value.regionCodes],
  );

  const hasFilters =
    value.regionCodes.length > 0 ||
    value.areaCodes.length > 0 ||
    value.productCodes.length > 0 ||
    value.search.trim().length > 0;

  function setRegions(next: string[]) {
    const allowed = new Set(
      (next.length === 0 ? areas : areas.filter((area) => area.regionCode && next.includes(area.regionCode))).map(
        (area) => area.code,
      ),
    );
    onChange({ ...value, regionCodes: next, areaCodes: value.areaCodes.filter((code) => allowed.has(code)) });
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MultiSelect
        label="Regions"
        onClear={() => setRegions([])}
        onToggle={(code) => setRegions(toggle(value.regionCodes, code))}
        options={regions}
        selected={value.regionCodes}
      />
      <MultiSelect
        label="Areas"
        onClear={() => onChange({ ...value, areaCodes: [] })}
        onToggle={(code) => onChange({ ...value, areaCodes: toggle(value.areaCodes, code) })}
        options={visibleAreas}
        selected={value.areaCodes}
      />
      <MultiSelect
        label="Products"
        onClear={() => onChange({ ...value, productCodes: [] })}
        onToggle={(code) => onChange({ ...value, productCodes: toggle(value.productCodes, code) })}
        options={products}
        selected={value.productCodes}
      />
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className={cn(phxFieldClassName, "w-52 pl-9")}
          onChange={(event) => onChange({ ...value, search: event.target.value })}
          placeholder="Search area…"
          type="text"
          value={value.search}
        />
      </div>
      <button
        className={cn(
          "flex h-10 items-center gap-2 border border-phx-line bg-white px-3 text-sm font-bold text-slate-600 transition hover:border-phx-accent-line hover:text-phx-accent",
          !hasFilters && "opacity-50",
        )}
        disabled={!hasFilters}
        onClick={() => onChange(emptyMonthlyClosingFilter)}
        type="button"
      >
        <RotateCcw className="h-4 w-4" />
        Reset
      </button>
    </div>
  );
}
