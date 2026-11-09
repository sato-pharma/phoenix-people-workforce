"use client";

import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { humanizeCode } from "@/lib/format/code-label";
import { PortalDesktopTable } from "@/components/employee-portal/portal-primitives";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import { employeeLeftWord } from "@/lib/employees/left-flag";
import {
  calculateProbationProgress,
  classifyProbationRowZone,
  summarizeProbationRiskRows,
} from "@/lib/lifecycle-risk/metrics";
import type {
  ProbationRow,
  ProbationWorkflowAction,
  ProbationZone,
} from "@/lib/probation/types";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxFieldClassName,
  phxLabelTextClassName,
} from "@/components/ui/form-tokens";
import { adminControlDepthClassName, adminPanelDepthClassName, adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";


/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type EmployeeProbationDashboardProps = {
  // Resolved server-side by canExportProbation (src/lib/probation/service.ts) — the SAME predicate
  // /api/exports enforces, so the button never appears for someone the endpoint would 403. The file
  // contains only the rows getProbationRows returns for this viewer (their own subtree), not the
  // company-wide list the admin tracker exports.
  canExport?: boolean;
  /**
   * Gates the `manager_feedback` WORKFLOW action only. It no longer gates a feedback form: the
   * legacy per-cycle feedback panel was retired 2026-09-01 (see the note further down).
   */
  canSubmitManagerFeedback: boolean;
  initialData: ProbationRow[];
};

type SortKey =
  | "days-asc"
  | "days-desc"
  | "hire-asc"
  | "hire-desc"
  | "name-asc"
  | "name-desc";

type SelectedWorkflowAction = {
  action: ProbationWorkflowAction;
  row: ProbationRow;
};

type ActionFormState = {
  decisionReason: string;
  managerFeedback: string;
  terminationHrId: string;
  workflowNote: string;
};

/* ------------------------------------------------------------------ */
/*  Constants                                                         */
/* ------------------------------------------------------------------ */

const ALL_VALUE = "__all__";
const PROBATION_PAGE_SIZE = 25;

const inputClassName  = phxFieldClassName;

const labelClassName =
  phxLabelTextClassName;

const cardShadow = adminPanelDepthClassName;

/* ------------------------------------------------------------------ */
/*  Helpers                                                           */
/* ------------------------------------------------------------------ */

function emptyActionForm(): ActionFormState {
  return {
    decisionReason: "",
    managerFeedback: "",
    terminationHrId: "",
    workflowNote: "",
  };
}

function formatDate(value: string) {
  return formatDateOnly(value, "en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function zoneColor(zone: ProbationZone) {
  if (zone === "overdue") return { bg: "bg-violet-600", text: "text-violet-700", light: "bg-violet-50", border: "border-violet-500", dot: "bg-violet-600" };
  if (zone === "safe") return { bg: "bg-emerald-500", text: "text-emerald-700", light: "bg-emerald-50", border: "border-emerald-400", dot: "bg-emerald-500" };
  if (zone === "warning") return { bg: "bg-amber-500", text: "text-amber-700", light: "bg-amber-50", border: "border-amber-400", dot: "bg-amber-500" };
  return { bg: "bg-rose-500", text: "text-rose-700", light: "bg-rose-50", border: "border-rose-400", dot: "bg-rose-500" };
}

function zoneLabel(zone: ProbationZone) {
  if (zone === "overdue") return "Overdue decision";
  return zone === "safe" ? "Safe" : zone === "warning" ? "Warning" : "Critical";
}

// A probation that ended with no decision counts DAYS LATE, never a clamped "0 days left".
function daysCellText(row: ProbationRow) {
  if (!row.overdue_decision) return String(Math.max(0, row.days_remaining));
  const late = Math.max(0, -row.days_remaining);
  return late === 0 ? "Ended today" : `${late}d late`;
}

function actionLabel(action: ProbationWorkflowAction) {
  const labels: Record<ProbationWorkflowAction, string> = {
    manager_feedback: "Feedback",
    pass: "Pass",
    terminate: "Terminate",
  };
  return labels[action];
}

function workflowStatusLabel(status: string | null | undefined) {
  return status ? humanizeCode(status) : "Not requested";
}

function workflowBadgeColors(status: string | null | undefined) {
  if (status === "passed") return "bg-emerald-50 text-emerald-700";
  if (status === "terminated") return "bg-rose-50 text-rose-700";
  if (status === "active" || status === "extended") return "bg-amber-50 text-amber-700";
  return "bg-slate-100 text-slate-500";
}

/* ------------------------------------------------------------------ */
/*  Component                                                         */
/* ------------------------------------------------------------------ */

export function EmployeeProbationDashboard({
  canExport = false,
  canSubmitManagerFeedback,
  initialData,
}: EmployeeProbationDashboardProps) {
  /* State */
  const [query, setQuery] = useState("");
  const [lineFilter, setLineFilter] = useState(ALL_VALUE);
  const [areaFilter, setAreaFilter] = useState(ALL_VALUE);
  const [jobFilter, setJobFilter] = useState(ALL_VALUE);
  const [trafficFilter, setTrafficFilter] = useState<"all" | ProbationZone>("all");
  const [sortBy, setSortBy] = useState<SortKey>("days-asc");
  const [rows, setRows] = useState<ProbationRow[]>(initialData);
  const [selectedAction, setSelectedAction] = useState<SelectedWorkflowAction | null>(null);
  const [actionForm, setActionForm] = useState<ActionFormState>(() => emptyActionForm());
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  /* Filter options */
  const filterOptions = useMemo(
    () => ({
      areas: uniqueOptions(rows.map((r) => r.area_name)),
      jobs: uniqueOptions(rows.map((r) => r.job_title)),
      lines: uniqueOptions(rows.map((r) => r.line_name)),
    }),
    [rows],
  );

  /* Filtered + sorted rows */
  const filteredRows = useMemo(() => {
    const search = query.trim().toLowerCase();
    return rows
      .filter((row) => {
        const searchable = [row.full_name, row.hr_id, row.crm_id].join(" ").toLowerCase();
        const traffic = classifyProbationRowZone(row);
        return (
          (!search || searchable.includes(search)) &&
          (lineFilter === ALL_VALUE || row.line_name === lineFilter) &&
          (areaFilter === ALL_VALUE || row.area_name === areaFilter) &&
          (jobFilter === ALL_VALUE || row.job_title === jobFilter) &&
          (trafficFilter === "all" || traffic === trafficFilter)
        );
      })
      .sort((a, b) => {
        // A probation that ended with no decision is always first, whichever sort is picked.
        if (Boolean(a.overdue_decision) !== Boolean(b.overdue_decision)) return a.overdue_decision ? -1 : 1;
        if (sortBy === "days-desc") return b.days_remaining - a.days_remaining;
        if (sortBy === "hire-asc") return (parseDateOnly(a.hire_date)?.getTime() ?? 0) - (parseDateOnly(b.hire_date)?.getTime() ?? 0);
        if (sortBy === "hire-desc") return (parseDateOnly(b.hire_date)?.getTime() ?? 0) - (parseDateOnly(a.hire_date)?.getTime() ?? 0);
        if (sortBy === "name-asc") return a.full_name.localeCompare(b.full_name);
        if (sortBy === "name-desc") return b.full_name.localeCompare(a.full_name);
        return a.days_remaining - b.days_remaining; // days-asc default
      });
  }, [areaFilter, jobFilter, lineFilter, query, rows, sortBy, trafficFilter]);

  /* Pagination */
  const [page, setPage] = useState(0);
  const [prevFilteredRows, setPrevFilteredRows] = useState(filteredRows);
  if (filteredRows !== prevFilteredRows) {
    setPrevFilteredRows(filteredRows);
    setPage(0);
  }
  const pageRows = filteredRows.slice(page * PROBATION_PAGE_SIZE, (page + 1) * PROBATION_PAGE_SIZE);

  /* Summary */
  const summary = useMemo(
    () =>
      summarizeProbationRiskRows(
        filteredRows.map((row) => ({
          daysRemaining: row.days_remaining,
          employeeHrId: row.hr_id,
          employeeName: row.full_name,
          hireDate: row.hire_date,
          overdueDecision: row.overdue_decision ?? false,
          probationEndDate: row.probation_end_date,
          workflowDecision: row.workflow?.decision ?? null,
        })),
      ),
    [filteredRows],
  );

  /* Active filter tracking */
  const hasActiveFilters =
    query.length > 0 ||
    lineFilter !== ALL_VALUE ||
    areaFilter !== ALL_VALUE ||
    jobFilter !== ALL_VALUE ||
    trafficFilter !== "all" ||
    sortBy !== "days-asc";

  function resetFilters() {
    setQuery("");
    setLineFilter(ALL_VALUE);
    setAreaFilter(ALL_VALUE);
    setJobFilter(ALL_VALUE);
    setTrafficFilter("all");
    setSortBy("days-asc");
  }

  /* Workflow actions */
  function openWorkflowAction(row: ProbationRow, action: ProbationWorkflowAction) {
    if (!row.workflow) return;
    setSelectedAction({ action, row });
    setActionForm({
      ...emptyActionForm(),
      managerFeedback: row.workflow.managerFeedback ?? "",
    });
    setMessage(null);
  }

  async function runWorkflow() {
    if (!selectedAction?.row.workflow) return;
    const { action, row } = selectedAction;
    const workflow = row.workflow!;

    if (action === "terminate" && actionForm.terminationHrId.trim().toUpperCase() !== row.hr_id.toUpperCase()) {
      setMessage({ tone: "danger", text: "Type the employee HR ID to confirm termination." });
      return;
    }

    const actionKey = `${workflow.id}:${action}`;
    setPendingAction(actionKey);
    setMessage(null);

    try {
      const response = await fetch(`/api/probation/${workflow.id}/workflow`, {
        body: JSON.stringify({
          action,
          decisionReason: actionForm.decisionReason,
          expectedUpdatedAt: workflow.updatedAt,
          managerFeedback: actionForm.managerFeedback,
          note: actionForm.workflowNote,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error ?? "Probation action failed.");
      }
      setRows(payload.trackerRows ?? payload.rows);
      setSelectedAction(null);
      setActionForm(emptyActionForm());
      setMessage({ tone: "success", text: "Probation review updated." });
    } catch (error) {
      setMessage({
        tone: "danger",
        text: error instanceof Error ? error.message : "Probation action failed.",
      });
    } finally {
      setPendingAction(null);
    }
  }

  /* Zone distribution percentages */
  const overduePercent = summary.total > 0 ? Math.round((summary.overdue / summary.total) * 100) : 0;
  const safePercent = summary.total > 0 ? Math.round((summary.safe / summary.total) * 100) : 0;
  const warningPercent = summary.total > 0 ? Math.round((summary.warning / summary.total) * 100) : 0;
  const criticalPercent = summary.total > 0 ? Math.max(0, 100 - overduePercent - safePercent - warningPercent) : 0;

  /* Allowed actions helper */
  function getAllowedActions(row: ProbationRow): ProbationWorkflowAction[] {
    const actions = row.workflow?.allowedActions ?? row.allowedActions ?? [];
    return actions.filter((a) => canSubmitManagerFeedback || a !== "manager_feedback");
  }

  return (
    <div className="space-y-5" dir="auto">
      {/* ---- Stat Cards ---- */}
      <Card className={`overflow-hidden rounded border border-slate-100 p-0 ${cardShadow}`}>
        <div className="grid grid-cols-2 divide-x divide-y divide-slate-100 lg:grid-cols-5">
          {/* Total */}
          <div className="border-l-2 border-l-orange-400 px-4 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
              Total in Probation
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.total}
            </p>
            <p className="mt-0.5 text-phx-xs text-slate-400">
              Matching current filters
            </p>
          </div>
          {/* Overdue decision */}
          <div className="border-l-2 border-l-violet-500 px-4 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
              Overdue Decision
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.overdue}
            </p>
            <p className="mt-0.5 text-phx-xs text-slate-400">
              Ended with no decision
            </p>
          </div>
          {/* Safe */}
          <div className="border-l-2 border-l-emerald-400 px-4 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
              Safe Zone
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.safe}
            </p>
            <p className="mt-0.5 text-phx-xs text-slate-400">
              More than 60 days remaining
            </p>
          </div>
          {/* Warning */}
          <div className="border-l-2 border-l-amber-400 px-4 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
              Warning Zone
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.warning}
            </p>
            <p className="mt-0.5 text-phx-xs text-slate-400">
              30 to 60 days remaining
            </p>
          </div>
          {/* Critical */}
          <div className="border-l-2 border-l-rose-400 px-4 py-4">
            <p className="text-phx-xs font-semibold uppercase tracking-wider text-slate-400">
              Critical Zone
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.critical}
            </p>
            <p className="mt-0.5 text-phx-xs text-slate-400">
              Less than 30 days remaining
            </p>
          </div>
        </div>
      </Card>

      {/* ---- Zone Distribution Bar ---- */}
      <WorkspaceErrorBoundary fallbackTitle="Zone distribution unavailable">
        <Card className={`rounded border border-slate-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-3">
            <h3 className="text-sm font-bold text-slate-800">Zone Distribution</h3>
            <p className="mt-0.5 text-phx-xs text-slate-400">
              Risk breakdown across probation employees
            </p>
          </div>
          {summary.total > 0 ? (
            <>
              <div
                aria-label="Zone distribution chart"
                className="flex h-4 w-full overflow-hidden rounded"
                role="img"
              >
                {summary.overdue > 0 && (
                  <div
                    aria-label={`Overdue decision: ${overduePercent}%`}
                    className="bg-violet-600"
                    role="img"
                    style={{ width: `${overduePercent}%`, minWidth: "2px" }}
                  />
                )}
                {summary.safe > 0 && (
                  <div
                    aria-label={`Safe zone: ${safePercent}%`}
                    className="bg-emerald-500"
                    role="img"
                    style={{ width: `${safePercent}%`, minWidth: "2px" }}
                  />
                )}
                {summary.warning > 0 && (
                  <div
                    aria-label={`Warning zone: ${warningPercent}%`}
                    className="bg-amber-500"
                    role="img"
                    style={{ width: `${warningPercent}%`, minWidth: "2px" }}
                  />
                )}
                {summary.critical > 0 && (
                  <div
                    aria-label={`Critical zone: ${criticalPercent}%`}
                    className="bg-rose-500"
                    role="img"
                    style={{ width: `${criticalPercent}%`, minWidth: "2px" }}
                  />
                )}
              </div>
              <div className="mt-2.5 flex flex-wrap gap-4 text-phx-xs text-slate-500">
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-violet-600" />
                  Overdue decision {overduePercent}%
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
                  Safe {safePercent}%
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />
                  Warning {warningPercent}%
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="inline-block h-2 w-2 rounded-sm bg-rose-500" />
                  Critical {criticalPercent}%
                </span>
              </div>
            </>
          ) : (
            <div className="flex h-4 w-full items-center justify-center rounded bg-slate-100">
              <span className="text-phx-sm text-slate-400">No data</span>
            </div>
          )}
        </Card>
      </WorkspaceErrorBoundary>

      {/* ---- Message ---- */}
      {message && (
        <div
          className={`rounded border px-4 py-3 text-sm ${
            message.tone === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-800"
              : "border-rose-200 bg-rose-50 text-rose-800"
          }`}
        >
          <p className="font-semibold">
            {message.tone === "success" ? "Probation update" : "Action failed"}
          </p>
          <p className="mt-0.5">{message.text}</p>
        </div>
      )}

      {/* ---- Filters ---- */}
      <Card className={`rounded border border-slate-100 p-4 sm:p-5 ${cardShadow}`}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded bg-orange-50 px-2 py-1 text-phx-xs font-semibold uppercase tracking-wider text-orange-600">
            Filters
          </span>
          <span className="text-phx-xs text-slate-400">
            {filteredRows.length} of {rows.length} employees shown
          </span>
        </div>

        <div className="grid gap-3 xl:grid-cols-[1.5fr_1fr_1fr_1fr_1fr_1fr]">
          {/* Search */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Search</span>
            <input
              className={inputClassName}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name..."
              type="text"
              value={query}
            />
          </label>

          {/* Line */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Line</span>
            <SearchableSelect
              className={inputClassName}
              onChange={(e) => setLineFilter(e.target.value)}
              value={lineFilter}
            >
              <option value={ALL_VALUE}>All lines</option>
              {filterOptions.lines.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </SearchableSelect>
          </label>

          {/* Area */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Area</span>
            <SearchableSelect
              className={inputClassName}
              onChange={(e) => setAreaFilter(e.target.value)}
              value={areaFilter}
            >
              <option value={ALL_VALUE}>All areas</option>
              {filterOptions.areas.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </SearchableSelect>
          </label>

          {/* Job Title */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Job Title</span>
            <SearchableSelect
              className={inputClassName}
              onChange={(e) => setJobFilter(e.target.value)}
              value={jobFilter}
            >
              <option value={ALL_VALUE}>All job titles</option>
              {filterOptions.jobs.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </SearchableSelect>
          </label>

          {/* Zone */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Zone</span>
            <SearchableSelect
              className={inputClassName}
              onChange={(e) => setTrafficFilter(e.target.value as "all" | ProbationZone)}
              value={trafficFilter}
            >
              <option value="all">All zones</option>
              <option value="overdue">Overdue decision</option>
              <option value="safe">Safe</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </SearchableSelect>
          </label>

          {/* Sort */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Sort</span>
            <SearchableSelect
              aria-label="Sort probation records"
              className={inputClassName}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
              value={sortBy}
            >
              <option value="days-asc">Days ascending</option>
              <option value="days-desc">Days descending</option>
              <option value="hire-asc">Hire date ascending</option>
              <option value="hire-desc">Hire date descending</option>
              <option value="name-asc">Name A-Z</option>
              <option value="name-desc">Name Z-A</option>
            </SearchableSelect>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            aria-label="Apply probation filters"
            className="rounded bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:opacity-50"
            disabled={!hasActiveFilters}
            onClick={() => {
              /* Filters apply reactively; this is a visual confirmation anchor */
            }}
            type="button"
          >
            Apply
          </button>
          <button
            aria-label="Reset all probation filters"
            className={`rounded border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50 disabled:shadow-none ${adminControlDepthClassName}`}
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            type="button"
          >
            Reset
          </button>
          {canExport ? (
            <>
              <a
                className={`rounded border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 ${adminControlDepthClassName}`}
                href="/api/exports?report=probation&format=xlsx"
              >
                Export Excel
              </a>
              <a
                className={`rounded border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 ${adminControlDepthClassName}`}
                href="/api/exports?report=probation&format=pdf"
              >
                Export PDF
              </a>
            </>
          ) : null}
        </div>
      </Card>

      {/* ---- Desktop Table ---- */}
      <Card className={`hidden overflow-hidden rounded border border-slate-100 p-0 lg:block ${cardShadow}`}>
        <PortalDesktopTable
          breakpoint="lg"
          cols={
            <colgroup>
              <col className="w-[13%]" />
              <col className="w-[11%]" />
              <col className="w-[12%]" />
              <col className="w-[9%]" />
              <col className="w-[9%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[10%]" />
              <col className="w-[9%]" />
              <col className="w-[11%]" />
            </colgroup>
          }
        >
            <thead>
              <tr className="bg-slate-50/80">
                {[
                  "Employee",
                  "Job Title",
                  "Line / Area",
                  "Hired",
                  "Ends",
                  "Days",
                  "Progress",
                  "Zone",
                  "Review",
                  "Actions",
                ].map((col, idx, arr) => (
                  <th
                    className={`px-3 py-3 text-phx-xs font-semibold uppercase tracking-wider text-slate-400 sm:px-4 ${
                      idx < arr.length - 1 ? "border-r border-slate-100" : ""
                    }`}
                    key={col}
                  >
                    {col}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 ? (
                <tr>
                  <td
                    className="px-4 py-12 text-center text-sm text-slate-400"
                    colSpan={10}
                  >
                    No probation records match the current filters.
                  </td>
                </tr>
              ) : (
                pageRows.map((row) => {
                  const traffic = classifyProbationRowZone(row);
                  const progress = calculateProbationProgress(row.days_remaining);
                  const colors = zoneColor(traffic);
                  const allowed = getAllowedActions(row);

                  return (
                    <tr
                      className="border-t border-slate-100 transition-colors hover:bg-slate-50/50"
                      key={row.hr_id}
                    >
                      {/* Employee */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <p className="font-semibold text-slate-800">{row.full_name}</p>
                        {employeeLeftWord(row) ? (
                          <p className="break-words text-xs font-bold text-phx-danger">{employeeLeftWord(row)}</p>
                        ) : null}
                      </td>

                      {/* Job Title */}
                      <td className="border-r border-slate-100 px-3 py-3 text-slate-600 sm:px-4">
                        {row.job_title}
                      </td>

                      {/* Line / Area */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <p className="text-slate-600">{row.line_name}</p>
                        <p className="mt-0.5 text-phx-xs text-slate-400">{row.area_name}</p>
                      </td>

                      {/* Hired */}
                      <td className="border-r border-slate-100 px-3 py-3 text-slate-500 sm:px-4">
                        {formatDate(row.hire_date)}
                      </td>

                      {/* Ends */}
                      <td className="border-r border-slate-100 px-3 py-3 text-slate-500 sm:px-4">
                        {formatDate(row.probation_end_date)}
                      </td>

                      {/* Days */}
                      <td className="border-r border-slate-100 px-3 py-3 font-bold text-slate-800 sm:px-4">
                        {daysCellText(row)}
                      </td>

                      {/* Progress */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <div>
                          <div
                            aria-label={`Probation progress for ${row.full_name}`}
                            aria-valuemax={100}
                            aria-valuemin={0}
                            aria-valuenow={progress}
                            className="h-1.5 w-full overflow-hidden bg-slate-100"
                            role="progressbar"
                          >
                            <div
                              className={`h-full ${colors.bg}`}
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <p className="mt-1 text-phx-xs text-slate-400">
                            {progress}%
                          </p>
                        </div>
                      </td>

                      {/* Zone */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 text-phx-xs font-semibold ${colors.light} ${colors.text}`}
                        >
                          {zoneLabel(traffic)}
                        </span>
                      </td>

                      {/* Review */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 text-phx-xs font-semibold ${workflowBadgeColors(row.workflow?.status)}`}
                        >
                          {workflowStatusLabel(row.workflow?.status)}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3 sm:px-4">
                        <div className="flex flex-wrap gap-1.5">
                          {row.workflow && allowed.map((action) => (
                            <button
                              className={`px-2.5 py-1.5 text-phx-xs font-semibold transition disabled:opacity-50 ${
                                action === "terminate"
                                  ? "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                                  : action === "pass"
                                    ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                    : `border border-slate-200 bg-white text-slate-600 hover:bg-slate-50 ${adminControlDepthClassName}`
                              }`}
                              disabled={Boolean(pendingAction)}
                              key={action}
                              onClick={() => openWorkflowAction(row, action)}
                              type="button"
                            >
                              {actionLabel(action)}
                            </button>
                          ))}
                          {!row.workflow && !canSubmitManagerFeedback && (
                            <span className="text-phx-xs text-slate-400">No review</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
        </PortalDesktopTable>
      </Card>

      {/* ---- Mobile Card View ---- */}
      <div className="space-y-0 lg:hidden">
        <Card className={`divide-y divide-slate-100 overflow-hidden rounded border border-slate-100 p-0 ${cardShadow}`}>
          {filteredRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-400">
              No probation records match the current filters.
            </div>
          ) : (
            pageRows.map((row) => {
              const traffic = classifyProbationRowZone(row);
              const progress = calculateProbationProgress(row.days_remaining);
              const colors = zoneColor(traffic);
              const allowed = getAllowedActions(row);

              return (
                <div
                  className={`border-l-[3px] ${colors.border} px-4 py-3.5`}
                  key={row.hr_id}
                >
                  {/* Top row: name + zone */}
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-800">{row.full_name}</p>
                      {employeeLeftWord(row) ? (
                        <p className="break-words text-xs font-bold text-phx-danger">{employeeLeftWord(row)}</p>
                      ) : null}
                      <p className="mt-0.5 text-xs text-slate-600">{row.job_title}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded px-2 py-0.5 text-phx-xs font-semibold ${colors.light} ${colors.text}`}
                    >
                      {zoneLabel(traffic)}
                    </span>
                  </div>

                  {/* Metadata pills */}
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-phx-sm text-slate-500">
                      {row.line_name}
                    </span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-phx-sm text-slate-500">
                      {row.area_name}
                    </span>
                  </div>

                  {/* Progress bar */}
                  <div className="mt-2.5">
                    <div
                      aria-label={`Probation progress for ${row.full_name}`}
                      aria-valuemax={100}
                      aria-valuemin={0}
                      aria-valuenow={progress}
                      className="h-1.5 w-full overflow-hidden rounded bg-slate-100"
                      role="progressbar"
                    >
                      <div
                        className={`h-full rounded ${colors.bg}`}
                        style={{ width: `${progress}%` }}
                      />
                    </div>
                  </div>

                  {/* Bottom metadata */}
                  <div className="mt-2 flex justify-between text-phx-xs text-slate-400">
                    <span>Hired {formatDate(row.hire_date)}</span>
                    <span>Ends {formatDate(row.probation_end_date)}</span>
                    <span>{row.overdue_decision ? daysCellText(row) : `${Math.max(0, row.days_remaining)}d left`}</span>
                    <span>{progress}%</span>
                  </div>

                  {/* Review + actions */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center rounded px-2 py-0.5 text-phx-sm font-semibold ${workflowBadgeColors(row.workflow?.status)}`}
                    >
                      {workflowStatusLabel(row.workflow?.status)}
                    </span>
                    {row.workflow && allowed.length > 0 && (
                      <>
                        {allowed.map((action) => (
                          <button
                            className={`rounded px-2 py-1 text-phx-sm font-semibold transition disabled:opacity-50 ${
                              action === "terminate"
                                ? "border border-rose-200 bg-rose-50 text-rose-700"
                                : action === "pass"
                                  ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : `border border-slate-200 bg-white text-slate-600 ${adminSoftDepthClassName}`
                            }`}
                            disabled={Boolean(pendingAction)}
                            key={action}
                            onClick={() => openWorkflowAction(row, action)}
                            type="button"
                          >
                            {actionLabel(action)}
                          </button>
                        ))}
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </Card>
      </div>

      <PaginationControls
        onPageChange={setPage}
        page={page}
        pageSize={PROBATION_PAGE_SIZE}
        total={filteredRows.length}
      />

      {/*
        RETIRED 2026-09-01 — the per-cycle feedback panel and the DV checkbox strip stood here.
        Both read employee_probation, which has held ZERO rows since the Case model took over
        provisioning, so the panel always answered "not eligible" and the DV strip never rendered
        (the `dv_state` it read was built from that same empty table, so it was always null; that
        projection has since been deleted outright).

        Feedback lives in the Case model now: submit against a real double-visit at
        /employee-portals/probation/feedback/<dvDayId>, listed on this portal's own feedback-tasks
        view. Do not re-add a second feedback surface here.
      */}

      {/* ---- Workflow Action Form ---- */}
      {selectedAction && (
        <Card className={`rounded border border-slate-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-4">
            <h3 className="text-sm font-bold text-slate-800">
              {actionLabel(selectedAction.action)}: {selectedAction.row.full_name}
            </h3>
            <p className="mt-0.5 text-phx-xs text-slate-400">
              {workflowStatusLabel(selectedAction.row.workflow?.status)} | ends {formatDate(selectedAction.row.probation_end_date)}
            </p>
          </div>

          <div className="grid gap-3 lg:grid-cols-3">
            {selectedAction.action === "manager_feedback" && (
              <label className="block lg:col-span-3">
                <span className={`mb-1.5 block ${labelClassName}`}>
                  Manager Feedback
                </span>
                <input
                  className={inputClassName}
                  onChange={(e) =>
                    setActionForm((f) => ({ ...f, managerFeedback: e.target.value }))
                  }
                  placeholder="Manager evaluation feedback"
                  type="text"
                  value={actionForm.managerFeedback}
                />
              </label>
            )}

            {(selectedAction.action === "pass" || selectedAction.action === "terminate") && (
              <label className="block lg:col-span-2">
                <span className={`mb-1.5 block ${labelClassName}`}>
                  Decision Reason
                </span>
                <input
                  className={inputClassName}
                  onChange={(e) =>
                    setActionForm((f) => ({ ...f, decisionReason: e.target.value }))
                  }
                  placeholder={
                    selectedAction.action === "terminate"
                      ? "Termination reason"
                      : "Optional HR note"
                  }
                  type="text"
                  value={actionForm.decisionReason}
                />
              </label>
            )}

            {selectedAction.action === "terminate" && (
              <label className="block lg:col-span-3">
                <span className="mb-1.5 block text-phx-xs font-semibold uppercase tracking-wider text-rose-600">
                  Type HR ID to confirm termination
                </span>
                <input
                  className={inputClassName}
                  onChange={(e) =>
                    setActionForm((f) => ({ ...f, terminationHrId: e.target.value }))
                  }
                  placeholder={selectedAction.row.hr_id}
                  type="text"
                  value={actionForm.terminationHrId}
                />
              </label>
            )}

            <label className="block lg:col-span-3">
              <span className={`mb-1.5 block ${labelClassName}`}>
                Review Note
              </span>
              <input
                className={inputClassName}
                onChange={(e) =>
                  setActionForm((f) => ({ ...f, workflowNote: e.target.value }))
                }
                placeholder="Optional note for this action"
                type="text"
                value={actionForm.workflowNote}
              />
            </label>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={`rounded px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50 ${
                selectedAction.action === "terminate"
                  ? "bg-rose-600 hover:bg-rose-700"
                  : "bg-orange-500 hover:bg-orange-600"
              }`}
              disabled={Boolean(pendingAction)}
              onClick={runWorkflow}
              type="button"
            >
              {pendingAction ? "Submitting..." : actionLabel(selectedAction.action)}
            </button>
            <button
              className={`rounded border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 ${adminControlDepthClassName}`}
              onClick={() => {
                setSelectedAction(null);
                setActionForm(emptyActionForm());
              }}
              type="button"
            >
              Close
            </button>
          </div>
        </Card>
      )}
    </div>
  );
}
