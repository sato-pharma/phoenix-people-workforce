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
import { useRouter } from "next/navigation";

import { MultiSelectFilter, type MultiSelectFilterOption } from "@/components/ui/multi-select-filter";
import type { FilterDescriptor, FilterValues } from "@/lib/analytics/filter-registry";
import type { AnalyticsDimensions } from "@/lib/analytics/service";

type AnalyticsFilterBarProps = {
  descriptors: FilterDescriptor[];
  values: FilterValues;
  dimensions: AnalyticsDimensions;
  basePath: string;
  /** Period-scoped customer options, derived by the page from already-fetched rows. */
  customers?: MultiSelectFilterOption[];
};

function optionsFor(
  descriptor: FilterDescriptor,
  dimensions: AnalyticsDimensions,
  customers: MultiSelectFilterOption[],
): MultiSelectFilterOption[] {
  switch (descriptor.source) {
    case "static":
    case "batchStatuses":
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

export function AnalyticsFilterBar({ descriptors, values, dimensions, basePath, customers = [] }: AnalyticsFilterBarProps) {
  const router = useRouter();
  const debounceRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  const pushValues = React.useCallback(
    (next: FilterValues) => {
      const params = new URLSearchParams();
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
    [basePath, router],
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

  return (
    <div className="flex flex-wrap items-end gap-3">
      {descriptors.map((descriptor) => {
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
              className="w-[220px]"
            />
          );
        }

        if (descriptor.type === "single-select") {
          const options = optionsFor(descriptor, dimensions, customers);
          const currentRaw = values[descriptor.key];
          const current = typeof currentRaw === "string" ? currentRaw : "";
          return (
            <label key={descriptor.key} className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
              {descriptor.label}
              <select
                value={current}
                onChange={(event) => setValue(descriptor.key, event.target.value || null)}
                className="h-9 min-w-[140px] rounded-[6px] border border-border bg-card px-2 text-sm font-medium text-foreground outline-none transition focus:border-orange-300"
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
          <label key={descriptor.key} className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-[0.14em] text-muted-foreground">
            {descriptor.label}
            <input
              type="text"
              defaultValue={current}
              placeholder={descriptor.placeholder}
              onChange={(event) => setDebouncedValue(descriptor.key, event.target.value)}
              className="h-9 min-w-[160px] rounded-[6px] border border-border bg-card px-2 text-sm font-medium text-foreground outline-none transition focus:border-orange-300"
            />
          </label>
        );
      })}
    </div>
  );
}
