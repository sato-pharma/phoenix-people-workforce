"use client";

import { useCallback, useMemo, useRef, useState } from "react";

import { OrgChartTree, type OrgChartKpiLabels } from "@/components/organogram/org-chart";
import { OrganogramAsOfPicker } from "@/components/organogram/organogram-as-of";
import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { buildOrganogramChartCounts, formatDistrictLaneCount } from "@/lib/reports/organogram-counts";
import {
  buildLinePickerOptions,
  buildOrganogramLanes,
  filterOrganogramRows,
  isOrganogramVisibleRow,
} from "@/lib/reports/organogram-view-model";
import type { VacancyReportData } from "@/lib/reports/vacancies";
import { phxLabelTextClassName } from "@/components/ui/form-tokens";
import { adminPanelDepthClassName } from "@/components/admin/admin-design-tokens";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type EmployeeOrganogramDashboardProps = {
  // Server-decided: does this viewer hold `employees:update`? Only then does a vacancy
  // popup offer "Add employee to this seat". Never inferred client-side.
  canAddEmployee?: boolean;
  fixedLine?: string | null;
  initialError?: string | null;
  initialReport?: VacancyReportData | null;
  // Server-decided: does this viewer pass canAccessHeadOffice? Only then may the
  // picker offer Head Office as a branch to open. Never inferred client-side.
  showHeadOfficeLine?: boolean;
  showLinePicker?: boolean;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const labelClassName =
  phxLabelTextClassName;

const cardShadow = adminPanelDepthClassName;

// Shorter KPI labels tuned for the narrower portal column. The admin surface keeps
// the full-length labels from the shared chart defaults.
const PORTAL_KPI_LABELS: OrgChartKpiLabels = {
  dsm: "District Managers",
  medicalRep: "Medical Reps",
  nsm: "National Managers",
  rsm: "Regional Managers",
  total: "All Sales Seats",
};

/* ------------------------------------------------------------------ */
/*  Main Component                                                    */
/* ------------------------------------------------------------------ */

export function EmployeeOrganogramDashboard({
  canAddEmployee = false,
  fixedLine = null,
  initialError = null,
  initialReport = null,
  showHeadOfficeLine = false,
  showLinePicker = false,
}: EmployeeOrganogramDashboardProps) {
  const [report, setReport] = useState<VacancyReportData | null>(initialReport);
  const [error, setError] = useState<string | null>(initialError);
  const [isLoading, setIsLoading] = useState(false);
  // "View as of": `asOfMonth` is what the picker says, `reportAsOf` the date of the report we are
  // HOLDING. They differ only while a fetch is in flight or after it failed; the chart is always
  // labelled with `reportAsOf`, so a failed pick never leaves one date's chart under another's picker.
  const [asOfMonth, setAsOfMonth] = useState<string | null>(null);
  const [reportAsOf, setReportAsOf] = useState<string | null>(null);
  const latestRequest = useRef(0);
  const reportAsOfRef = useRef<string | null>(null);
  const [selectedMmLine, setSelectedMmLine] = useState<string | null>(null);
  const effectiveLineFilter = showLinePicker ? (selectedMmLine ?? "") : (fixedLine ?? "");

  const loadReport = useCallback(async (month: string | null) => {
    const request = ++latestRequest.current;
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch(
        month ? `/api/reports/organogram?asOf=${encodeURIComponent(month)}` : "/api/reports/organogram",
        { cache: "no-store" },
      );
      const payload = await response.json();
      // A newer pick has already gone out: this answer is for a date nobody is looking at.
      if (request !== latestRequest.current) return;
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "organogram_failed");
        // Put the picker back on the date the chart still shows.
        setAsOfMonth(reportAsOfRef.current);
        return;
      }
      setReport(payload);
      reportAsOfRef.current = month;
      setReportAsOf(month);
    } catch {
      if (request !== latestRequest.current) return;
      setError("Unable to load organogram.");
      setAsOfMonth(reportAsOfRef.current);
    } finally {
      if (request === latestRequest.current) setIsLoading(false);
    }
  }, []);

  const handleAsOfChange = useCallback(
    (month: string | null) => {
      setAsOfMonth(month);
      void loadReport(month);
    },
    [loadReport],
  );

  const rows = useMemo(
    () => (report?.organogramRows ?? []).filter((r) => isOrganogramVisibleRow(r)),
    [report],
  );

  const availableLines = useMemo(
    () =>
      showLinePicker
        ? buildLinePickerOptions(rows, { includeHeadOffice: showHeadOfficeLine })
        : ([] as string[]),
    [showHeadOfficeLine, showLinePicker, rows],
  );

  const mmReady = !showLinePicker || selectedMmLine !== null;

  const filteredRows = useMemo(
    () => filterOrganogramRows(rows, effectiveLineFilter, ""),
    [effectiveLineFilter, rows],
  );

  const lanes = useMemo(
    () => (effectiveLineFilter ? buildOrganogramLanes(filteredRows) : null),
    [effectiveLineFilter, filteredRows],
  );

  // The header chips and the chart's own figures are ONE count (src/lib/reports/organogram-counts.ts):
  // the header used to say "37 employees" and "6 lanes" over a chart that said 32 of 47 seats and 4 lanes.
  const counts = useMemo(
    () => (lanes ? buildOrganogramChartCounts(filteredRows, lanes.groups) : null),
    [filteredRows, lanes],
  );

  const lineName = effectiveLineFilter || "Select Line";

  return (
    <div className="space-y-5" dir="auto">
      {/* ---- MM Line Picker (horizontal buttons) ---- */}
      {showLinePicker && report && (
        <Card className={`rounded border border-slate-100 p-4 sm:p-5 ${cardShadow}`}>
          <span className={`mb-2 block ${labelClassName}`}>
            {showHeadOfficeLine ? "Line" : "Product Line"}
          </span>
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
            {showHeadOfficeLine
              ? "Select a line to view its organogram"
              : "Select a product line to view its organogram"}
          </h3>
          <p className="mx-auto mt-2 max-w-md text-phx-xs text-slate-400">
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

      {/* ---- Filters ---- */}
      {report && (
        <Card className={`rounded border border-slate-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center rounded bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-600">
                Filters
              </span>
              <span className="text-phx-xs font-medium text-slate-500">
                {filteredRows.length} of {rows.length} positions shown
              </span>
            </div>
            <div className="flex flex-wrap items-end gap-3">
              <OrganogramAsOfPicker disabled={isLoading} onChange={handleAsOfChange} value={asOfMonth} />
              <button
                aria-label="Refresh organogram data"
                className="inline-flex h-10 items-center rounded bg-orange-500 px-4 text-phx-sm font-semibold text-white shadow-sm transition hover:bg-orange-600 disabled:opacity-50"
                disabled={isLoading}
                onClick={() => void loadReport(asOfMonth)}
                type="button"
              >
                {isLoading ? "Loading..." : "Refresh"}
              </button>
            </div>
          </div>
        </Card>
      )}

      {/* ---- Organogram Chart ---- */}
      {report && lanes && counts && (
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
                    <p className="mt-0.5 text-phx-xs text-slate-500">
                      Leadership, manager lanes, employees, and vacancies
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="rounded bg-slate-100 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-600">
                    {counts.seats.filled} of {counts.seats.total} sales seats filled
                  </span>
                  {counts.seats.open > 0 && (
                    <span className="rounded bg-orange-50 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-orange-600">
                      {counts.seats.open} open {counts.seats.open === 1 ? "seat" : "seats"}
                    </span>
                  )}
                  <span className="rounded bg-slate-100 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-600">
                    {counts.people.shown} {counts.people.shown === 1 ? "person" : "people"} shown
                  </span>
                  <span className="rounded bg-slate-100 px-2 py-1 text-phx-2xs font-bold uppercase tracking-wider text-slate-600">
                    {formatDistrictLaneCount(counts.lanes.district)}
                  </span>
                </div>
              </div>
            </div>

            {/* Bold chart */}
            <div className="px-3 py-4 sm:px-5">
              <OrgChartTree
                asOfMonth={reportAsOf}
                canAddEmployee={canAddEmployee}
                kpiLabels={PORTAL_KPI_LABELS}
                lineName={effectiveLineFilter || lineName}
                rows={filteredRows}
                theme="portal"
              />
            </div>
          </Card>
        </WorkspaceErrorBoundary>
      )}

      {/* No line selected message — shown for non-MM roles that have no filter yet */}
      {!showLinePicker && report && !effectiveLineFilter && (
        <Card className={`rounded border border-slate-100 p-8 text-center ${cardShadow}`}>
          <h3 className="text-sm font-semibold text-slate-700">
            Select a line to view the organogram
          </h3>
          <p className="mx-auto mt-2 max-w-md text-phx-xs text-slate-400">
            The hierarchy stays hidden until a line is selected, so the chart
            only shows the exact structure you are reviewing.
          </p>
        </Card>
      )}
      </>}
    </div>
  );
}
