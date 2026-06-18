"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";

import { toPeriodLabel } from "@/lib/employee-portal/period";
import { SearchableSelect } from "@/components/ui/searchable-select";


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
  const periodMenuRef = useRef<HTMLDivElement>(null);
  const periodButtonRef = useRef<HTMLButtonElement>(null);

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

  /* Focus trap: close dropdown on Escape and outside click */
  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && isPeriodMenuOpen) {
        setIsPeriodMenuOpen(false);
        periodButtonRef.current?.focus();
      }
    },
    [isPeriodMenuOpen],
  );

  useEffect(() => {
    if (!isPeriodMenuOpen) return;
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [isPeriodMenuOpen, handleKeyDown]);

  /* Close on outside click */
  useEffect(() => {
    if (!isPeriodMenuOpen) return;
    function handleClick(e: MouseEvent) {
      if (
        periodMenuRef.current &&
        !periodMenuRef.current.contains(e.target as Node) &&
        periodButtonRef.current &&
        !periodButtonRef.current.contains(e.target as Node)
      ) {
        setIsPeriodMenuOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [isPeriodMenuOpen]);

  return (
    <div className={`grid gap-4 ${hideRequestType ? "xl:grid-cols-[1fr_1fr_auto]" : "xl:grid-cols-[1fr_1fr_1fr_auto]"}`}>
      <div>
        <label
          className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
          htmlFor="team-expenses-dsm"
        >
          DSM
        </label>
        <SearchableSelect
          className="w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
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
        </SearchableSelect>
      </div>

      {!hideRequestType ? (
        <div>
          <label
            className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-slate-400"
            htmlFor="team-expenses-request-type"
          >
            Request Type
          </label>
          <SearchableSelect
            className="w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]"
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
          </SearchableSelect>
        </div>
      ) : null}

      <div className="relative">
        <span className="mb-2 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Period
        </span>
        <button
          ref={periodButtonRef}
          aria-expanded={isPeriodMenuOpen}
          aria-haspopup="listbox"
          className="flex w-full items-center justify-between rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 transition hover:border-slate-300 focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)] focus:outline-none"
          onClick={() => setIsPeriodMenuOpen((current) => !current)}
          type="button"
        >
          <span className="break-words min-w-0">{periodLabel}</span>
          <ChevronDown className={`ml-2 h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 ${isPeriodMenuOpen ? "rotate-180" : ""}`} />
        </button>

        {isPeriodMenuOpen ? (
          <div
            ref={periodMenuRef}
            className="absolute z-20 mt-1 max-h-64 w-full overflow-y-auto rounded-lg border border-gray-200 bg-white p-1.5 shadow-[0_8px_24px_rgba(15,23,42,0.10)]"
            role="listbox"
            aria-label="Period selection"
          >
            <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors">
              <input
                checked={periodSelection.length === 0}
                className="h-4 w-4 rounded border-slate-300 text-orange-500 focus:ring-orange-400"
                onChange={() => setPeriodSelection([])}
                type="checkbox"
              />
              <span className="font-medium">All Periods</span>
            </label>
            {periods.map((period) => (
              <label
                key={period}
                className="flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm text-slate-700 hover:bg-slate-50 transition-colors"
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

            {/* Apply / Clear inline actions */}
            <div className="mt-1.5 flex items-center gap-2 border-t border-gray-100 pt-2 px-1">
              <button
                className="flex-1 rounded-md bg-orange-500 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-orange-600"
                onClick={applyFilters}
                type="button"
              >
                Apply
              </button>
              <button
                className="flex-1 rounded-md border border-gray-200 px-3 py-1.5 text-xs font-semibold text-slate-600 transition hover:bg-slate-50"
                onClick={() => {
                  setPeriodSelection([]);
                }}
                type="button"
              >
                Clear all
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div className="flex items-end gap-2">
        <button
          className="rounded-md bg-orange-500 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-600"
          onClick={applyFilters}
          type="button"
        >
          Apply
        </button>
        <button
          className="rounded-md border border-gray-200 px-4 py-2.5 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
          onClick={resetFilters}
          type="button"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
