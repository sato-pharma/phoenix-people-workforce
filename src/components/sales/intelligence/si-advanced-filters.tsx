"use client";

import { ChevronDown, Eye, EyeOff, Loader2, SlidersHorizontal, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";

import type { SiAccessBadge, SiDetailsAppliedFilters, SiDetailsFilterOptions } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

// URL param name per applied-filter field. `productFilter` is deliberately distinct from the drill
// deep-link `?product=` so opening a product drill never doubles as a page filter.
const PARAM = {
  distributorCode: "distributor",
  regionCode: "region",
  areaCode: "area",
  officialLine: "line",
  productCode: "productFilter",
} as const;

type FilterField = keyof typeof PARAM;

const FILTER_FIELDS: FilterField[] = ["distributorCode", "regionCode", "areaCode", "officialLine", "productCode"];

// Premium, light "command console" filter bar for the executive dashboard. Square corners only
// (the admin shell zeroes rounding), slate-900 count badge, orange #F97316 chips. Server-driven:
// every change pushes a URL so the server re-resolves scope + filters (the toggle is UX, the
// server is the boundary).
export function SiAdvancedFilters({
  access,
  availablePeriods,
  period,
  filterOptions,
  appliedFilters,
}: {
  access: SiAccessBadge;
  availablePeriods: string[];
  period: string | null;
  filterOptions: SiDetailsFilterOptions;
  appliedFilters: SiDetailsAppliedFilters;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  function setParams(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    startTransition(() => router.push(`?${params.toString()}`));
  }

  const setFilter = (field: FilterField, value: string) =>
    setParams((params) => {
      if (value) params.set(PARAM[field], value);
      else params.delete(PARAM[field]);
    });

  const clearAll = () =>
    setParams((params) => {
      for (const field of FILTER_FIELDS) params.delete(PARAM[field]);
    });

  // Resolve a code → display NAME (never show a code on screen). Options carry the human names.
  const options: Record<FilterField, { code: string; name: string }[]> = {
    distributorCode: filterOptions.distributors,
    regionCode: filterOptions.regions,
    areaCode: filterOptions.areas,
    officialLine: filterOptions.lines,
    productCode: filterOptions.products,
  };
  const LABEL: Record<FilterField, string> = {
    distributorCode: "Distributor",
    regionCode: "Region",
    areaCode: "Area",
    officialLine: "Line",
    productCode: "Product",
  };
  const nameOf = (field: FilterField, code: string) =>
    options[field].find((option) => option.code === code)?.name ?? code;

  const activeFilters = FILTER_FIELDS
    .map((field) => ({ field, code: appliedFilters[field] }))
    .filter((entry): entry is { field: FilterField; code: string } => Boolean(entry.code));
  const activeCount = activeFilters.length;

  const fieldSelect = (field: FilterField) => (
    <label className="block min-w-0">
      <span className="mb-1 block text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{LABEL[field]}</span>
      <select
        className="h-10 w-full border border-[#E2E8F0] bg-white px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
        disabled={pending}
        onChange={(event) => setFilter(field, event.target.value)}
        value={appliedFilters[field] ?? ""}
      >
        <option value="">All {LABEL[field].toLowerCase()}s</option>
        {options[field].map((option) => (
          <option key={option.code} value={option.code}>{option.name}</option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="border border-[#E2E8F0] bg-white shadow-[0_8px_22px_rgba(15,23,42,0.04)]">
      {/* Title row — always visible: identity, Month, Lacto toggle, scope, expand */}
      <div className="flex flex-wrap items-center gap-3 px-4 py-3 sm:px-5">
        <span className="inline-flex items-center gap-2 text-sm font-black uppercase tracking-wide text-[#0F172A]">
          <SlidersHorizontal className="h-4 w-4 text-[#F97316]" /> Advanced Filters
        </span>
        {activeCount > 0 && (
          <span className="inline-flex h-6 min-w-[1.5rem] items-center justify-center bg-[#0B0B0B] px-1.5 text-[11px] font-black text-white">
            {activeCount}
          </span>
        )}

        <span className="ml-1 inline-flex items-center gap-2">
          <span className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">Month</span>
          <select
            className="h-9 border border-[#D8E0EA] bg-[#F8FAFC] px-3 text-sm font-bold text-[#0F172A] outline-none focus:border-[#FDBA74]"
            disabled={pending || availablePeriods.length === 0}
            onChange={(event) => setParams((params) => params.set("period", event.target.value))}
            value={period ?? ""}
          >
            {availablePeriods.length === 0 ? (
              <option value="">No validated month</option>
            ) : (
              availablePeriods.map((value) => (
                <option key={value} value={value}>{value}</option>
              ))
            )}
          </select>
        </span>
        {pending && <Loader2 className="h-4 w-4 animate-spin text-[#F97316]" />}

        {/* Scope badges — what this viewer is bounded to (geography by name). */}
        {!access.canViewAllSales && access.lineNames.length > 0 && (
          <span className="border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold text-[#0F172A]">
            Line: {access.lineNames.join(", ")}
          </span>
        )}
        {!access.canViewAllSales && access.regionNames.length > 0 && (
          <span className="border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 py-1 text-[11px] font-bold capitalize text-[#0F172A]">
            Region: {access.regionNames.join(", ")}
          </span>
        )}

        <div className="ml-auto flex items-center gap-2">
          {access.includeRestrictedAllowed ? (
            <button
              className={cn(
                "inline-flex h-9 items-center gap-2 border px-3 text-xs font-black transition",
                access.restrictedIncluded
                  ? "border-rose-300 bg-rose-50 text-rose-700 hover:bg-rose-100"
                  : "border-[#D8E0EA] bg-white text-[#0F172A] hover:border-[#FDBA74] hover:text-[#F97316]",
              )}
              disabled={pending}
              onClick={() =>
                setParams((params) => {
                  if (access.restrictedIncluded) params.delete("includeRestricted");
                  else params.set("includeRestricted", "1");
                })
              }
              type="button"
            >
              {access.restrictedIncluded ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              {access.restrictedIncluded ? "Hide Lacto Basic 1 & 2" : "Include Lacto Basic 1 & 2"}
            </button>
          ) : (
            <span className="inline-flex h-9 items-center gap-2 border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-[11px] font-bold text-[#64748B]">
              <EyeOff className="h-3.5 w-3.5" /> Restricted products excluded
            </span>
          )}
          <button
            className="inline-flex h-9 items-center gap-1.5 border border-[#D8E0EA] bg-white px-3 text-xs font-black text-[#0F172A] transition hover:border-[#FDBA74] hover:text-[#F97316]"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            {open ? "Hide" : "Filters"}
            <ChevronDown className={cn("h-4 w-4 text-[#94A3B8] transition", open && "rotate-180")} />
          </button>
        </div>
      </div>

      {/* Active filter chips — removable, name not code */}
      {activeCount > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-t border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 sm:px-5">
          {activeFilters.map(({ field, code }) => (
            <span
              className="inline-flex items-center gap-2 bg-[#F97316] px-3 py-1 text-xs font-bold text-white"
              key={field}
            >
              {LABEL[field]}: {nameOf(field, code)}
              <button
                aria-label={`Remove ${LABEL[field]} filter`}
                className="inline-flex hover:opacity-80"
                disabled={pending}
                onClick={() => setFilter(field, "")}
                type="button"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            className="inline-flex items-center gap-1 border border-[#E2E8F0] bg-white px-2.5 py-1 text-xs font-bold text-[#64748B] transition hover:border-rose-300 hover:text-rose-600"
            disabled={pending}
            onClick={clearAll}
            type="button"
          >
            <X className="h-3.5 w-3.5" /> Clear all
          </button>
        </div>
      )}

      {/* Controls grid */}
      {open && (
        <div className="grid grid-cols-1 gap-4 border-t border-[#E2E8F0] p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 sm:p-5">
          {FILTER_FIELDS.map((field) => (
            <div key={field}>{fieldSelect(field)}</div>
          ))}
          <p className="text-[11px] font-bold leading-relaxed text-[#94A3B8] sm:col-span-2 lg:col-span-3 xl:col-span-5">
            Filters narrow within your access. Customer &amp; churn views follow distributor / region / area;
            the daily rhythm follows distributor &amp; product.
          </p>
        </div>
      )}
    </div>
  );
}
