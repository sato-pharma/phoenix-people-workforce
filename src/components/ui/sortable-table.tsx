"use client";

import { ChevronDown, ChevronUp, ChevronsUpDown, Search, X } from "lucide-react";
import * as React from "react";

import { cn } from "@/lib/utils";
import type { SortState } from "@/components/ui/use-sortable-table";

export { useSortableTable, visibleMax } from "@/components/ui/use-sortable-table";
export type {
  SortState,
  SortDir,
  SortType,
  SortableColumn,
  UseSortableTableOptions,
  UseSortableTableResult,
} from "@/components/ui/use-sortable-table";

// Sortable header cell. Drops into an existing <thead><tr>. Omit `sortKey` for an inert column
// (sparkline / actions). `variant` matches the two header skins used across the sales tables:
//   "dark"  -> near-black header (#020617) with white text  (weekly, sos-coverage)
//   "light" -> light header (#F8FAFC) with slate text       (product master, import summaries)

type SortableThProps = {
  label: string;
  sortKey?: string;
  sort?: SortState | null;
  onSort?: (key: string) => void;
  align?: "left" | "right";
  variant?: "dark" | "light";
  className?: string;
};

export function SortableTh({
  label,
  sortKey,
  sort,
  onSort,
  align = "left",
  variant = "dark",
  className,
}: SortableThProps) {
  const lightBase = "px-4 py-3 text-phx-xs font-black uppercase tracking-[0.14em] text-phx-ink-soft";
  const darkBase = "px-3 py-2";
  const base = variant === "light" ? lightBase : darkBase;
  const alignClass = align === "right" ? "text-right" : "text-left";

  // Inert (non-sortable) column.
  if (!sortKey || !onSort) {
    return <th className={cn(base, alignClass, className)}>{label}</th>;
  }

  const active = sort?.key === sortKey;
  const activeColor = variant === "light" ? "text-phx-accent" : "text-phx-accent";

  return (
    <th
      className={cn(base, alignClass, className)}
      aria-sort={active ? (sort?.dir === "asc" ? "ascending" : "descending") : "none"}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}`}
        className={cn(
          "group inline-flex select-none items-center gap-1 transition hover:opacity-90",
          align === "right" && "flex-row-reverse",
          active && activeColor,
        )}
      >
        <span>{label}</span>
        {active ? (
          sort?.dir === "asc" ? (
            <ChevronUp className="h-3 w-3 shrink-0" />
          ) : (
            <ChevronDown className="h-3 w-3 shrink-0" />
          )
        ) : (
          <ChevronsUpDown className="h-3 w-3 shrink-0 opacity-0 transition group-hover:opacity-40" />
        )}
      </button>
    </th>
  );
}

// Quick per-table search box. Square corners, established #D8E0EA/#FDBA74 styling.
type TableSearchInputProps = {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  placeholder?: string;
  size?: "sm" | "md";
  className?: string;
};

export function TableSearchInput({
  value,
  onChange,
  onClear,
  placeholder = "Filter…",
  size = "sm",
  className,
}: TableSearchInputProps) {
  return (
    <div className={cn("relative", className)}>
      <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-phx-ink-faint" />
      <input
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full border border-phx-line bg-white pl-8 pr-7 text-sm font-medium text-phx-ink outline-none transition focus:border-phx-accent-line focus:ring-2 focus:ring-phx-accent/10",
          size === "sm" ? "h-8" : "h-10",
        )}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={onClear}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-phx-ink-faint transition hover:text-phx-accent"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}

// Empty-state row, distinct copy for "filtered everything out" vs "genuinely empty".
type TableNoResultsProps = {
  colSpan: number;
  filtered: boolean;
  label?: string;
};

export function TableNoResults({ colSpan, filtered, label = "rows" }: TableNoResultsProps) {
  return (
    <tr>
      <td className="px-3 py-5 text-center text-phx-ink-faint" colSpan={colSpan}>
        {filtered ? `No ${label} match your search.` : `No ${label}.`}
      </td>
    </tr>
  );
}
