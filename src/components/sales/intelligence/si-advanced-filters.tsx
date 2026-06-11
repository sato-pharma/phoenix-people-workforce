"use client";

import { Check, Filter, Loader2, Search, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import type { SiFilterFacets, SiFilterOption, SiFilters } from "@/lib/sales/intelligence/types";
import { cn } from "@/lib/utils";

const DIMS = [
  { key: "regions", param: "regions", label: "Region" },
  { key: "areas", param: "areas", label: "Area" },
  { key: "lines", param: "lines", label: "Line" },
  { key: "distributors", param: "distributors", label: "Distributor" },
  { key: "products", param: "products", label: "Product" },
] as const;

const checkboxClass = (on: boolean) =>
  cn(
    "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
    on ? "border-[#1E3A5F] bg-[#1E3A5F] text-white" : "border-[#CBD5E1]",
  );

const rowClass = "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs transition hover:bg-[#F1F5F9]";

function FilterSection({
  label,
  options,
  selected,
  onToggle,
}: {
  label: string;
  options: SiFilterOption[];
  selected: string[];
  onToggle: (code: string) => void;
}) {
  const [query, setQuery] = useState("");
  const shown = query ? options.filter((option) => option.name.toLowerCase().includes(query.toLowerCase())) : options;
  return (
    <div className="border-b border-[#EEF1F5] py-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#475569]">{label}</p>
        {selected.length > 0 && (
          <span className="rounded-full bg-[#1E3A5F] px-1.5 text-[10px] font-black text-white">{selected.length}</span>
        )}
      </div>
      {options.length > 8 && (
        <div className="relative mt-2">
          <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-[#94A3B8]" />
          <input
            className="h-8 w-full rounded-md border border-[#E2E8F0] bg-[#F8FAFC] pl-7 pr-2 text-xs text-[#0F172A] outline-none focus:border-[#6B8FB5]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`Search ${label.toLowerCase()}…`}
            value={query}
          />
        </div>
      )}
      <div className="mt-2 max-h-44 space-y-0.5 overflow-auto pr-1">
        {shown.length === 0 ? (
          <p className="px-2 py-2 text-[11px] text-[#94A3B8]">No matches</p>
        ) : (
          shown.map((option) => {
            const on = selected.includes(option.code);
            return (
              <button className={rowClass} key={option.code} onClick={() => onToggle(option.code)} type="button">
                <span className={checkboxClass(on)}>{on && <Check className="h-3 w-3" />}</span>
                <span className="truncate font-medium text-[#0F172A]">{option.name}</span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

// Customer is special: the full list (thousands of accounts) is fetched lazily on first focus and
// filtered in the browser, never shipped in the dashboard bundle. The selected accounts are
// resolved to names server-side (`selectedFacet`) so they render with labels immediately.
function CustomerSection({
  period,
  selected,
  selectedFacet,
  onToggle,
}: {
  period: string | null;
  selected: string[];
  selectedFacet: SiFilterOption[];
  onToggle: (code: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SiFilterOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameByCode = useMemo(() => {
    const map = new Map<string, string>();
    for (const option of selectedFacet) map.set(option.code, option.name);
    for (const option of options ?? []) if (!map.has(option.code)) map.set(option.code, option.name);
    return map;
  }, [selectedFacet, options]);

  async function ensureLoaded() {
    if (options !== null || loading) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ period: period ?? "all" });
      const response = await fetch(`/api/sales/intelligence/customers/options?${params.toString()}`);
      const json = await response.json();
      if (!response.ok || !json.success) throw new Error(json.error || "Failed to load customers.");
      setOptions(json.data as SiFilterOption[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load customers.");
    } finally {
      setLoading(false);
    }
  }

  const query_ = query.trim().toLowerCase();
  const matches = (options ?? [])
    .filter((option) => !selected.includes(option.code))
    .filter((option) =>
      query_ ? option.name.toLowerCase().includes(query_) || option.code.toLowerCase().includes(query_) : true,
    )
    .slice(0, 50);

  return (
    <div className="py-3">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-black uppercase tracking-[0.14em] text-[#475569]">Customer</p>
        {selected.length > 0 && (
          <span className="rounded-full bg-[#1E3A5F] px-1.5 text-[10px] font-black text-white">{selected.length}</span>
        )}
      </div>

      {selected.length > 0 && (
        <div className="mt-2 space-y-0.5">
          {selected.map((code) => (
            <button className={rowClass} key={code} onClick={() => onToggle(code)} type="button">
              <span className={checkboxClass(true)}>
                <Check className="h-3 w-3" />
              </span>
              <span className="truncate font-medium text-[#0F172A]">{nameByCode.get(code) ?? code}</span>
            </button>
          ))}
        </div>
      )}

      <div className="relative mt-2">
        <Search className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-[#94A3B8]" />
        <input
          className="h-8 w-full rounded-md border border-[#E2E8F0] bg-[#F8FAFC] pl-7 pr-2 text-xs text-[#0F172A] outline-none focus:border-[#6B8FB5]"
          onChange={(event) => setQuery(event.target.value)}
          onFocus={ensureLoaded}
          placeholder="Search customers…"
          value={query}
        />
      </div>

      {loading && (
        <p className="mt-2 flex items-center gap-1.5 px-1.5 text-[11px] text-[#64748B]">
          <Loader2 className="h-3 w-3 animate-spin" /> Loading customers…
        </p>
      )}
      {error && <p className="mt-2 px-1.5 text-[11px] text-[#B91C1C]">{error}</p>}

      {options && !loading && (
        <div className="mt-2 max-h-44 space-y-0.5 overflow-auto pr-1">
          {matches.length === 0 ? (
            <p className="px-2 py-2 text-[11px] text-[#94A3B8]">{query_ ? "No matches" : "No customers in this period"}</p>
          ) : (
            matches.map((option) => (
              <button className={rowClass} key={option.code} onClick={() => onToggle(option.code)} type="button">
                <span className={checkboxClass(false)} />
                <span className="truncate font-medium text-[#0F172A]">{option.name}</span>
              </button>
            ))
          )}
          {!query_ && options.filter((option) => !selected.includes(option.code)).length > 50 && (
            <p className="px-2 pt-1 text-[10px] text-[#94A3B8]">Showing top 50 by value — search to narrow.</p>
          )}
        </div>
      )}

      <p className="mt-2 px-1 text-[10px] leading-relaxed text-[#94A3B8]">
        Filtering by customer rebuilds the month from customer-level sales. Line Mix isn&apos;t available at this grain.
      </p>
    </div>
  );
}

// A slide-out filter panel. The trigger button shows the active count; the drawer holds one
// searchable multi-select section per dimension. All server-driven: each toggle rewrites the URL
// so the server re-derives the whole bundle to the selection.
export function SiAdvancedFilters({
  facets,
  filters,
  period,
}: {
  facets: SiFilterFacets;
  filters: SiFilters;
  period: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  const total = DIMS.reduce((sum, dim) => sum + filters[dim.key].length, 0) + filters.customers.length;

  function push(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    startTransition(() => router.push(`?${params.toString()}`));
  }

  function toggle(dim: keyof SiFilters, param: string, code: string) {
    const current = filters[dim];
    const next = current.includes(code) ? current.filter((value) => value !== code) : [...current, code];
    push((params) => {
      if (next.length) params.set(param, next.join(","));
      else params.delete(param);
    });
  }

  return (
    <>
      <button
        className={cn(
          "inline-flex h-9 items-center gap-2 rounded-lg border px-3 text-xs font-bold transition",
          total > 0 ? "border-[#1E3A5F] bg-[#EEF2F7] text-[#1E3A5F]" : "border-[#D8E0EA] bg-white text-[#475569] hover:border-[#6B8FB5]",
        )}
        onClick={() => setOpen(true)}
        type="button"
      >
        <Filter className="h-4 w-4" />
        Filters
        {total > 0 && <span className="rounded-full bg-[#1E3A5F] px-1.5 text-[10px] font-black text-white">{total}</span>}
      </button>

      {open && (
        <div className="fixed inset-0 z-[60]">
          <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-0 flex h-full w-[88vw] max-w-md flex-col bg-white shadow-2xl">
            <div className="flex items-center justify-between border-b border-[#EEF1F5] px-4 py-3">
              <div className="flex items-center gap-2">
                <Filter className="h-4 w-4 text-[#1E3A5F]" />
                <p className="text-sm font-black text-[#0F172A]">Filters</p>
                {total > 0 && <span className="rounded-full bg-[#1E3A5F] px-1.5 text-[10px] font-black text-white">{total}</span>}
                {pending && <Loader2 className="h-3.5 w-3.5 animate-spin text-[#1E3A5F]" />}
              </div>
              <button aria-label="Close filters" className="rounded-md p-1 text-[#64748B] transition hover:bg-[#F1F5F9] hover:text-[#0F172A]" onClick={() => setOpen(false)} type="button">
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-auto px-4">
              {DIMS.map((dim) => (
                <FilterSection
                  key={dim.key}
                  label={dim.label}
                  onToggle={(code) => toggle(dim.key, dim.param, code)}
                  options={facets[dim.key]}
                  selected={filters[dim.key]}
                />
              ))}
              <CustomerSection
                onToggle={(code) => toggle("customers", "customers", code)}
                period={period}
                selected={filters.customers}
                selectedFacet={facets.customers}
              />
            </div>

            <div className="flex items-center justify-between gap-2 border-t border-[#EEF1F5] px-4 py-3">
              <button
                className="inline-flex h-9 items-center gap-1 rounded-lg px-2 text-xs font-bold text-[#94A3B8] transition hover:text-[#B91C1C] disabled:opacity-40"
                disabled={total === 0 || pending}
                onClick={() => push((params) => {
                  DIMS.forEach((dim) => params.delete(dim.param));
                  params.delete("customers");
                })}
                type="button"
              >
                <X className="h-3.5 w-3.5" /> Clear all
              </button>
              <button
                className="inline-flex h-9 items-center rounded-lg bg-[#1E3A5F] px-4 text-xs font-black text-white transition hover:bg-[#16314F]"
                onClick={() => setOpen(false)}
                type="button"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
