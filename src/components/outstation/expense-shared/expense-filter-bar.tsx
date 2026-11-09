"use client";

import { Filter, X } from "lucide-react";

import {
  countActiveExpenseFilters,
  EXPENSE_PRESET_LABELS,
  EXPENSE_SOURCE_LABELS,
} from "@/components/outstation/expense-shared/formatters";
import type {
  ExpenseCommandFilterOptions,
  ExpenseCommandFilters,
  ExpenseDashboardVariant,
  ExpenseDatePreset,
  ExpenseSource,
} from "@/components/outstation/expense-shared/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxSelectClassName } from "@/components/ui/form-tokens";


const PRESETS: ExpenseDatePreset[] = ["all", "today", "7d", "30d", "90d", "month", "custom"];

const selectClass  = phxSelectClassName;

function FilterSelect({
  label,
  value,
  options,
  onChange,
  allLabel,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string | null) => void;
  allLabel: string;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-400">{label}</span>
      <SearchableSelect className={selectClass} value={value} onChange={(event) => onChange(event.target.value || null)}>
        <option value="">{allLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </SearchableSelect>
    </label>
  );
}

export function ExpenseFilterBar({
  filters,
  filterOptions,
  onChange,
  onClear,
  loading = false,
  variant = "admin",
}: {
  filters: ExpenseCommandFilters;
  filterOptions: ExpenseCommandFilterOptions;
  onChange: (patch: Partial<ExpenseCommandFilters>) => void;
  onClear: () => void;
  loading?: boolean;
  variant?: ExpenseDashboardVariant;
}) {
  const activeCount = countActiveExpenseFilters(filters);
  const preset = filters.preset ?? "all";

  return (
    <div className="rounded-[18px] border border-phx-line bg-white p-4 shadow-[0_18px_46px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-black tracking-tight text-slate-900">Filters</span>
          <span
            className={`text-xs font-bold ${loading ? "text-orange-500" : "text-slate-400"}`}
          >
            {loading ? "Updating…" : "Ready"}
          </span>
          {activeCount > 0 ? (
            <span className="inline-flex items-center rounded-full bg-phx-warn-bg px-2 py-0.5 text-phx-xs font-black text-phx-warn">
              {activeCount} active
            </span>
          ) : null}
        </div>
        {activeCount > 0 ? (
          <button
            type="button"
            onClick={onClear}
            className="inline-flex items-center gap-1 rounded-full border border-phx-line px-3 py-1 text-xs font-bold text-phx-ink-soft hover:border-phx-warn-line hover:text-phx-warn"
          >
            <X className="h-3 w-3" /> Clear all
          </button>
        ) : null}
      </div>

      {/* Date presets */}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => onChange({ preset: value })}
            className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
              preset === value
                ? "bg-phx-ink text-white"
                : "border border-slate-200 bg-white text-slate-600 hover:border-orange-300 hover:text-orange-600"
            }`}
          >
            {EXPENSE_PRESET_LABELS[value]}
          </button>
        ))}
      </div>

      {preset === "custom" ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-400">From</span>
            <input
              className={selectClass}
              type="date"
              value={filters.from ?? ""}
              onChange={(event) => onChange({ from: event.target.value || null })}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-phx-sm font-black uppercase tracking-[0.14em] text-slate-400">To</span>
            <input
              className={selectClass}
              type="date"
              value={filters.to ?? ""}
              onChange={(event) => onChange({ to: event.target.value || null })}
            />
          </label>
        </div>
      ) : null}

      {/* Dimension filters */}
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {variant === "admin" ? (
          <>
            <FilterSelect
              allLabel="All regions"
              label="Region"
              onChange={(value) => onChange({ region: value })}
              options={filterOptions.regions.map((region) => ({ value: region, label: region }))}
              value={filters.region ?? ""}
            />
            <FilterSelect
              allLabel="All lines"
              label="Line"
              onChange={(value) => onChange({ line: value })}
              options={filterOptions.lines.map((line) => ({ value: line, label: line }))}
              value={filters.line ?? ""}
            />
            <FilterSelect
              allLabel="All employees"
              label="Employee"
              onChange={(value) => onChange({ employeeHrId: value })}
              options={filterOptions.employees.map((employee) => ({ value: employee.hrId, label: employee.name }))}
              value={filters.employeeHrId ?? ""}
            />
          </>
        ) : null}
        <FilterSelect
          allLabel="All sources"
          label="Source"
          onChange={(value) => onChange({ source: (value as ExpenseSource) || null })}
          options={filterOptions.sources.map((source) => ({ value: source, label: EXPENSE_SOURCE_LABELS[source] }))}
          value={filters.source ?? ""}
        />
        <FilterSelect
          allLabel="All statuses"
          label="Status"
          onChange={(value) => onChange({ status: value })}
          options={filterOptions.statuses.map((status) => ({ value: status, label: status }))}
          value={filters.status ?? ""}
        />
        <FilterSelect
          allLabel="All transport"
          label="Transport"
          onChange={(value) => onChange({ transportation: value })}
          options={filterOptions.transportationTypes.map((type) => ({ value: type, label: type }))}
          value={filters.transportation ?? ""}
        />
        <FilterSelect
          allLabel="All types"
          label="Expense type"
          onChange={(value) => onChange({ expenseType: value })}
          options={filterOptions.expenseTypes.map((type) => ({ value: type, label: type }))}
          value={filters.expenseType ?? ""}
        />
      </div>
    </div>
  );
}
