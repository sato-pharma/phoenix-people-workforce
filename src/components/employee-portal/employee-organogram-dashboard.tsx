"use client";

import { useCallback, useMemo, useState } from "react";

import { OrgChartTree, type OrgChartKpiLabels } from "@/components/organogram/org-chart";
import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import {
  buildOrganogramLanes,
  filterOrganogramRows,
  isOrganogramVisibleRow,
  normalizeSearchValue,
} from "@/lib/reports/organogram-view-model";
import type { VacancyReportData } from "@/lib/reports/vacancies";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type EmployeeOrganogramDashboardProps = {
  fixedLine?: string | null;
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
  showLinePicker?: boolean;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const inputClassName =
  "w-full rounded border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]";

const labelClassName =
  "text-[11px] font-semibold uppercase tracking-wider text-slate-400";

const cardShadow = "shadow-[0_1px_3px_rgba(15,23,42,0.08)]";

// Shorter KPI labels tuned for the narrower portal column. The admin surface keeps
// the full-length labels from the shared chart defaults.
const PORTAL_KPI_LABELS: OrgChartKpiLabels = {
  dsm: "District Managers",
  medicalRep: "Medical Reps",
  nsm: "National Managers",
  rsm: "Regional Managers",
  total: "Total Structure",
};

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export function EmployeeOrganogramDashboard({
  fixedLine = null,
  initialError = null,
  initialReport = null,
  showLinePicker = false,
}: EmployeeOrganogramDashboardProps) {
  const [report, setReport] = useState<VacancyReportData | null>(initialReport);
  const [error, setError] = useState<string | null>(initialError);
  const [isLoading, setIsLoading] = useState(false);
  const [organogramSearch, setOrganogramSearch] = useState("");
  const [selectedMmLine, setSelectedMmLine] = useState<string | null>(null);
  const effectiveLineFilter = showLinePicker ? (selectedMmLine ?? "") : (fixedLine ?? "");
  const normalizedSearch = normalizeSearchValue(organogramSearch);

  const loadReport = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/reports/organogram", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "organogram_failed");
        return;
      }
      setReport(payload);
    } catch {
      setError("Unable to load organogram.");
    } finally {
      setIsLoading(false);
    }
  }, []);

  const rows = useMemo(
    () => (report?.organogramRows ?? []).filter((r) => isOrganogramVisibleRow(r)),
    [report],
  );

  const availableLines = useMemo(() => {
    if (!showLinePicker) return [] as string[];
    const seen = new Set<string>();
    for (const r of rows) {
      if (r.lineName?.trim()) seen.add(r.lineName.trim());
    }
    return Array.from(seen).sort();
  }, [showLinePicker, rows]);

  const mmReady = !showLinePicker || selectedMmLine !== null;

  const filteredRows = useMemo(
    () => filterOrganogramRows(rows, effectiveLineFilter, normalizedSearch),
    [effectiveLineFilter, normalizedSearch, rows],
  );

  const employees = useMemo(
    () => filteredRows.filter((r) => r.type === "employee").length,
    [filteredRows],
  );

  const vacancies = useMemo(
    () => filteredRows.filter((r) => r.type === "vacancy").length,
    [filteredRows],
  );

  const lanes = useMemo(
    () => (effectiveLineFilter || normalizedSearch ? buildOrganogramLanes(filteredRows) : null),
    [effectiveLineFilter, filteredRows, normalizedSearch],
  );

  const lineName = effectiveLineFilter || "Select Line";

  return (
    <div className="space-y-5" dir="auto">
      {/* ---- MM Line Picker (horizontal buttons) ---- */}
      {showLinePicker && report && (
        <Card className={`rounded border border-slate-100 p-4 sm:p-5 ${cardShadow}`}>
          <span className={`mb-2 block ${labelClassName}`}>Product Line</span>
          {availableLines.length === 0 ? (
            <p className="text-sm text-slate-400">No product lines available.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableLines.map((line) => {
                const isActive = selectedMmLine === line;
                return (
                  <button
                    aria-pressed={isActive}
                    className={`rounded border px-4 py-2 text-sm font-semibold transition ${
                      isActive
                        ? "border-orange-500 bg-orange-500 text-white shadow-sm"
                        : "border-slate-200 bg-white text-slate-700 hover:border-orange-300 hover:text-orange-600"
                    }`}
                    key={line}
                    onClick={() => setSelectedMmLine(isActive ? null : line)}
                    type="button"
                  >
                    {line}
                  </button>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {/* ---- MM Prompt (no line selected yet) ---- */}
      {showLinePicker && !selectedMmLine && report && (
        <Card className={`rounded border border-slate-100 p-8 text-center ${cardShadow}`}>
          <h3 className="text-sm font-semibold text-slate-700">
            Select a product line to view its organogram
          </h3>
          <p className="mx-auto mt-2 max-w-md text-[11px] text-slate-400">
            Choose a line from the dropdown above. KPIs, vacancies, and the full hierarchy tree will appear for the selected line.
          </p>
        </Card>
      )}

      {/* ---- Data sections — gated for MM until a line is chosen ---- */}
      {mmReady && <>
      {/* ---- Error Message ---- */}
      {error && (
        <div className="rounded border border-rose-200 bg-rose-50 px-4 py-3 text-sm">
          <p className="font-semibold text-rose-800">Organogram unavailable</p>
          <p className="mt-0.5 text-rose-700">{error}</p>
        </div>
      )}

      {/* ---- Loading ---- */}
      {isLoading && !report && (
        <Card className={`rounded border border-slate-100 p-6 ${cardShadow}`}>
          <div className="flex items-center gap-3 text-sm text-slate-500">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-orange-500 border-t-transparent" />
            Loading organogram...
          </div>
        </Card>
      )}

      {/* ---- Search & Filters ---- */}
      {report && (
        <Card className={`rounded border border-slate-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                Filters
              </span>
              <span className="text-[11px] font-medium text-slate-500">
                {filteredRows.length} of {rows.length} positions shown
              </span>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
            <label className="block">
              <span className={`mb-1.5 block ${labelClassName}`}>Search</span>
              <input
                className={inputClassName}
                onChange={(e) => setOrganogramSearch(e.target.value)}
                placeholder="Search name, HR ID, manager..."
                type="text"
                value={organogramSearch}
              />
            </label>
            <div className="flex items-end gap-2">
              {organogramSearch && (
                <button
                  aria-label="Clear search"
                  className="inline-flex h-10 items-center rounded border border-slate-200 bg-white px-3 text-[12px] font-semibold text-slate-600 shadow-sm transition hover:border-orange-200 hover:text-orange-600"
                  onClick={() => setOrganogramSearch("")}
                  type="button"
                >
                  Reset
                </button>
              )}
              <button
                aria-label="Refresh organogram data"
                className="inline-flex h-10 items-center rounded bg-orange-500 px-4 text-[12px] font-semibold text-white shadow-sm transition hover:bg-orange-600 disabled:opacity-50"
                disabled={isLoading}
                onClick={() => void loadReport()}
                type="button"
              >
                {isLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* ---- Organogram Chart ---- */}
      {report && lanes && (
        <WorkspaceErrorBoundary fallbackTitle="Organogram tree unavailable">
          <Card className={`overflow-hidden rounded border border-slate-100 p-0 ${cardShadow}`}>
            {/* Section header */}
            <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-sm bg-orange-500" />
                  <div>
                    <h3 className="text-sm font-bold text-slate-800">
                      {lineName} Structure
                    </h3>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      Leadership, manager lanes, employees, and vacancies
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                    {employees} employees
                  </span>
                  {vacancies > 0 && (
                    <span className="rounded bg-orange-50 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-orange-600">
                      {vacancies} vacancies
                    </span>
                  )}
                  <span className="rounded bg-slate-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-slate-600">
                    {lanes.groups.length} lanes
                  </span>
                </div>
              </div>
            </div>

            {/* Bold chart */}
            <div className="px-3 py-4 sm:px-5">
              <OrgChartTree
                kpiLabels={PORTAL_KPI_LABELS}
                lineName={effectiveLineFilter || (normalizedSearch ? "Search results" : lineName)}
                rows={filteredRows}
                theme="portal"
              />
            </div>
          </Card>
        </WorkspaceErrorBoundary>
      )}

      {/* No line selected message — shown for non-MM roles that have no filter yet */}
      {!showLinePicker && report && !effectiveLineFilter && !normalizedSearch && (
        <Card className={`rounded border border-slate-100 p-8 text-center ${cardShadow}`}>
          <h3 className="text-sm font-semibold text-slate-700">
            Select a line to view the organogram
          </h3>
          <p className="mx-auto mt-2 max-w-md text-[11px] text-slate-400">
            The hierarchy stays hidden until a line is selected, so the chart
            only shows the exact structure you are reviewing.
          </p>
        </Card>
      )}
      </>}
    </div>
  );
}
