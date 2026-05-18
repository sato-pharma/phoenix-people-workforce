"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Download,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
  X,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
  AdminSectionHeader,
  adminPanelClassName,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatDateOnly, parseDateOnly } from "@/lib/date-only";
import {
  calculateProbationProgress,
  classifyProbationTrafficStatus,
  summarizeProbationRiskRows,
} from "@/lib/lifecycle-risk/metrics";
import type { ProbationRow, ProbationWorkflowAction, TrafficStatus } from "@/lib/probation/types";
import { cn } from "@/lib/utils";

type Props = {
  capabilities?: ProbationTrackerCapabilities;
  initialData: ProbationRow[] | null;
  initialError: string | null;
  presentation?: "default" | "premium";
};

type ProbationTrackerCapabilities = {
  canCreate?: boolean;
  canExport?: boolean;
  canManageWorkflow?: boolean;
  canSubmitManagerFeedback?: boolean;
  viewerMode?: "employee" | "hr" | "manager";
};

type SelectedWorkflowAction = {
  action: ProbationWorkflowAction;
  row: ProbationRow;
};

type WorkflowActionForm = {
  confirmationChecked: boolean;
  decisionReason: string;
  managerFeedback: string;
  terminationHrId: string;
  workflowNote: string;
};

type SortKey =
  | "days-asc"
  | "days-desc"
  | "hire-asc"
  | "hire-desc"
  | "name-asc"
  | "name-desc";

const allValue = "__all__";

const selectClassName =
  "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

const adminTableHeaderClassName =
  "px-3 py-3 text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]";

const premiumPageClassName =
  "relative overflow-hidden rounded-[34px] border border-[#FED7AA]/80 bg-[radial-gradient(circle_at_10%_0%,rgba(249,115,22,0.13),transparent_34%),linear-gradient(135deg,#FFF7ED_0%,#F8FAFC_46%,#FFFFFF_100%)] p-4 shadow-[0_30px_110px_rgba(15,23,42,0.11)] sm:p-5";

const premiumPanelClassName =
  "rounded-[28px] border border-white/75 bg-white/94 shadow-[0_28px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5";

const premiumInputClassName =
  "h-11 rounded-2xl border-[#D8E0EA] bg-white/95 shadow-[0_14px_35px_rgba(15,23,42,0.06)] focus:border-[#FDBA74] focus:ring-[#F97316]/15";

function emptyActionForm(): WorkflowActionForm {
  return {
    confirmationChecked: false,
    decisionReason: "",
    managerFeedback: "",
    terminationHrId: "",
    workflowNote: "",
  };
}

function getTrafficStatus(daysRemaining: number): TrafficStatus {
  return classifyProbationTrafficStatus(daysRemaining);
}

function getProbationProgress(daysRemaining: number) {
  return calculateProbationProgress(daysRemaining);
}

function statusLabel(status: TrafficStatus) {
  if (status === "safe") {
    return "Safe";
  }

  if (status === "warning") {
    return "Warning";
  }

  return "Critical";
}

function workflowBadgeVariant(status: string | null | undefined) {
  if (status === "passed") return "success";
  if (status === "terminated") return "danger";
  if (status === "extended") return "warning";
  return "neutral";
}

function workflowLabel(status: string | null | undefined) {
  return status ? status.replace(/_/g, " ") : "not requested";
}

function actionLabel(action: ProbationWorkflowAction) {
  const labels: Record<ProbationWorkflowAction, string> = {
    manager_feedback: "Manager feedback",
    pass: "Pass",
    terminate: "Terminate",
  };

  return labels[action];
}

function isDestructiveAction(action: ProbationWorkflowAction) {
  return action === "terminate";
}

