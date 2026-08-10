"use client";

import { X } from "lucide-react";

import { AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  ALL_RESIGNATION_FILTER,
  activeResignationFilterCount,
  resignationStatusOptions,
  type ResignationFilters as ResignationFilterState,
} from "@/lib/resignations/view-model";

const fieldLabelClassName =
  "mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]";

const statusLabels: Record<string, string> = {
  approved: "Approved",
  cancelled: "Cancelled",
  completed: "Completed",
  rejected: "Rejected",
  submitted: "Submitted",
  under_review: "Under Review",
};

function SelectFilter({
  allLabel,
  label,
  onChange,
  options,
  value,
}: {
  allLabel: string;
  label: string;
  onChange: (value: string) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
}) {
  return (
    <label className="block">
      <span className={fieldLabelClassName}>{label}</span>
      <SearchableSelect onChange={(event) => onChange(event.target.value)} value={value}>
        <option value={ALL_RESIGNATION_FILTER}>{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

/**
 * Status + line only. Free-text search and column sorting live inside the Workflow Queue table
 * itself (the shared useSortableTable / TableSearchInput pair every other admin table uses), so
 * there is no separate sort dropdown to keep in sync.
 */
export function ResignationFilters({
  filters,
  lineOptions,
  onChange,
  onClear,
}: {
  filters: ResignationFilterState;
  lineOptions: readonly string[];
  onChange: (next: ResignationFilterState) => void;
  onClear: () => void;
}) {
  const activeCount = activeResignationFilterCount(filters);

  return (
    <AdminTableShell
      action={
        <Button className="h-11 gap-2" disabled={activeCount === 0} onClick={onClear} variant="secondary">
          <X className="h-4 w-4" />
          Clear {activeCount > 0 ? `(${activeCount})` : ""}
        </Button>
      }
      description="Narrow the queue by workflow status and line. Search and column sorting are in the queue table below."
      title="Workflow Filters"
    >
      <div className="grid gap-3 p-4 md:grid-cols-2">
        <SelectFilter
          allLabel="All statuses"
          label="Status"
          onChange={(status) => onChange({ ...filters, status })}
          options={resignationStatusOptions.map((status) => ({
            label: statusLabels[status] ?? status,
            value: status,
          }))}
          value={filters.status}
        />
        <SelectFilter
          allLabel="All lines"
          label="Line"
          onChange={(lineName) => onChange({ ...filters, lineName })}
          options={lineOptions.map((line) => ({ label: line, value: line }))}
          value={filters.lineName}
        />
      </div>
    </AdminTableShell>
  );
}
