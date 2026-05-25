"use client";

import { useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";

import { toPeriodLabel } from "@/lib/employee-portal/period";

type DsmOption = {
  hrId: string;
  name: string;
};

type TeamExpensesFiltersProps = {
  dsms: DsmOption[];
  hideRequestType?: boolean;
  periods: string[];
  requestTypes: string[];
  selectedDsm: string;
  selectedPeriods: string[];
  selectedRequestType: string;
  targetPath?: string;
};

export function TeamExpensesFilters({
  dsms,
  hideRequestType = false,
  periods,
  requestTypes,
  selectedDsm,
  selectedPeriods,
  selectedRequestType,
  targetPath,
}: TeamExpensesFiltersProps) {
  const pathname = usePathname();
  const router = useRouter();
  const resolvedPath = targetPath ?? pathname;
  const [dsm, setDsm] = useState(selectedDsm);
  const [requestType, setRequestType] = useState(selectedRequestType);
  const [periodSelection, setPeriodSelection] = useState<string[]>(selectedPeriods);
  const [isPeriodMenuOpen, setIsPeriodMenuOpen] = useState(false);

  const periodLabel = useMemo(() => {
    if (periodSelection.length === 0) return "All Periods";
    if (periodSelection.length === 1) return toPeriodLabel(periodSelection[0] ?? "");
    return `${periodSelection.length} periods selected`;
  }, [periodSelection]);

  function togglePeriod(period: string) {
    setPeriodSelection((current) =>
      current.includes(period)
        ? current.filter((item) => item !== period)
        : [...current, period].sort(),
    );
  }

  function applyFilters() {
    const params = new URLSearchParams();
    if (dsm) params.set("dsm", dsm);
    if (!hideRequestType && requestType) params.set("requestType", requestType);
    periodSelection.forEach((period) => params.append("period", period));
    const query = params.toString();
    router.push(query ? `${resolvedPath}?${query}` : resolvedPath);
    setIsPeriodMenuOpen(false);
  }

  function resetFilters() {
    setDsm("");
    setRequestType("");
    setPeriodSelection([]);
    setIsPeriodMenuOpen(false);
    router.push(resolvedPath);
  }

  return (
    <div className={`grid gap-4 ${hideRequestType ? "xl:grid-cols-[1fr_1fr_auto]" : "xl:grid-cols-[1fr_1fr_1fr_auto]"}`}>
      <div>
        <label
          className="mb-3 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500"
          htmlFor="team-expenses-dsm"
        >
          DSM
        </label>
        <select
          className="w-full rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_4px_rgba(249,115,22,0.08)]"
          id="team-expenses-dsm"
          onChange={(event) => setDsm(event.target.value)}
          value={dsm}
        >
          <option value="">All DSMs</option>
          {dsms.map((item) => (
            <option key={item.hrId} value={item.hrId}>
              {item.name}
            </option>
          ))}
        </select>
      </div>

      {!hideRequestType ? (
        <div>
          <label
            className="mb-3 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500"
            htmlFor="team-expenses-request-type"
          >
            Request Type
          </label>
          <select
            className="w-full rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_4px_rgba(249,115,22,0.08)]"
            id="team-expenses-request-type"
            onChange={(event) => setRequestType(event.target.value)}
            value={requestType}
          >
            <option value="">All Types</option>
            {requestTypes.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      <div className="relative">
        <span className="mb-3 block text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
          Period
        </span>
        <button
          className="flex w-full items-center justify-between rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 transition hover:border-slate-300"
          onClick={() => setIsPeriodMenuOpen((current) => !current)}
          type="button"
        >
          <span className="whitespace-nowrap">{periodLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0 text-slate-400" />
        </button>

        {isPeriodMenuOpen ? (
          <div className="absolute z-20 mt-2 max-h-72 w-full overflow-y-auto rounded border border-slate-200 bg-white p-2 shadow-[0_18px_40px_rgba(15,23,42,0.12)]">
            <label className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">
              <input
                checked={periodSelection.length === 0}
                className="h-4 w-4 rounded border-slate-300 text-orange-500 focus:ring-orange-400"
                onChange={() => setPeriodSelection([])}
                type="checkbox"
              />
              <span>All Periods</span>
            </label>
            {periods.map((period) => (
              <label
                key={period}
                className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                <input
                  checked={periodSelection.includes(period)}
                  className="h-4 w-4 rounded border-slate-300 text-orange-500 focus:ring-orange-400"
                  onChange={() => togglePeriod(period)}
                  type="checkbox"
                />
                <span>{toPeriodLabel(period)}</span>
              </label>
            ))}
          </div>
        ) : null}
      </div>

      <div className="flex items-end gap-2">
        <button
          className="rounded bg-slate-900 px-4 py-2.5 text-sm font-medium text-white transition hover:bg-slate-800"
          onClick={applyFilters}
          type="button"
        >
          Apply Filters
        </button>
        <button
          className="rounded border border-slate-200 px-4 py-2.5 text-sm font-medium text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
          onClick={resetFilters}
          type="button"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