function formatDate(value: string) {
  return formatDateOnly(value, "en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function uniqueOptions(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

function SelectFilter({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  value: string;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
        {label}
      </span>
      <select
        className={selectClassName}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        <option value={allValue}>{label}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

function ZoneSelect({
  onChange,
  value,
}: {
  onChange: (value: TrafficStatus | "all") => void;
  value: TrafficStatus | "all";
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
        Zone
      </span>
      <select
        className={selectClassName}
        onChange={(event) => onChange(event.target.value as TrafficStatus | "all")}
        value={value}
      >
        <option value="all">All zones</option>
        <option value="safe">Safe</option>
        <option value="warning">Warning</option>
        <option value="critical">Critical</option>
      </select>
    </label>
  );
}

function SortSelect({
  onChange,
  value,
}: {
  onChange: (value: SortKey) => void;
  value: SortKey;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
        Sort
      </span>
      <select
        className={selectClassName}
        onChange={(event) => onChange(event.target.value as SortKey)}
        value={value}
      >
        <option value="days-asc">Days ascending</option>
        <option value="days-desc">Days descending</option>
        <option value="hire-asc">Hire date ascending</option>
        <option value="hire-desc">Hire date descending</option>
        <option value="name-asc">Name A-Z</option>
        <option value="name-desc">Name Z-A</option>
      </select>
    </label>
  );
}

export function ProbationTracker({
  capabilities = {},
  initialData,
  initialError,
  presentation = "default",
}: Props) {
  const isPremium = presentation === "premium";
  const canCreate = capabilities.canCreate ?? false;
  const canExport = capabilities.canExport ?? false;
  const canManageWorkflow = capabilities.canManageWorkflow ?? false;
  const canSubmitManagerFeedback = capabilities.canSubmitManagerFeedback ?? false;
  const panelClassName = isPremium ? premiumPanelClassName : adminPanelClassName;
  const inputClassName = isPremium ? premiumInputClassName : "h-10 bg-white";
  const [areaFilter, setAreaFilter] = useState(allValue);
  const [jobFilter, setJobFilter] = useState(allValue);
  const [lineFilter, setLineFilter] = useState(allValue);
  const [query, setQuery] = useState(() => {
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("employeeHrId") ?? "";
  });
  const [sortBy, setSortBy] = useState<SortKey>("days-asc");
  const [trafficFilter, setTrafficFilter] = useState<TrafficStatus | "all">("all");
  const [employmentFilter, setEmploymentFilter] = useState<string>(allValue);
  const [rows, setRows] = useState<ProbationRow[]>(initialData ?? []);
  const [selectedAction, setSelectedAction] = useState<SelectedWorkflowAction | null>(null);
  const [actionForm, setActionForm] = useState<WorkflowActionForm>(() => emptyActionForm());
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  const filterOptions = useMemo(
    () => ({
      areas: uniqueOptions(rows.map((row) => row.area_name)),
      jobs: uniqueOptions(rows.map((row) => row.job_title)),
      lines: uniqueOptions(rows.map((row) => row.line_name)),
      employmentStatuses: uniqueOptions(rows.map((row) => row.employment_status ?? "")),
    }),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const search = query.trim().toLowerCase();

    return rows
      .filter((row) => {
        const searchable = [row.full_name, row.hr_id, row.crm_id].join(" ").toLowerCase();
        const traffic = getTrafficStatus(row.days_remaining);

        return (
          (!search || searchable.includes(search)) &&
          (lineFilter === allValue || row.line_name === lineFilter) &&
          (areaFilter === allValue || row.area_name === areaFilter) &&
          (jobFilter === allValue || row.job_title === jobFilter) &&
          (employmentFilter === allValue || row.employment_status === employmentFilter) &&
          (trafficFilter === "all" || traffic === trafficFilter)
        );
      })
      .sort((left, right) => {
        if (sortBy === "days-desc") {
          return right.days_remaining - left.days_remaining;
        }

        if (sortBy === "hire-asc") {
          return (parseDateOnly(left.hire_date)?.getTime() ?? 0) - (parseDateOnly(right.hire_date)?.getTime() ?? 0);
        }

        if (sortBy === "hire-desc") {
          return (parseDateOnly(right.hire_date)?.getTime() ?? 0) - (parseDateOnly(left.hire_date)?.getTime() ?? 0);
        }

        if (sortBy === "name-asc") {
          return left.full_name.localeCompare(right.full_name);
        }

        if (sortBy === "name-desc") {
          return right.full_name.localeCompare(left.full_name);
        }

        return left.days_remaining - right.days_remaining;
      });
  }, [areaFilter, employmentFilter, jobFilter, lineFilter, query, rows, sortBy, trafficFilter]);

  const summary = useMemo(
    () => summarizeProbationRiskRows(filteredRows.map((row) => ({
      daysRemaining: row.days_remaining,
      employeeHrId: row.hr_id,
      employeeName: row.full_name,
      hireDate: row.hire_date,
      probationEndDate: row.probation_end_date,
      workflowDecision: row.workflow?.decision ?? null,
    }))),
    [filteredRows],
  );

  const feedbackReportRows = useMemo(
    () => filteredRows.map((row) => {
      const probationDay = Math.max(0, Math.min(90, 90 - Math.max(0, row.days_remaining)));
      return {
        ...row,
        feedbackStatus: row.workflow?.managerFeedback ? "Submitted" : "Pending",
        probationDayStatus: row.workflow?.decision
          ? row.workflow.decision
          : `Day ${probationDay} / ${row.days_remaining} days remaining`,
      };
    }),
    [filteredRows],
  );

  const hasActiveFilters =
    areaFilter !== allValue ||
    jobFilter !== allValue ||
    lineFilter !== allValue ||
    query.length > 0 ||
    sortBy !== "days-asc" ||
    trafficFilter !== "all" ||
    employmentFilter !== allValue;

  const activeFilterCount = [
    areaFilter !== allValue ? areaFilter : "",
    jobFilter !== allValue ? jobFilter : "",
    lineFilter !== allValue ? lineFilter : "",
    query ? query : "",
    sortBy !== "days-asc" ? sortBy : "",
    trafficFilter !== "all" ? trafficFilter : "",
    employmentFilter !== allValue ? employmentFilter : "",
  ].filter(Boolean).length;

  function resetFilters() {
    setAreaFilter(allValue);
    setJobFilter(allValue);
    setLineFilter(allValue);
    setEmploymentFilter(allValue);
    setQuery("");
    setSortBy("days-asc");
    setTrafficFilter("all");
  }

  async function createEvaluation(row: ProbationRow) {
    if (!canCreate) {
      setMessage({ tone: "danger", text: "Your role cannot create probation evaluations." });
      return;
    }

    setPendingAction(`create:${row.hr_id}`);
    setMessage(null);
    try {
      const response = await fetch("/api/probation", {
        body: JSON.stringify({
          employeeHrId: row.hr_id,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.error ?? "Unable to create probation evaluation.");
      setRows(payload.rows);
      setMessage({ tone: "success", text: "Probation review started." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Unable to create probation evaluation." });
    } finally {
      setPendingAction(null);
    }
  }

  function updateActionForm(field: keyof WorkflowActionForm, value: string | boolean) {
    setActionForm((current) => ({ ...current, [field]: value }));
  }

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
    const workflow = selectedAction.row.workflow;
    if (action === "terminate" && actionForm.terminationHrId.trim().toUpperCase() !== row.hr_id.toUpperCase()) {
      setMessage({ tone: "danger", text: "Type the employee HR ID before termination." });
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
      if (!response.ok || !payload.success) throw new Error(payload.error ?? "Probation action failed.");
      setRows(payload.rows);
      setSelectedAction(null);
      setActionForm(emptyActionForm());
      setMessage({ tone: "success", text: "Probation review updated." });
    } catch (error) {
      setMessage({ tone: "danger", text: error instanceof Error ? error.message : "Probation action failed." });
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <div className={isPremium ? premiumPageClassName : "space-y-6"}>
      {isPremium ? (
        <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#F97316]/45 to-transparent" />
      ) : null}
      <div className="relative space-y-6">
      <AdminPageHero
        actions={
          <div className="flex w-full flex-wrap gap-2 sm:w-auto">
            <Button
              className="h-11 gap-2 rounded-2xl"
              disabled={!hasActiveFilters}
              onClick={resetFilters}
              variant="secondary"
            >
              <RefreshCw className="h-4 w-4" />
              Reset Filters
            </Button>
            {canExport ? (
              <>
                <a
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-[#D7E0EA] bg-white/95 px-4 py-2 text-xs font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
                  href="/api/exports?report=probation&format=pdf"
                >
                  <Download className="h-4 w-4 text-[#EA580C]" />
                  Export PDF
                </a>
                <a
                  className="inline-flex h-11 items-center justify-center gap-2 rounded-2xl border border-[#D7E0EA] bg-white/95 px-4 py-2 text-xs font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] transition hover:border-[#FDBA74] hover:bg-[#FFF7ED]"
                  href="/api/exports?report=probation&format=xlsx"
                >
                  <Download className="h-4 w-4 text-[#EA580C]" />
                  Export Excel
                </a>
              </>
            ) : null}
          </div>
        }
        badges={(
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Employees in probation: {summary.total}</AdminInsightChip>
            <AdminInsightChip tone="orange">
              {summary.total > 0 ? `${((summary.critical / summary.total) * 100).toFixed(0)}% critical` : "0% critical"}
            </AdminInsightChip>
            <AdminInsightChip tone="slate">
              {summary.warning} warning, {summary.safe} safe
            </AdminInsightChip>
          </div>
        )}
        description="Track employees inside the 90-day probation window and prioritize deadlines by risk zone before deadlines become people-risk."
        eyebrow="People Operations"
        icon={<Shield className="h-3.5 w-3.5" />}
        title="Probation Tracker"
      />

      {initialError ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-danger" />
          <div>
            <h2 className="text-base font-semibold text-text">Probation data unavailable</h2>
            <p className="mt-1 text-sm text-text-secondary">{initialError}</p>
          </div>
        </AdminCallout>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <AdminStatCard
          description="Matching current filters"
          icon={<Shield className="h-5 w-5" />}
          label="Total in Probation"
          value={summary.total}
        />
        <AdminStatCard
          description="More than 60 days remaining"
          icon={<ShieldCheck className="h-5 w-5" />}
          label="Safe Zone"
          value={summary.safe}
        />
        <AdminStatCard
          description="30 to 60 days remaining"
          icon={<ShieldAlert className="h-5 w-5" />}
          label="Warning Zone"
          value={summary.warning}
        />
        <AdminStatCard
          description="Less than 30 days remaining"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Critical Zone"
          value={summary.critical}
        />
      </div>

      {message ? (
        <AdminCallout tone={message.tone}>
          {message.tone === "success" ? <CheckCircle2 className="mt-0.5 h-4 w-4" /> : <AlertTriangle className="mt-0.5 h-4 w-4" />}
          <div>
            <h2 className="text-sm font-semibold">{message.tone === "success" ? "Probation update" : "Probation action failed"}</h2>
            <p className="mt-1 text-sm">{message.text}</p>
          </div>
        </AdminCallout>
      ) : null}

      <AdminTableShell
        action={
          <Button
            className="h-11 gap-2 rounded-2xl"
            disabled={!hasActiveFilters}
            onClick={resetFilters}
            variant="secondary"
          >
            <X className="h-4 w-4" />
            {activeFilterCount > 0 ? `Clear (${activeFilterCount})` : "Clear"}
          </Button>
        }
        description="Use line, area, role, employment status, risk zone, and sort to focus on probation windows."
        title="Probation Filters"
      >
        <div className="grid gap-3 p-4 sm:p-5 xl:grid-cols-[1.5fr_repeat(4,minmax(0,1fr))_auto]">
          <label className="relative block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Search
            </span>
            <Search className="pointer-events-none absolute left-3 top-10 h-4 w-4 text-text-secondary" />
            <Input
              className="h-11 rounded-2xl border-[#D8E0EA] bg-white/95 pl-9 shadow-[0_14px_35px_rgba(15,23,42,0.06)]"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search name, HR ID, CRM ID"
              value={query}
            />
          </label>
          <SelectFilter
            label="All lines"
            onChange={setLineFilter}
            options={filterOptions.lines}
            value={lineFilter}
          />
          <SelectFilter
            label="All areas"
            onChange={setAreaFilter}
            options={filterOptions.areas}
            value={areaFilter}
          />
          <SelectFilter
            label="All job titles"
            onChange={setJobFilter}
            options={filterOptions.jobs}
            value={jobFilter}
          />
          <SelectFilter
            label="All statuses"
            onChange={setEmploymentFilter}
            options={filterOptions.employmentStatuses}
            value={employmentFilter}
          />
          <ZoneSelect onChange={setTrafficFilter} value={trafficFilter} />
          <SortSelect onChange={setSortBy} value={sortBy} />
        </div>
      </AdminTableShell>

      {canManageWorkflow ? (
        <Card className={`${panelClassName} overflow-hidden p-0`}>
          <AdminSectionHeader
            action={<Badge variant="neutral">{feedbackReportRows.filter((row) => row.feedbackStatus === "Pending").length} pending</Badge>}
            description="HR/Admin view of manager feedback status during the fixed 90-day probation period."
            title="Managers Feedback in Probation Period"
          />
          <div className="overflow-x-auto bg-white/80">
            <table className="w-full min-w-[1280px] text-left text-sm">
              <thead className="bg-[#FFF7ED]/80 text-xs uppercase tracking-[0.12em] text-text-secondary">
                <tr className="border-b border-[#FED7AA]">
                  {[
                    "Employee HR ID",
                    "Employee Name",
                    "Hiring Date",
                    "Probation Day / Status",
                    "Direct Manager",
                    "Manager of Manager",
                    "Feedback By",
                    "Feedback Date",
                    "Feedback Text",
                    "Recommendation",
                    "Pending Status",
                    "Line / Area / Team",
                  ].map((column) => (
                    <th className={adminTableHeaderClassName} key={column}>
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E2E8F0]">
                {feedbackReportRows.length === 0 ? (
                  <tr>
                    <td className="px-4 py-10 text-center text-sm text-text-secondary" colSpan={12}>
                      No probation feedback records match the current filters.
                    </td>
                  </tr>
                ) : (
                  feedbackReportRows.map((row) => (
                    <tr className="align-top transition-colors hover:bg-[#FFF7ED]/55" key={`feedback:${row.hr_id}`}>
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">{row.hr_id}</td>
                      <td className="px-3 py-4 font-semibold text-text">{row.full_name}</td>
                      <td className="px-3 py-4 text-text-secondary">{formatDate(row.hire_date)}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.probationDayStatus}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.manager_name ?? row.manager_hr_id ?? "-"}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.manager_manager_name ?? row.manager_manager_hr_id ?? "-"}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.workflow?.managerReviewedBy ?? "-"}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.workflow?.managerReviewedAt ? formatDate(row.workflow.managerReviewedAt) : "-"}</td>
                      <td className="max-w-[280px] px-3 py-4 text-text-secondary">{row.workflow?.managerFeedback ?? "-"}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.workflow?.decision ?? row.workflow?.hrRecommendation ?? "-"}</td>
                      <td className="px-3 py-4">
                        <Badge variant={row.feedbackStatus === "Pending" ? "warning" : "success"}>{row.feedbackStatus}</Badge>
                      </td>
                      <td className="px-3 py-4 text-text-secondary">
                        <p>{row.line_name}</p>
                        <p className="mt-1">{row.area_name}</p>
                        <p className="mt-1">{row.team_name ?? "-"}</p>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Card>
      ) : null}

      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          action={
            <div className="flex flex-wrap gap-2">
              <Badge variant="warning">{summary.warning} warning</Badge>
              <Badge variant="danger">{summary.critical} critical</Badge>
            </div>
          }
          description={`Showing ${filteredRows.length} of ${rows.length} employees in the active probation window.`}
          title="Current Probation Employees"
        />
        <div className="overflow-x-auto bg-white/80">
          <table className="w-full min-w-[1120px] text-left text-sm">
            <thead className="sticky top-0 bg-[#FFF7ED]/80 backdrop-blur">
              <tr className="border-b border-[#FED7AA] text-xs uppercase tracking-[0.12em] text-text-secondary">
                {[
                  "HR ID",
                  "CRM ID",
                  "Full Name",
                  "Job Title",
                  "Line",
                  "Area",
                  "Hire Date",
                  "End Date",
                  "Days",
                  "Progress",
                  "Status",
                  "Probation Review",
                  "Actions",
                ].map((column) => (
                  <th className={adminTableHeaderClassName} key={column}>
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filteredRows.length === 0 ? (
                <tr>
                  <td className="px-4 py-12 text-center text-sm text-text-secondary" colSpan={13}>
                    No probation records match the current filters.
                  </td>
                </tr>
              ) : (
                filteredRows.map((row) => {
                  const traffic = getTrafficStatus(row.days_remaining);
                  const progress = getProbationProgress(row.days_remaining);

                  return (
                    <tr className="transition-colors hover:bg-[#FFF7ED]/55" key={row.hr_id}>
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">{row.hr_id || "-"}</td>
                      <td className="px-3 py-4 font-mono text-xs text-text-secondary">{row.crm_id || "-"}</td>
                      <td className="px-3 py-4 font-semibold text-text">{row.full_name}</td>
                      <td className="max-w-[220px] truncate px-3 py-4 text-text-secondary">{row.job_title}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.line_name}</td>
                      <td className="px-3 py-4 text-text-secondary">{row.area_name}</td>
                      <td className="px-3 py-4 text-text-secondary">{formatDate(row.hire_date)}</td>
                      <td className="px-3 py-4 text-text-secondary">{formatDate(row.probation_end_date)}</td>
                      <td className="px-3 py-4 font-semibold text-text">{row.days_remaining}</td>
                      <td className="min-w-[150px] px-3 py-4">
                        <div className="space-y-1">
                          <div className="h-2 overflow-hidden rounded-full bg-slate-100">
                            <div
                              className={cn(
                                "h-full rounded-full transition-all",
                                traffic === "safe"
                                  ? "bg-success"
                                  : traffic === "warning"
                                    ? "bg-warning"
                                    : "bg-danger",
                              )}
                              style={{ width: `${progress}%` }}
                            />
                          </div>
                          <p className="text-[11px] leading-tight text-text-secondary">{progress}% complete</p>
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        <Badge variant={traffic === "safe" ? "success" : traffic === "warning" ? "warning" : "danger"}>
                          {statusLabel(traffic)}
                        </Badge>
                      </td>
                      <td className="px-3 py-4">
                        <div className="space-y-2">
                          <Badge variant={workflowBadgeVariant(row.workflow?.status)}>{workflowLabel(row.workflow?.status)}</Badge>
                          {row.workflow?.decision ? (
                            <div className="text-xs font-semibold text-[#0F172A]">Decision: {row.workflow.decision}</div>
                          ) : null}
                        </div>
                      </td>
                      <td className="px-3 py-4">
                        {row.workflow ? (
                          <div className="flex min-w-[260px] flex-wrap gap-2">
                            {(row.workflow.allowedActions ?? row.allowedActions ?? [])
                              .filter((action) => canSubmitManagerFeedback || action !== "manager_feedback")
                              .map((action) => (
                                <Button
                                  className="h-9 rounded-xl px-2.5 text-xs"
                                  disabled={Boolean(pendingAction)}
                                  key={action}
                                  onClick={() => openWorkflowAction(row, action)}
                                  variant={isDestructiveAction(action) ? "destructive" : "secondary"}
                                >
                                  {action === "manager_feedback" ? <UserCheck className="mr-1 h-3.5 w-3.5" /> : null}
                                  {action === "terminate" ? <XCircle className="mr-1 h-3.5 w-3.5" /> : null}
                                  {actionLabel(action)}
                                </Button>
                              ))}
                            {(row.workflow.allowedActions ?? row.allowedActions ?? []).length === 0 ? (
                              <span className="text-xs font-semibold text-[#64748B]">No available actions</span>
                            ) : null}
                          </div>
                        ) : (
                          <Button className="h-9 rounded-xl px-2.5 text-xs" disabled={!canCreate || Boolean(pendingAction)} onClick={() => createEvaluation(row)} variant="secondary">
                            Start review
                          </Button>
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

      {selectedAction ? (
        <AdminTableShell
          title={`${actionLabel(selectedAction.action)}: ${selectedAction.row.full_name}`}
          description={`${selectedAction.row.hr_id} | ${workflowLabel(selectedAction.row.workflow?.status)} | ends ${formatDate(selectedAction.row.probation_end_date)}`}
          action={
            <div className="flex flex-wrap gap-2">
              <Button className="h-11 rounded-2xl" onClick={() => setSelectedAction(null)} variant="secondary">
                Close
              </Button>
              <Button
                className="h-11 rounded-2xl"
                disabled={Boolean(pendingAction)}
                onClick={runWorkflow}
                variant={isDestructiveAction(selectedAction.action) ? "destructive" : "default"}
              >
                {pendingAction ? "Submitting..." : actionLabel(selectedAction.action)}
              </Button>
            </div>
          }
        >
          <div className="grid gap-3 p-4 lg:grid-cols-3">
            {selectedAction.action === "manager_feedback" ? (
              <label className="block lg:col-span-3">
                <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Manager Feedback</span>
                <Input className={inputClassName} onChange={(event) => updateActionForm("managerFeedback", event.target.value)} placeholder="Manager evaluation feedback" value={actionForm.managerFeedback} />
              </label>
            ) : null}
            {selectedAction.action === "pass" || selectedAction.action === "terminate" ? (
              <label className="block lg:col-span-2">
                <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">HR Note</span>
                <Input className={inputClassName} onChange={(event) => updateActionForm("decisionReason", event.target.value)} placeholder={selectedAction.action === "terminate" ? "Termination reason" : "Optional HR note"} value={actionForm.decisionReason} />
              </label>
            ) : null}
            {selectedAction.action === "terminate" ? (
              <label className="block lg:col-span-3">
                <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-danger">Type HR ID to confirm termination</span>
                <Input className={inputClassName} onChange={(event) => updateActionForm("terminationHrId", event.target.value)} placeholder={selectedAction.row.hr_id} value={actionForm.terminationHrId} />
              </label>
            ) : null}
            <label className="block lg:col-span-3">
              <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">Review Note</span>
              <Input className={inputClassName} onChange={(event) => updateActionForm("workflowNote", event.target.value)} placeholder="Optional note for this row-specific action" value={actionForm.workflowNote} />
            </label>
          </div>
        </AdminTableShell>
      ) : null}
      </div>
    </div>
  );
}
