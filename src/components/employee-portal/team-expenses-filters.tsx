"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ChevronDown } from "lucide-react";

import { toPeriodLabel } from "@/lib/employee-portal/period";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import { landingActionClassName } from "@/components/employee-portal/landing-kit";
import { phxCheckInputClassName, phxLabelClassName, phxSelectClassName } from "@/components/ui/form-tokens";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { cn } from "@/lib/utils";

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
    <div className={cn("grid gap-4", hideRequestType ? "xl:grid-cols-[1fr_1fr_auto]" : "xl:grid-cols-[1fr_1fr_1fr_auto]")}>
      <div>
        <label
          className={phxLabelClassName}
          htmlFor="team-expenses-dsm"
        >
          DSM
        </label>
        <SearchableSelect
          className="w-full px-3 py-2.5"
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
            className={phxLabelClassName}
            htmlFor="team-expenses-request-type"
          >
            Request Type
          </label>
          <SearchableSelect
            className="w-full px-3 py-2.5"
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
        <span className={phxLabelClassName}>
          Period
        </span>
        <button
          ref={periodButtonRef}
          aria-expanded={isPeriodMenuOpen}
          aria-haspopup="listbox"
          className={cn(phxSelectClassName, "flex h-auto min-h-10 items-center justify-between gap-2 py-2 text-left motion-reduce:transition-none")}
          onClick={() => setIsPeriodMenuOpen((current) => !current)}
          type="button"
        >
          <span className="break-words min-w-0">{periodLabel}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              "h-4 w-4 shrink-0 text-slate-400 transition-transform duration-200 motion-reduce:transition-none",
              isPeriodMenuOpen && "rotate-180",
            )}
          />
        </button>

        {isPeriodMenuOpen ? (
          <div
            ref={periodMenuRef}
            className={`absolute z-20 mt-1 max-h-64 w-full overflow-y-auto border border-slate-200 bg-white p-1.5 ${adminSoftDepthClassName}`}
            role="listbox"
            aria-label="Period selection"
          >
            <label className="flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50 motion-reduce:transition-none">
              <input
                checked={periodSelection.length === 0}
                className={phxCheckInputClassName}
                onChange={() => setPeriodSelection([])}
                type="checkbox"
              />
              <span className="font-medium">All Periods</span>
            </label>
            {periods.map((period) => (
              <label
                key={period}
                className="flex cursor-pointer items-center gap-2.5 px-2.5 py-2 text-sm text-slate-700 transition-colors hover:bg-slate-50 motion-reduce:transition-none"
              >
                <input
                  checked={periodSelection.includes(period)}
                  className={phxCheckInputClassName}
                  onChange={() => togglePeriod(period)}
                  type="checkbox"
                />
                <span>{toPeriodLabel(period)}</span>
              </label>
            ))}

            {/* Apply / Clear inline actions */}
            <div className="mt-1.5 flex items-center gap-2 border-t border-slate-200 px-1 pt-2">
              <button
                className={landingActionClassName("solid", "flex-1")}
                onClick={applyFilters}
                type="button"
              >
                Apply
              </button>
              <button
                className={landingActionClassName("outline", "flex-1")}
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
          className={landingActionClassName("solid", "px-4 sm:min-h-10")}
          onClick={applyFilters}
          type="button"
        >
          Apply
        </button>
        <button
          className={landingActionClassName("outline", "px-4 sm:min-h-10")}
          onClick={resetFilters}
          type="button"
        >
          Reset
        </button>
      </div>
    </div>
  );
}
