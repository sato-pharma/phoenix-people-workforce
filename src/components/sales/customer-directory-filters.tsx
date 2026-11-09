"use client";

import { ChevronDown, RotateCcw, Search } from "lucide-react";
import { useMemo } from "react";

import type { CustomerDirectoryFilterOptions } from "@/lib/sales/customer-directory";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxFieldClassName,
  phxSelectClassName,
} from "@/components/ui/form-tokens";


export type CustomerDirectoryFilterState = {
  areaCodes: string[];
  brickCodes: string[];
  distributorCodes: string[];
  fromPeriod: string;
  regionCodes: string[];
  search: string;
  toPeriod: string;
};

export const emptyCustomerDirectoryFilterState: CustomerDirectoryFilterState = {
  areaCodes: [],
  brickCodes: [],
  distributorCodes: [],
  fromPeriod: "",
  regionCodes: [],
  search: "",
  toPeriod: "",
};

type Option = { areaCode?: string; code: string; label: string; regionCode?: string };

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
      <div className="absolute left-0 z-40 mt-1 max-h-72 w-72 overflow-auto border border-phx-line bg-white p-2 shadow-[0_18px_42px_rgba(15,23,42,0.16)]">
        <div className="mb-2 flex items-center justify-between border-b border-slate-100 pb-2">
          <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">{count} selected</span>
          <button className="text-xs font-bold text-phx-accent hover:underline" onClick={onClear} type="button">Clear</button>
        </div>
        {options.length === 0 ? (
          <p className="px-2 py-3 text-xs text-slate-400">No options.</p>
        ) : (
          options.map((option) => (
            <label
              className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-slate-700 transition hover:bg-orange-50/60"
              key={option.code}
            >
              <input
                checked={selected.includes(option.code)}
                className="h-4 w-4 accent-phx-accent"
                onChange={() => onToggle(option.code)}
                type="checkbox"
              />
              <span className="truncate">{option.label}</span>
            </label>
          ))
        )}
      </div>
    </details>
  );
}

export function CustomerDirectoryFilters({
  onChange,
  options,
  value,
}: {
  onChange: (next: CustomerDirectoryFilterState) => void;
  options: CustomerDirectoryFilterOptions;
  value: CustomerDirectoryFilterState;
}) {
  // Cascade: areas narrow to selected regions; bricks narrow to selected areas/regions.
  const visibleAreas = useMemo(
    () =>
      value.regionCodes.length === 0
        ? options.areas
        : options.areas.filter((area) => area.regionCode && value.regionCodes.includes(area.regionCode)),
    [options.areas, value.regionCodes],
  );
  const visibleBricks = useMemo(
    () =>
      options.bricks.filter((brick) => {
        if (value.areaCodes.length > 0) return brick.areaCode && value.areaCodes.includes(brick.areaCode);
        if (value.regionCodes.length > 0) return brick.regionCode && value.regionCodes.includes(brick.regionCode);
        return true;
      }),
    [options.bricks, value.areaCodes, value.regionCodes],
  );

  const hasFilters =
    value.regionCodes.length > 0 ||
    value.areaCodes.length > 0 ||
    value.brickCodes.length > 0 ||
    value.distributorCodes.length > 0 ||
    value.fromPeriod !== "" ||
    value.toPeriod !== "" ||
    value.search.trim() !== "";

  function setRegions(next: string[]) {
    const allowedAreas = new Set(
      (next.length === 0 ? options.areas : options.areas.filter((a) => a.regionCode && next.includes(a.regionCode))).map(
        (a) => a.code,
      ),
    );
    const areaCodes = value.areaCodes.filter((code) => allowedAreas.has(code));
    const allowedBricks = new Set(
      options.bricks
        .filter((b) => (areaCodes.length > 0 ? b.areaCode && areaCodes.includes(b.areaCode) : next.length === 0 || (b.regionCode && next.includes(b.regionCode))))
        .map((b) => b.code),
    );
    onChange({ ...value, areaCodes, brickCodes: value.brickCodes.filter((code) => allowedBricks.has(code)), regionCodes: next });
  }

  function setAreas(next: string[]) {
    const allowedBricks = new Set(
      (next.length === 0 ? visibleBricks : options.bricks.filter((b) => b.areaCode && next.includes(b.areaCode))).map((b) => b.code),
    );
    onChange({ ...value, areaCodes: next, brickCodes: value.brickCodes.filter((code) => allowedBricks.has(code)) });
  }

  const periodSelect =
    phxSelectClassName;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <MultiSelect
        label="Regions"
        onClear={() => setRegions([])}
        onToggle={(code) => setRegions(toggle(value.regionCodes, code))}
        options={options.regions}
        selected={value.regionCodes}
      />
      <MultiSelect
        label="Areas"
        onClear={() => setAreas([])}
        onToggle={(code) => setAreas(toggle(value.areaCodes, code))}
        options={visibleAreas}
        selected={value.areaCodes}
      />
      <MultiSelect
        label="Bricks"
        onClear={() => onChange({ ...value, brickCodes: [] })}
        onToggle={(code) => onChange({ ...value, brickCodes: toggle(value.brickCodes, code) })}
        options={visibleBricks}
        selected={value.brickCodes}
      />
      <MultiSelect
        label="Distributors"
        onClear={() => onChange({ ...value, distributorCodes: [] })}
        onToggle={(code) => onChange({ ...value, distributorCodes: toggle(value.distributorCodes, code) })}
        options={options.distributors}
        selected={value.distributorCodes}
      />
      <div className="flex items-center gap-1">
        <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">Period</span>
        <SearchableSelect
          aria-label="From period"
          className={periodSelect}
          onChange={(event) => onChange({ ...value, fromPeriod: event.target.value })}
          value={value.fromPeriod}
        >
          <option value="">All</option>
          {options.periods.map((period) => (
            <option key={period} value={period}>{period}</option>
          ))}
        </SearchableSelect>
        <span className="text-xs text-slate-400">to</span>
        <SearchableSelect
          aria-label="To period"
          className={periodSelect}
          onChange={(event) => onChange({ ...value, toPeriod: event.target.value })}
          value={value.toPeriod}
        >
          <option value="">All</option>
          {options.periods.map((period) => (
            <option key={period} value={period}>{period}</option>
          ))}
        </SearchableSelect>
      </div>
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          className={cn(phxFieldClassName, "w-56 pl-9")}
          onChange={(event) => onChange({ ...value, search: event.target.value })}
          placeholder="Search name / code…"
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
        onClick={() => onChange(emptyCustomerDirectoryFilterState)}
        type="button"
      >
        <RotateCcw className="h-4 w-4" />
        Reset
      </button>
    </div>
  );
}
