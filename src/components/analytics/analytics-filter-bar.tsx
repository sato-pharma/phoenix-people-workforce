"use client";

// Shared filter bar for analytics dashboards. Renders one control per filter
// descriptor (multi-select / single-select / text-search) and writes changes
// back to the page's own URL via router.push — these analytics pages are
// server components reading searchParams, so a URL change is what re-triggers
// the data fetch (mirrors the useSearchParams + router.push pattern already
// used in src/components/sales/sales-performance-page.tsx).
//
// All multi-select filters ship in include-only mode this pass: the analytics
// RPCs only support `= any(array)` filtering, so the MultiSelectFilter's
// include/exclude toggle is wired to a no-op for "exclude" (deliberate scope
// cut, not an oversight — see docs/analytics/sales-analytics-model.md).

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { GitCompare } from "lucide-react";

import { MultiSelectFilter, type MultiSelectFilterOption } from "@/components/ui/multi-select-filter";
import type { FilterDescriptor, FilterValues } from "@/lib/analytics/filter-registry";
import type { AnalyticsDimensions } from "@/lib/analytics/service";
import type { AnalyticsFilterVisibility } from "@/lib/analytics/scope";

type AnalyticsFilterBarProps = {
  descriptors: FilterDescriptor[];
  values: FilterValues;
  dimensions: AnalyticsDimensions;
  basePath: string;
  /** Period-scoped customer options, derived by the page from already-fetched rows. */
  customers?: MultiSelectFilterOption[];
  /** Show a "Compare" toggle that writes/clears `?compare=1` (gates a comparison table on the page). */
  comparable?: boolean;
  /** Per-viewer filter visibility — hide the Line/Region picker when the viewer is bound to a single one. */
  visibility?: AnalyticsFilterVisibility;
};

function optionsFor(
  descriptor: FilterDescriptor,
  dimensions: AnalyticsDimensions,
  customers: MultiSelectFilterOption[],
): MultiSelectFilterOption[] {
  switch (descriptor.source) {
    case "static":
      return (descriptor.staticOptions ?? []).map((o) => ({ code: o.value, label: o.label }));
    case "periods":
      return dimensions.periods.map((p) => ({ code: p.period, label: p.periodLabel || p.period }));
    case "weeks":
      return dimensions.weeks.map((w) => ({ code: w.weekStart, label: w.weekLabel || w.weekStart }));
    case "distributors":
      return dimensions.distributors.map((d) => ({ code: d.code, label: d.name }));
    case "products":
      return dimensions.products.map((p) => ({ code: p.code, label: p.name }));
    case "families":
      return dimensions.families.map((f) => ({ code: f, label: f }));
    case "lines":
      return dimensions.lines.map((l) => ({ code: l, label: l }));
    case "regions":
      return dimensions.regions.map((r) => ({ code: r.code, label: r.name }));
    case "areas":
      return dimensions.areas.map((a) => ({ code: a.areaCode, label: a.areaName }));
    case "customers":
      return customers;
    default:
      return [];
  }
}

// Owns the in-progress keystroke locally instead of mirroring `values[key]` directly —
// that prop only updates ~300ms later via the debounce → router.push → server round-trip,
// so a plain controlled input snaps back to the stale value mid-keystroke. `lastPushedRef`
// tracks what THIS field last typed so its own round-trip confirmation doesn't clobber
// newer local typing; an external change (e.g. a "clear filters" action elsewhere) still
// gets adopted because it won't match the ref.
function TextSearchFilterField({
  current,
  descriptorKey,
  label,
  onDebouncedChange,
  placeholder,
}: {
  current: string;
  descriptorKey: string;
  label: string;
  onDebouncedChange: (key: string, value: string) => void;
  placeholder?: string;
}) {
  const [localValue, setLocalValue] = React.useState(current);
  const lastPushedRef = React.useRef(current);

  React.useEffect(() => {
    if (current !== lastPushedRef.current) {
      setLocalValue(current);
      lastPushedRef.current = current;
    }
  }, [current]);

  return (
    <label className="flex h-[58px] w-full flex-col justify-center gap-1 border border-phx-line bg-white px-3 py-2 shadow-sm transition hover:border-phx-accent-line focus-within:border-phx-accent-line sm:w-auto sm:min-w-[180px]">
      <span className="text-[10px] font-black uppercase tracking-[0.14em] text-phx-ink-faint">{label}</span>
      <input
        type="text"
        value={localValue}
        placeholder={placeholder}
        onChange={(event) => {
          const value = event.target.value;
          setLocalValue(value);
          lastPushedRef.current = value;
          onDebouncedChange(descriptorKey, value);
        }}
        className="border-none bg-transparent p-0 text-sm font-black text-phx-ink outline-none placeholder:font-medium placeholder:text-phx-ink-faint"
      />
    </label>
  );
}

