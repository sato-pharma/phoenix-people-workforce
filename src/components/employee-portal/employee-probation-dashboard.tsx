"use client";

import { useMemo, useState } from "react";

import { Card } from "@/components/ui/card";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import {
  calculateProbationProgress,
  classifyProbationTrafficStatus,
  summarizeProbationRiskRows,
} from "@/lib/lifecycle-risk/metrics";
import type {
  ProbationRow,
  ProbationWorkflowAction,
  TrafficStatus,
} from "@/lib/probation/types";

/* ------------------------------------------------------------------ */
/*  Types                                                             */
/* ------------------------------------------------------------------ */

type EmployeeProbationDashboardProps = {
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

const inputClassName =
  "w-full rounded-md border border-gray-200 bg-white px-3 py-2.5 text-sm text-slate-700 outline-none transition focus:border-orange-300 focus:shadow-[0_0_0_3px_rgba(249,115,22,0.08)]";

const labelClassName =
  "text-[11px] font-semibold uppercase tracking-wider text-slate-400";

const cardShadow = "shadow-[0_1px_3px_rgba(15,23,42,0.08)]";

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

function zoneColor(zone: TrafficStatus) {
  if (zone === "safe") return { bg: "bg-emerald-500", text: "text-emerald-700", light: "bg-emerald-50", border: "border-emerald-400", dot: "bg-emerald-500" };
  if (zone === "warning") return { bg: "bg-amber-500", text: "text-amber-700", light: "bg-amber-50", border: "border-amber-400", dot: "bg-amber-500" };
  return { bg: "bg-rose-500", text: "text-rose-700", light: "bg-rose-50", border: "border-rose-400", dot: "bg-rose-500" };
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
  return status ? status.replace(/_/g, " ") : "not requested";
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
  canSubmitManagerFeedback,
  initialData,
}: EmployeeProbationDashboardProps) {
  /* State */
  const [query, setQuery] = useState("");
  const [lineFilter, setLineFilter] = useState(ALL_VALUE);
  const [areaFilter, setAreaFilter] = useState(ALL_VALUE);
  const [jobFilter, setJobFilter] = useState(ALL_VALUE);
  const [trafficFilter, setTrafficFilter] = useState<"all" | TrafficStatus>("all");
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
        const traffic = classifyProbationTrafficStatus(row.days_remaining);
        return (
          (!search || searchable.includes(search)) &&
          (lineFilter === ALL_VALUE || row.line_name === lineFilter) &&
          (areaFilter === ALL_VALUE || row.area_name === areaFilter) &&
          (jobFilter === ALL_VALUE || row.job_title === jobFilter) &&
          (trafficFilter === "all" || traffic === trafficFilter)
        );
      })
      .sort((a, b) => {
        if (sortBy === "days-desc") return b.days_remaining - a.days_remaining;
        if (sortBy === "hire-asc") return (parseDateOnly(a.hire_date)?.getTime() ?? 0) - (parseDateOnly(b.hire_date)?.getTime() ?? 0);
        if (sortBy === "hire-desc") return (parseDateOnly(b.hire_date)?.getTime() ?? 0) - (parseDateOnly(a.hire_date)?.getTime() ?? 0);
        if (sortBy === "name-asc") return a.full_name.localeCompare(b.full_name);
        if (sortBy === "name-desc") return b.full_name.localeCompare(a.full_name);
        return a.days_remaining - b.days_remaining; // days-asc default
      });
  }, [areaFilter, jobFilter, lineFilter, query, rows, sortBy, trafficFilter]);

  /* Summary */
  const summary = useMemo(
    () =>
      summarizeProbationRiskRows(
        filteredRows.map((row) => ({
          daysRemaining: row.days_remaining,
          employeeHrId: row.hr_id,
          employeeName: row.full_name,
          hireDate: row.hire_date,
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
      setRows(payload.rows);
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
  const safePercent = summary.total > 0 ? Math.round((summary.safe / summary.total) * 100) : 0;
  const warningPercent = summary.total > 0 ? Math.round((summary.warning / summary.total) * 100) : 0;
  const criticalPercent = summary.total > 0 ? 100 - safePercent - warningPercent : 0;

  /* Allowed actions helper */
  function getAllowedActions(row: ProbationRow): ProbationWorkflowAction[] {
    const actions = row.workflow?.allowedActions ?? row.allowedActions ?? [];
    return actions.filter((a) => canSubmitManagerFeedback || a !== "manager_feedback");
  }

  return (
    <div className="space-y-5" dir="auto">
      {/* ---- Stat Cards ---- */}
      <Card className={`overflow-hidden rounded-lg border border-gray-100 p-0 ${cardShadow}`}>
        <div className="grid grid-cols-2 divide-x divide-y divide-gray-100 lg:grid-cols-4">
          {/* Total */}
          <div className="border-l-2 border-l-orange-400 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Total in Probation
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.total}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Matching current filters
            </p>
          </div>
          {/* Safe */}
          <div className="border-l-2 border-l-emerald-400 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Safe Zone
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.safe}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              More than 60 days remaining
            </p>
          </div>
          {/* Warning */}
          <div className="border-l-2 border-l-amber-400 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Warning Zone
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.warning}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              30 to 60 days remaining
            </p>
          </div>
          {/* Critical */}
          <div className="border-l-2 border-l-rose-400 px-4 py-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Critical Zone
            </p>
            <p className="mt-1 text-2xl font-bold text-slate-800">
              {summary.critical}
            </p>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Less than 30 days remaining
            </p>
          </div>
        </div>
      </Card>

      {/* ---- Zone Distribution Bar ---- */}
      <WorkspaceErrorBoundary fallbackTitle="Zone distribution unavailable">
        <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-3">
            <h3 className="text-sm font-bold text-slate-800">Zone Distribution</h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              Risk breakdown across probation employees
            </p>
          </div>
          {summary.total > 0 ? (
            <>
              <div
                aria-label="Zone distribution chart"
                className="flex h-4 w-full overflow-hidden rounded-md"
                role="img"
              >
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
              <div className="mt-2.5 flex flex-wrap gap-4 text-[11px] text-slate-500">
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
            <div className="flex h-4 w-full items-center justify-center rounded-md bg-slate-100">
              <span className="text-[10px] text-slate-400">No data</span>
            </div>
          )}
        </Card>
      </WorkspaceErrorBoundary>

      {/* ---- Message ---- */}
      {message && (
        <div
          className={`rounded-md border px-4 py-3 text-sm ${
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
      <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center rounded-md bg-orange-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-wider text-orange-600">
            Filters
          </span>
          <span className="text-[11px] text-slate-400">
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
              placeholder="Search name, HR ID..."
              type="text"
              value={query}
            />
          </label>

          {/* Line */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Line</span>
            <select
              className={inputClassName}
              onChange={(e) => setLineFilter(e.target.value)}
              value={lineFilter}
            >
              <option value={ALL_VALUE}>All lines</option>
              {filterOptions.lines.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>

          {/* Area */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Area</span>
            <select
              className={inputClassName}
              onChange={(e) => setAreaFilter(e.target.value)}
              value={areaFilter}
            >
              <option value={ALL_VALUE}>All areas</option>
              {filterOptions.areas.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>

          {/* Job Title */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Job Title</span>
            <select
              className={inputClassName}
              onChange={(e) => setJobFilter(e.target.value)}
              value={jobFilter}
            >
              <option value={ALL_VALUE}>All job titles</option>
              {filterOptions.jobs.map((v) => (
                <option key={v} value={v}>{v}</option>
              ))}
            </select>
          </label>

          {/* Zone */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Zone</span>
            <select
              className={inputClassName}
              onChange={(e) => setTrafficFilter(e.target.value as "all" | TrafficStatus)}
              value={trafficFilter}
            >
              <option value="all">All zones</option>
              <option value="safe">Safe</option>
              <option value="warning">Warning</option>
              <option value="critical">Critical</option>
            </select>
          </label>

          {/* Sort */}
          <label className="block">
            <span className={`mb-1.5 block ${labelClassName}`}>Sort</span>
            <select
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
            </select>
          </label>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button
            aria-label="Apply probation filters"
            className="rounded-md bg-orange-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-orange-600 disabled:opacity-50"
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
            className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50 disabled:opacity-50"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            type="button"
          >
            Reset
          </button>
        </div>
      </Card>

      {/* ---- Desktop Table ---- */}
      <Card className={`hidden overflow-hidden rounded-lg border border-gray-100 p-0 sm:block ${cardShadow}`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1200px] text-left text-sm">
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
                    className={`px-3 py-3 text-[11px] font-semibold uppercase tracking-wider text-slate-400 sm:px-4 ${
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
                filteredRows.map((row) => {
                  const traffic = classifyProbationTrafficStatus(row.days_remaining);
                  const progress = calculateProbationProgress(row.days_remaining);
                  const colors = zoneColor(traffic);
                  const allowed = getAllowedActions(row);

                  return (
                    <tr
                      className="border-t border-gray-100 transition-colors hover:bg-slate-50/50"
                      key={row.hr_id}
                    >
                      {/* Employee */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <p className="font-semibold text-slate-800">{row.full_name}</p>
                        <p className="mt-0.5 text-[11px] text-slate-400">{row.hr_id}</p>
                      </td>

                      {/* Job Title */}
                      <td className="border-r border-slate-100 px-3 py-3 text-slate-600 sm:px-4">
                        {row.job_title}
                      </td>

                      {/* Line / Area */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <p className="text-slate-600">{row.line_name}</p>
                        <p className="mt-0.5 text-[11px] text-slate-400">{row.area_name}</p>
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
                        {row.days_remaining}
                      </td>

                      {/* Progress */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <div className="min-w-[100px]">
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
                          <p className="mt-1 text-[11px] text-slate-400">
                            {progress}%
                          </p>
                        </div>
                      </td>

                      {/* Zone */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${colors.light} ${colors.text}`}
                        >
                          {traffic === "safe" ? "Safe" : traffic === "warning" ? "Warning" : "Critical"}
                        </span>
                      </td>

                      {/* Review */}
                      <td className="border-r border-slate-100 px-3 py-3 sm:px-4">
                        <span
                          className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold capitalize ${workflowBadgeColors(row.workflow?.status)}`}
                        >
                          {workflowStatusLabel(row.workflow?.status)}
                        </span>
                      </td>

                      {/* Actions */}
                      <td className="px-3 py-3 sm:px-4">
                        {row.workflow ? (
                          <div className="flex flex-wrap gap-1.5">
                            {allowed.map((action) => (
                              <button
                                className={`rounded-md px-2.5 py-1.5 text-[11px] font-semibold transition disabled:opacity-50 ${
                                  action === "terminate"
                                    ? "border border-rose-200 bg-rose-50 text-rose-700 hover:bg-rose-100"
                                    : action === "pass"
                                      ? "border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                                      : "border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                                }`}
                                disabled={Boolean(pendingAction)}
                                key={action}
                                onClick={() => openWorkflowAction(row, action)}
                                type="button"
                              >
                                {actionLabel(action)}
                              </button>
                            ))}
                            {allowed.length === 0 && (
                              <span className="text-[11px] text-slate-400">
                                No available actions
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-[11px] text-slate-400">No review</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* ---- Mobile Card View ---- */}
      <div className="space-y-0 sm:hidden">
        <Card className={`divide-y divide-gray-100 overflow-hidden rounded-lg border border-gray-100 p-0 ${cardShadow}`}>
          {filteredRows.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-slate-400">
              No probation records match the current filters.
            </div>
          ) : (
            filteredRows.map((row) => {
              const traffic = classifyProbationTrafficStatus(row.days_remaining);
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
                      <p className="mt-0.5 text-xs text-slate-600">{row.job_title}</p>
                    </div>
                    <span
                      className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-semibold ${colors.light} ${colors.text}`}
                    >
                      {traffic === "safe" ? "Safe" : traffic === "warning" ? "Warning" : "Critical"}
                    </span>
                  </div>

                  {/* Metadata pills */}
                  <div className="mt-2 flex flex-wrap gap-1">
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                      {row.hr_id}
                    </span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                      {row.line_name}
                    </span>
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
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
                  <div className="mt-2 flex justify-between text-[11px] text-slate-400">
                    <span>Hired {formatDate(row.hire_date)}</span>
                    <span>Ends {formatDate(row.probation_end_date)}</span>
                    <span>{row.days_remaining}d left</span>
                    <span>{progress}%</span>
                  </div>

                  {/* Review + actions */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`inline-flex items-center rounded-md px-2 py-0.5 text-[10px] font-semibold capitalize ${workflowBadgeColors(row.workflow?.status)}`}
                    >
                      {workflowStatusLabel(row.workflow?.status)}
                    </span>
                    {row.workflow && allowed.length > 0 && (
                      <>
                        {allowed.map((action) => (
                          <button
                            className={`rounded-md px-2 py-1 text-[10px] font-semibold transition disabled:opacity-50 ${
                              action === "terminate"
                                ? "border border-rose-200 bg-rose-50 text-rose-700"
                                : action === "pass"
                                  ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                                  : "border border-slate-200 bg-white text-slate-600"
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

      {/* ---- Workflow Action Form ---- */}
      {selectedAction && (
        <Card className={`rounded-lg border border-gray-100 p-4 sm:p-5 ${cardShadow}`}>
          <div className="mb-4">
            <h3 className="text-sm font-bold text-slate-800">
              {actionLabel(selectedAction.action)}: {selectedAction.row.full_name}
            </h3>
            <p className="mt-0.5 text-[11px] text-slate-400">
              {selectedAction.row.hr_id} | {workflowStatusLabel(selectedAction.row.workflow?.status)} | ends {formatDate(selectedAction.row.probation_end_date)}
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
                <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-rose-600">
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
              className={`rounded-md px-4 py-2 text-sm font-semibold text-white transition disabled:opacity-50 ${
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
              className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-50"
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
