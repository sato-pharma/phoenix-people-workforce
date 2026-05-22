import {
  ArrowDownAZ,
  ArrowUpAZ,
  ChevronsUpDown,
  Search,
} from "lucide-react";

import { Input } from "@/components/ui/input";

export function TableHeaderMenu({
  label,
  filterValue,
  onFilterChange,
  onSortAsc,
  onSortDesc,
}: {
  label: string;
  filterValue: string;
  onFilterChange: (value: string) => void;
  onSortAsc?: () => void;
  onSortDesc?: () => void;
}) {
  return (
    <details className="group relative">
      <summary className="inline-flex cursor-pointer list-none items-center gap-2 rounded-full border border-transparent px-2 py-1 text-xs font-semibold uppercase tracking-[0.12em] text-[#475569] transition hover:border-[#FED7AA] hover:bg-[#FFF7ED] hover:text-[#EA580C]">
        <span>{label}</span>
        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-[#CBD5E1] bg-white text-[#64748B] shadow-sm transition group-open:rotate-180 group-open:border-[#FDBA74] group-open:text-[#EA580C]">
          <ChevronsUpDown className="h-3.5 w-3.5" />
        </span>
      </summary>
      <div className="absolute left-0 top-9 z-20 w-60 rounded-2xl border border-[#D8E0EA] bg-white p-3 normal-case tracking-normal shadow-[0_18px_44px_rgba(15,23,42,0.16)]">
        <div className="mb-2 grid gap-2">
          <button
            className="inline-flex items-center rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#0F172A] transition hover:bg-[#F8FAFC] disabled:opacity-50"
            disabled={!onSortAsc}
            onClick={onSortAsc}
            type="button"
          >
            <ArrowDownAZ className="mr-2 h-4 w-4 text-[#F97316]" />
            Sort ascending
          </button>
          <button
            className="inline-flex items-center rounded-xl px-3 py-2 text-left text-xs font-semibold text-[#0F172A] transition hover:bg-[#F8FAFC] disabled:opacity-50"
            disabled={!onSortDesc}
            onClick={onSortDesc}
            type="button"
          >
            <ArrowUpAZ className="mr-2 h-4 w-4 text-[#F97316]" />
            Sort descending
          </button>
        </div>
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#94A3B8]" />
          <Input
            className="h-9 pl-8 text-xs"
            onChange={(event) => onFilterChange(event.target.value)}
            placeholder={`Search ${label}`}
            value={filterValue}
          />
        </label>
      </div>
    </details>
  );
}