export function AnalyticsFilterBar({ descriptors, values, dimensions, basePath, customers = [], comparable = false, visibility }: AnalyticsFilterBarProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const debounceRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const descriptorKeys = React.useMemo(() => new Set(descriptors.map((d) => d.key)), [descriptors]);

  // Start from the CURRENT url params (not a blank slate) so page-level flags
  // outside the filter registry — `compare`, `demo` — survive a filter change
  // instead of silently disappearing.
  const pushValues = React.useCallback(
    (next: FilterValues) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const key of descriptorKeys) params.delete(key);
      for (const [key, value] of Object.entries(next)) {
        if (value === null || value === undefined || value === "") continue;
        if (Array.isArray(value)) {
          for (const v of value) if (v) params.append(key, v);
        } else {
          params.set(key, String(value));
        }
      }
      router.push(`${basePath}?${params.toString()}`);
    },
    [basePath, router, searchParams, descriptorKeys],
  );

  const setValue = React.useCallback(
    (key: string, value: string | string[] | null) => {
      pushValues({ ...values, [key]: value });
    },
    [pushValues, values],
  );

  const setDebouncedValue = React.useCallback(
    (key: string, value: string) => {
      if (debounceRef.current[key]) clearTimeout(debounceRef.current[key]);
      debounceRef.current[key] = setTimeout(() => setValue(key, value || null), 300);
    },
    [setValue],
  );

  const comparing = searchParams.get("compare") === "1";
  const toggleCompare = React.useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    if (comparing) params.delete("compare");
    else params.set("compare", "1");
    router.push(`${basePath}?${params.toString()}`);
  }, [basePath, router, searchParams, comparing]);

  return (
    <div className="flex flex-wrap items-end gap-3">
      {descriptors.map((descriptor) => {
        // Hide a dimension's picker when the viewer is scoped to a single value for it (nothing to choose).
        if (visibility && descriptor.key === "lines" && !visibility.line) return null;
        if (visibility && descriptor.key === "regions" && !visibility.region) return null;
        if (descriptor.type === "multi-select") {
          const options = optionsFor(descriptor, dimensions, customers);
          const selectedRaw = values[descriptor.key];
          const selected = Array.isArray(selectedRaw) ? selectedRaw : [];
          return (
            <MultiSelectFilter
              key={descriptor.key}
              label={descriptor.label}
              options={options}
              selected={selected}
              mode="include"
              onSelectedChange={(next) => setValue(descriptor.key, next)}
              onModeChange={() => {
                // Exclude mode is out of scope this pass — the RPCs only support
                // include-style `= any(array)` filtering. Intentional no-op.
              }}
              searchPlaceholder={descriptor.placeholder}
              className="w-full sm:w-[220px]"
            />
          );
        }

        if (descriptor.type === "single-select") {
          const options = optionsFor(descriptor, dimensions, customers);
          const currentRaw = values[descriptor.key];
          const current = typeof currentRaw === "string" ? currentRaw : "";
          return (
            <label
              key={descriptor.key}
              className="flex h-[58px] w-full flex-col justify-center gap-1 border border-phx-line bg-white px-3 py-2 shadow-sm transition hover:border-phx-accent-line focus-within:border-phx-accent-line sm:w-auto sm:min-w-[160px]"
            >
              <span className="text-[10px] font-black uppercase tracking-[0.14em] text-phx-ink-faint">{descriptor.label}</span>
              <select
                value={current}
                onChange={(event) => setValue(descriptor.key, event.target.value || null)}
                className="border-none bg-transparent p-0 text-sm font-black text-phx-ink outline-none"
              >
                <option value="">{descriptor.placeholder ?? "All"}</option>
                {options.map((option) => (
                  <option key={option.code} value={option.code}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        }

        // text-search (and any other type) — debounced free-text input
        const currentRaw = values[descriptor.key];
        const current = typeof currentRaw === "string" ? currentRaw : "";
        return (
          <TextSearchFilterField
            key={descriptor.key}
            current={current}
            descriptorKey={descriptor.key}
            label={descriptor.label}
            onDebouncedChange={setDebouncedValue}
            placeholder={descriptor.placeholder}
          />
        );
      })}
      {comparable ? (
        <button
          type="button"
          onClick={toggleCompare}
          aria-pressed={comparing}
          className={`flex h-[58px] w-full items-center justify-center gap-2 border px-4 text-[11px] font-black uppercase tracking-wide transition sm:ml-auto sm:w-auto sm:justify-start ${
            comparing
              ? "border-phx-accent bg-phx-accent text-white"
              : "border-phx-line bg-white text-phx-ink-soft hover:border-phx-accent-line"
          }`}
        >
          <GitCompare className="h-4 w-4" />
          {comparing ? "Comparing" : "Compare"}
        </button>
      ) : null}
    </div>
  );
}
