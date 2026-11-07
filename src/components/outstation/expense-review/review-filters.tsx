"use client";

import { AlertTriangle, Check, Loader2 } from "lucide-react";
import type { RefObject } from "react";

import { CrmButton, CrmField, CrmSearchField, CrmSelect } from "@/components/phoenix-crm/ui";
import { formatNumberValue } from "@/lib/i18n/format";
import type { ExpenseApprovalFilterOption } from "@/lib/outstation/expense-approval-filters";
import type { ExpenseApprovalSort } from "@/lib/outstation/expense-approval-triage";

/**
 * The filter bar, built from the Phoenix CRM fields exactly as Place checks builds its own: the
 * search, the trip month, the employee and the order, each a combo box he can type into on this admin
 * surface (`CrmSurfaceProvider surface="admin"`). "Clear filters" keeps the order — it is a
 * preference, not a narrowing.
 */
export function ReviewFilters({
  activeFilterCount,
  employee,
  employees,
  month,
  months,
  narrowed,
  onClear,
  onEmployee,
  onMonth,
  onSearch,
  onSort,
  search,
  searchRef,
  shown,
  sort,
  total,
}: {
  activeFilterCount: number;
  employee: string;
  employees: ExpenseApprovalFilterOption[];
  month: string;
  months: ExpenseApprovalFilterOption[];
  narrowed: boolean;
  onClear: () => void;
  onEmployee: (value: string) => void;
  onMonth: (value: string) => void;
  onSearch: (value: string) => void;
  onSort: (value: ExpenseApprovalSort) => void;
  search: string;
  searchRef?: RefObject<HTMLDivElement | null>;
  shown: number;
  sort: ExpenseApprovalSort;
  total: number;
}) {
  return (
    // No "Filters" heading row: the four fields say what they are (owner, 2026-11-07: "the screen is
    // consumed in irrelevant place"). The count and Clear sit at the end of the fields' own row.
    <div className="min-w-0 border border-slate-200 bg-white px-3 py-2.5" data-review-filters>
      <div className="grid min-w-0 items-end gap-x-3 gap-y-2 sm:grid-cols-2 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1fr)_auto]">
        <div className="min-w-0" ref={searchRef}>
          <CrmSearchField
            id="expense-search"
            label="Search"
            onChange={onSearch}
            placeholder="Employee, HR ID, trip or destination"
            value={search}
          />
        </div>
        <CrmField htmlFor="expense-month" label="Trip month">
          <CrmSelect id="expense-month" onChange={(event) => onMonth(event.target.value)} value={month}>
            <option value="">Every month</option>
            {months.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </CrmSelect>
        </CrmField>
        <CrmField htmlFor="expense-employee" label="Employee">
          <CrmSelect id="expense-employee" onChange={(event) => onEmployee(event.target.value)} value={employee}>
            <option value="">Every employee</option>
            {employees.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </CrmSelect>
        </CrmField>
        <CrmField htmlFor="expense-sort" label="Order">
          <CrmSelect id="expense-sort" onChange={(event) => onSort(event.target.value === "oldest" ? "oldest" : "value")} value={sort}>
            <option value="value">Biggest first</option>
            <option value="oldest">Oldest first</option>
          </CrmSelect>
        </CrmField>
        <div className="flex min-w-0 flex-wrap items-center gap-2 pb-1.5 sm:col-span-2 xl:col-span-1">
          <span className="text-xs font-bold tabular-nums text-slate-500" data-filter-count>
            {formatNumberValue(shown)} of {formatNumberValue(total)} trips
            {activeFilterCount > 0 ? ` · ${formatNumberValue(activeFilterCount)} filter${activeFilterCount === 1 ? "" : "s"}` : ""}
          </span>
          {narrowed ? (
            <CrmButton onClick={onClear} size="sm" variant="ghost">
              Clear filters
            </CrmButton>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The save strip: "37 unsaved · Save 37", with the restored-draft notice when the unsaved decisions
 * were brought back from last time. Shown only while something is unsaved, and sticky at the top of
 * the page so the Save never scrolls out of reach while a long list is worked.
 */
export function ReviewSaveStrip({
  dirtyCount,
  onSave,
  restoredDraftCount,
  saving,
}: {
  dirtyCount: number;
  onSave: () => void;
  restoredDraftCount: number;
  saving: boolean;
}) {
  if (dirtyCount === 0) return null;
  return (
    <div
      className="sticky top-2 z-20 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1.5 border border-orange-300 border-l-[3px] border-l-orange-500 bg-orange-50 px-3 py-1.5"
      data-save-strip
      role="status"
    >
      {/* One line, never a three-line banner (owner, 2026-11-07: "the screen is consumed in
          irrelevant place"). The words that matter stay: how many, that they are recovered and still
          NOT saved, and that nothing reaches payroll until Save — the failure this guards is a
          reviewer believing decisions were committed when they were not. */}
      <p className="min-w-0 flex-1 basis-72 break-words text-sm text-slate-700">
        <span className="font-black text-slate-950">
          {formatNumberValue(dirtyCount)} decision{dirtyCount === 1 ? "" : "s"} not saved yet
        </span>
        {restoredDraftCount > 0 ? (
          <span className="font-bold text-amber-800" data-restored-draft>
            {" · "}
            <AlertTriangle aria-hidden className="mb-0.5 inline h-3.5 w-3.5" /> {formatNumberValue(restoredDraftCount)} restored · unsaved, from your last visit
          </span>
        ) : null}
        <span className="text-xs font-semibold text-slate-500"> · nothing reaches the employee or payroll until you press Save</span>
      </p>
      <CrmButton busy={saving} data-save-button onClick={onSave} size="sm" variant="primary">
        {saving ? null : <Check aria-hidden className="h-4 w-4" />}
        {saving ? "Saving" : `Save ${formatNumberValue(dirtyCount)}`}
      </CrmButton>
    </div>
  );
}

/** The spinner word while the first read is on its way, for screen readers too. */
export function ReviewLoadingLine() {
  return (
    <p aria-live="polite" className="inline-flex items-center gap-2 text-sm font-semibold text-slate-500">
      <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> Reading the trips
    </p>
  );
}
