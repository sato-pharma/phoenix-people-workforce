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
      <summary className="flex cursor-pointer list-none items-center gap-1 text-xs font-semibold uppercase tracking-[0.12em] text-text-secondary">
        {label}
        <span className="text-phx-2xs text-text-secondary group-open:rotate-180">v</span>
      </summary>
      <div className="absolute left-0 top-7 z-20 w-56 rounded-xl border border-border bg-card p-3 normal-case tracking-normal shadow-xl">
        <div className="mb-2 grid gap-2">
          <button
            aria-label={`Sort ${label} A to Z / Low to High`}
            className="rounded-lg px-3 py-2 text-left text-xs font-medium text-text hover:bg-bg-muted disabled:opacity-50"
            disabled={!onSortAsc}
            onClick={onSortAsc}
            type="button"
          >
            Sort A to Z / Low to High
          </button>
          <button
            aria-label={`Sort ${label} Z to A / High to Low`}
            className="rounded-lg px-3 py-2 text-left text-xs font-medium text-text hover:bg-bg-muted disabled:opacity-50"
            disabled={!onSortDesc}
            onClick={onSortDesc}
            type="button"
          >
            Sort Z to A / High to Low
          </button>
        </div>
        <Input
          aria-label={`Search ${label}`}
          className="h-9 text-xs"
          onChange={(event) => onFilterChange(event.target.value)}
          placeholder={`Search ${label}`}
          value={filterValue}
        />
      </div>
    </details>
  );
}
