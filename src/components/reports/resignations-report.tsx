"use client";

import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Download,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  UserMinus,
  X,
} from "lucide-react";
import * as React from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminStatCard,
  AdminTableShell,
  AdminSectionHeader,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type {
  CreateResignationInput,
  PayrollResignationCandidateRecord,
  ResignationDashboardData,
  ResignationRecord,
  ResignationStatus,
  ResignationWorkflowAction,
} from "@/lib/resignations/types";
import { formatEmployeeDisplayName } from "@/lib/utils";

type Props = {
  initialData: ResignationDashboardData | null;
  initialError: string | null;
};

type SortKey =
  | "effective-asc"
  | "effective-desc"
  | "submitted-asc"
  | "submitted-desc"
  | "status-asc"
  | "status-desc"
  | "employee-asc"
  | "employee-desc";

type WorkflowQueueRow =
  | {
      key: string;
      kind: "resignation";
      record: ResignationRecord;
    }
  | {
      candidate: PayrollResignationCandidateRecord;
      key: string;
      kind: "payrollCandidate";
    };

const allValue = "__all__";
const statusOptions: Array<ResignationStatus> = [
  "submitted",
  "under_review",
  "approved",
  "rejected",
  "completed",
  "cancelled",
];

const adminSelectClassName =
  "h-11 w-full rounded-2xl border border-[#D8E0EA] bg-white/95 px-3 text-sm font-semibold text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15";

const adminTableHeaderClassName =
  "px-3 py-3 text-[10px] font-black uppercase tracking-[0.16em] text-[#64748B]";

const panelClassName =
  "rounded-[28px] border border-white/75 bg-white/94 shadow-[0_28px_90px_rgba(15,23,42,0.12)] ring-1 ring-slate-900/5";

const inputClassName =
  "h-11 rounded-2xl border-[#D8E0EA] bg-white/95 shadow-[0_14px_35px_rgba(15,23,42,0.06)] focus:border-[#FDBA74] focus:ring-[#F97316]/15";

function ResignationsPageShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-[34px] border border-[#FED7AA]/80 bg-[radial-gradient(circle_at_12%_0%,rgba(249,115,22,0.13),transparent_34%),linear-gradient(135deg,#FFF7ED_0%,#F8FAFC_44%,#FFFFFF_100%)] p-4 shadow-[0_30px_110px_rgba(15,23,42,0.11)] sm:p-5">
      <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-[#F97316]/45 to-transparent" />
      <div className="relative space-y-6">{children}</div>
    </div>
  );
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatPayoutMonth(month: number | null | undefined, year: number | null | undefined) {
  if (!month || !year) return "-";
  const date = new Date(year, month - 1, 1);
  if (Number.isNaN(date.getTime())) return `${month}/${year}`;
  return new Intl.DateTimeFormat("en", {
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatPayrollCandidateSystemId(id: string) {
  const normalized = id.replace(/[^a-z0-9]/gi, "").toUpperCase();
  return normalized ? `PRC-${normalized.slice(0, 8)}` : "PRC-PENDING";
}

function daysUntil(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.ceil((date.getTime() - today.getTime()) / 86400000);
}

function statusBadge(status: ResignationStatus) {
  switch (status) {
    case "submitted":
      return <Badge variant="warning">Submitted</Badge>;
    case "under_review":
      return <Badge variant="neutral">Under Review</Badge>;
    case "approved":
      return <Badge variant="success">Approved</Badge>;
    case "rejected":
      return <Badge variant="danger">Rejected</Badge>;
    case "completed":
      return <Badge variant="success">Completed</Badge>;
    case "cancelled":
      return <Badge variant="danger">Cancelled</Badge>;
    default:
      return <Badge variant="neutral">{status}</Badge>;
  }
}

function uniqueOptions(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter(Boolean) as string[])).sort((a, b) => a.localeCompare(b));
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
      <select className={adminSelectClassName} onChange={(event) => onChange(event.target.value)} value={value}>
        <option value={allValue}>{`All ${label}`}</option>
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
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
      <select className={adminSelectClassName} onChange={(event) => onChange(event.target.value as SortKey)} value={value}>
        <option value="effective-asc">Effective date asc</option>
        <option value="effective-desc">Effective date desc</option>
        <option value="submitted-asc">Submitted date asc</option>
        <option value="submitted-desc">Submitted date desc</option>
        <option value="employee-asc">Employee A-Z</option>
        <option value="employee-desc">Employee Z-A</option>
        <option value="status-asc">Status A-Z</option>
        <option value="status-desc">Status Z-A</option>
      </select>
    </label>
  );
}

function getDaysTone(value: number | null) {
  if (value === null) return "neutral";
  if (value <= 7) return "danger";
  if (value <= 30) return "warning";
  return "neutral";
}

const emptyForm: CreateResignationInput = {
  effectiveDate: "",
  employeeHrId: "",
  reason: "",
  submittedDate: new Date().toISOString().slice(0, 10),
  workflowNotes: "",
};

export function ResignationsReport({ initialData, initialError }: Props) {
  const [data, setData] = React.useState<ResignationDashboardData | null>(initialData);
  const [error, setError] = React.useState<string | null>(initialError);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [query, setQuery] = React.useState("");
  const [statusFilter, setStatusFilter] = React.useState<string>(allValue);
  const [lineFilter, setLineFilter] = React.useState<string>(allValue);
  const [sortBy, setSortBy] = React.useState<SortKey>("submitted-desc");
  const [form, setForm] = React.useState<CreateResignationInput>(emptyForm);
  const [isSaving, setIsSaving] = React.useState(false);
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [editingDates, setEditingDates] = React.useState<{
    effectiveDate: string;
    recordId: string;
    submittedDate: string;
  } | null>(null);

  const records = React.useMemo(() => data?.records ?? [], [data]);
  const payrollCandidates = React.useMemo(() => data?.payrollCandidates ?? [], [data]);
  const employees = React.useMemo(() => data?.employees ?? [], [data]);
  const lineOptions = React.useMemo(
    () => uniqueOptions([
      ...records.map((record) => record.lineName),
      ...payrollCandidates.map((candidate) => candidate.lineName),
    ]),
    [payrollCandidates, records],
  );

  const filteredRecords = React.useMemo(() => {
    const search = query.trim().toLowerCase();

    const sorted = records
      .filter((record) => {
        const searchable = [
          record.employeeHrId,
          record.employeeName,
          record.jobTitle,
          record.lineName,
          record.reason,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();

        return (
          (!search || searchable.includes(search)) &&
          (statusFilter === allValue || record.status === statusFilter) &&
          (lineFilter === allValue || record.lineName === lineFilter)
        );
      })
      .sort((left, right) => {
        if (sortBy === "employee-asc") return left.employeeName.localeCompare(right.employeeName);
        if (sortBy === "employee-desc") return right.employeeName.localeCompare(left.employeeName);
        if (sortBy === "status-asc") return left.status.localeCompare(right.status);
        if (sortBy === "status-desc") return right.status.localeCompare(left.status);
        if (sortBy === "effective-asc") return left.effectiveDate.localeCompare(right.effectiveDate);
        if (sortBy === "effective-desc") return right.effectiveDate.localeCompare(left.effectiveDate);
        if (sortBy === "submitted-asc") return left.submittedDate.localeCompare(right.submittedDate);
        return right.submittedDate.localeCompare(left.submittedDate);
      });

    return sorted;
  }, [lineFilter, query, records, sortBy, statusFilter]);

  const filteredPayrollCandidates = React.useMemo(() => {
    const search = query.trim().toLowerCase();

    return payrollCandidates.filter((candidate) => {
      const searchable = [
        candidate.hrId,
        candidate.employeeName,
        candidate.nameAr,
        candidate.jobTitle,
        candidate.lineName,
        candidate.areaName,
        candidate.sourceFileName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return (
        (!search || searchable.includes(search)) &&
        (lineFilter === allValue || candidate.lineName === lineFilter)
      );
    });
  }, [lineFilter, payrollCandidates, query]);

  const filteredWorkflowQueueRows = React.useMemo(() => {
    const rows: WorkflowQueueRow[] = [
      ...filteredRecords.map((record) => ({
        key: `resignation:${record.id}`,
        kind: "resignation" as const,
        record,
      })),
    ];

    if (statusFilter === allValue) {
      rows.push(
        ...filteredPayrollCandidates.map((candidate) => ({
          candidate,
          key: `payroll-candidate:${candidate.id}`,
          kind: "payrollCandidate" as const,
        })),
      );
    }

    return rows.sort((left, right) => {
      const leftEmployee = left.kind === "resignation" ? left.record.employeeName : left.candidate.employeeName;
      const rightEmployee = right.kind === "resignation" ? right.record.employeeName : right.candidate.employeeName;
      const leftStatus = left.kind === "resignation" ? left.record.status : "payroll_candidate";
      const rightStatus = right.kind === "resignation" ? right.record.status : "payroll_candidate";
      const leftEffective =
        left.kind === "resignation"
          ? left.record.effectiveDate
          : `${left.candidate.lastPayoutYear}-${String(left.candidate.lastPayoutMonth).padStart(2, "0")}-01`;
      const rightEffective =
        right.kind === "resignation"
          ? right.record.effectiveDate
          : `${right.candidate.lastPayoutYear}-${String(right.candidate.lastPayoutMonth).padStart(2, "0")}-01`;
      const leftSubmitted =
        left.kind === "resignation" ? left.record.submittedDate : left.candidate.lastSeenAt.slice(0, 10);
      const rightSubmitted =
        right.kind === "resignation" ? right.record.submittedDate : right.candidate.lastSeenAt.slice(0, 10);

      if (sortBy === "employee-asc") return leftEmployee.localeCompare(rightEmployee);
      if (sortBy === "employee-desc") return rightEmployee.localeCompare(leftEmployee);
      if (sortBy === "status-asc") return leftStatus.localeCompare(rightStatus);
      if (sortBy === "status-desc") return rightStatus.localeCompare(leftStatus);
      if (sortBy === "effective-asc") return leftEffective.localeCompare(rightEffective);
      if (sortBy === "effective-desc") return rightEffective.localeCompare(leftEffective);
      if (sortBy === "submitted-asc") return leftSubmitted.localeCompare(rightSubmitted);
      return rightSubmitted.localeCompare(leftSubmitted);
    });
  }, [filteredPayrollCandidates, filteredRecords, sortBy, statusFilter]);

  const filteredTerminatedRecords = React.useMemo(
    () => filteredRecords.filter((record) => String(record.employeeStatus ?? "").toLowerCase() === "terminated"),
    [filteredRecords],
  );

  const hasActiveFilters = Boolean(
    query ||
    statusFilter !== allValue ||
    lineFilter !== allValue ||
    sortBy !== "submitted-desc",
  );

  const activeFilterCount = [
    query,
    statusFilter !== allValue ? statusFilter : "",
    lineFilter !== allValue ? lineFilter : "",
    sortBy !== "submitted-desc" ? sortBy : "",
  ].filter(Boolean).length;

  const summary = data?.summary ?? {
    active: 0,
    approved: 0,
    completed: 0,
    payrollCandidates: 0,
    pending: 0,
    total: 0,
  };

  function clearFilters() {
    setQuery("");
    setStatusFilter(allValue);
    setLineFilter(allValue);
    setSortBy("submitted-desc");
  }

  async function loadDashboard() {
    setIsRefreshing(true);
    setError(null);

    try {
      const response = await fetch("/api/resignations", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "resignations_load_failed");
        return;
      }
      setData(payload);
      setNotice(null);
    } catch {
      setError("Unable to load resignations.");
    } finally {
      setIsRefreshing(false);
    }
  }

  function updateForm(key: keyof CreateResignationInput, value: string) {
    setForm((current) => ({ ...current, [key]: value }));
  }

  async function submitResignation() {
    setIsSaving(true);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/resignations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resignation: form }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "resignation_create_failed");
        return;
      }
      setData(payload);
      setForm(emptyForm);
      setNotice("Resignation workflow created.");
    } catch {
      setError("Unable to create resignation workflow.");
    } finally {
      setIsSaving(false);
    }
  }

  async function runAction(
    record: ResignationRecord,
    action: ResignationWorkflowAction,
    options?: { note?: string; rejectedReason?: string },
  ) {
    setBusyAction(`${record.id}:${action}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/resignations/${record.id}/workflow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          note: options?.note,
          rejectedReason: options?.rejectedReason,
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.error ?? "workflow action failed");
        return;
      }
      setData(payload.dashboard);
      setNotice(`Resignation moved to ${payload.data.status.replace(/_/g, " ")}.`);
    } catch {
      setError("Unable to update resignation workflow.");
    } finally {
      setBusyAction(null);
    }
  }

  function startDateEdit(record: ResignationRecord) {
    setEditingDates({
      effectiveDate: record.effectiveDate,
      recordId: record.id,
      submittedDate: record.submittedDate,
    });
    setError(null);
    setNotice(null);
  }

  function updateEditingDate(key: "effectiveDate" | "submittedDate", value: string) {
    setEditingDates((current) => current ? { ...current, [key]: value } : current);
  }

  async function saveDateEdit(record: ResignationRecord) {
    if (!editingDates || editingDates.recordId !== record.id) return;
    if (!editingDates.submittedDate || !editingDates.effectiveDate) {
      setError("Both resignation dates are required.");
      return;
    }

    setBusyAction(`${record.id}:dates`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/resignations/${encodeURIComponent(record.id)}/dates`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          dates: {
            effectiveDate: editingDates.effectiveDate,
            submittedDate: editingDates.submittedDate,
          },
        }),
      });
      const payload = await response.json();
      if (!response.ok) {
        setError(payload.message ?? payload.error ?? "resignation_dates_update_failed");
        return;
      }
      setData(payload.dashboard);
      setEditingDates(null);
      setNotice("Resignation dates updated.");
    } catch {
      setError("Unable to update resignation dates.");
    } finally {
      setBusyAction(null);
    }
  }

  function exportCsv() {
    const headers = [
      "record_type",
      "employee_hr_id",
      "employee_name",
      "line_name",
      "area_name",
      "job_title",
      "hire_date",
      "last_payout_month",
      "submitted_date",
      "effective_date",
      "days_left",
      "status",
      "reason",
      "rejected_reason",
      "created_by",
      "updated_at",
    ];

    const toCsvCell = (value: string | number | null | undefined) =>
      `"${String(value ?? "").replace(/"/g, '""')}"`;

    const resignationRows = filteredRecords.map((record) => {
      const daysLeft = daysUntil(record.effectiveDate);
      return [
        "resignation",
        record.employeeHrId,
        record.employeeName,
        record.lineName ?? "-",
        "-",
        record.jobTitle ?? "-",
        "-",
        "-",
        record.submittedDate,
        record.effectiveDate,
        daysLeft === null ? "-" : `${daysLeft}`,
        record.status,
        record.reason ?? "",
        record.rejectedReason ?? "",
        record.createdBy ?? "-",
        record.updatedAt.slice(0, 10),
      ].map(toCsvCell);
    });
    const candidateRows = filteredPayrollCandidates.map((candidate) => [
      "payroll_missing_employee",
      candidate.hrId,
      candidate.employeeName,
      candidate.lineName ?? "-",
      candidate.areaName ?? "-",
      candidate.jobTitle ?? "-",
      candidate.hireDate ?? "-",
      formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear),
      "-",
      "-",
      "-",
      "payroll_candidate",
      `Missing from employee directory. Source row ${candidate.sourceRow ?? "-"}`,
      "",
      candidate.createdBy ?? "-",
      candidate.updatedAt.slice(0, 10),
    ].map(toCsvCell));
    const rows = [...candidateRows, ...resignationRows];

    const blob = new Blob([`${headers.map(toCsvCell).join(",")}\n${rows.map((row) => row.join(",")).join("\n")}`], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "resignations.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <ResignationsPageShell>
      <AdminPageHero
        actions={
          <div className="flex flex-wrap gap-2">
            <Button
              className="h-11 gap-2 rounded-2xl"
              disabled={isRefreshing || !data}
              onClick={exportCsv}
              variant="secondary"
            >
              <Download className="h-4 w-4" />
              Export CSV
            </Button>
            <Button
              className="h-11 gap-2 rounded-2xl"
              disabled={isRefreshing}
              onClick={() => void loadDashboard()}
              variant="secondary"
            >
              {isRefreshing ? <RefreshCw className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Refresh
            </Button>
          </div>
        }
        description="Track submitted resignations, review workflow progress, and close cases through controlled admin actions."
        eyebrow="People Operations"
        icon={<UserMinus className="h-3.5 w-3.5" />}
        title="Resignations Report"
        badges={
          <div className="flex flex-wrap gap-2">
            <AdminInsightChip>Total {summary.total}</AdminInsightChip>
            <AdminInsightChip tone="orange">{summary.pending} pending</AdminInsightChip>
            <AdminInsightChip tone="slate">{summary.payrollCandidates} payroll candidates</AdminInsightChip>
            <AdminInsightChip tone="slate">{summary.active} active</AdminInsightChip>
            <AdminInsightChip>{summary.completed} completed</AdminInsightChip>
          </div>
        }
      />

      {error ? (
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-5 w-5 text-[#B91C1C]" />
          <div>
            <h2 className="text-sm font-bold text-[#B91C1C]">Resignations unavailable</h2>
            <p className="mt-1 text-sm text-[#991B1B]">{error}</p>
          </div>
        </AdminCallout>
      ) : null}

      {notice ? (
        <AdminCallout tone="success">
          <CheckCircle2 className="mt-0.5 h-5 w-5 text-[#166534]" />
          <div>
            <h2 className="text-sm font-bold text-[#166534]">Workflow update</h2>
            <p className="mt-1 text-sm text-[#166534]">{notice}</p>
          </div>
        </AdminCallout>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-6">
        <AdminStatCard
          description="All resignation records in dashboard"
          icon={<UserMinus className="h-5 w-5" />}
          label="Total"
          value={summary.total}
        />
        <AdminStatCard
          description="Awaiting review or action"
          icon={<RefreshCw className="h-5 w-5" />}
          label="Pending"
          value={summary.pending}
        />
        <AdminStatCard
          description="Submitted, under review, or approved"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Active"
          value={summary.active}
        />
        <AdminStatCard
          description="Workflow approved and waiting"
          icon={<CheckCircle2 className="h-5 w-5" />}
          label="Approved"
          value={summary.approved}
        />
        <AdminStatCard
          description="Payroll rows missing from employee directory"
          icon={<AlertTriangle className="h-5 w-5" />}
          label="Payroll Candidates"
          value={summary.payrollCandidates}
        />
        <AdminStatCard
          description="Closed after finalization"
          icon={<X className="h-5 w-5" />}
          label="Completed"
          value={summary.completed}
        />
      </div>

      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          action={<Badge variant="danger">{filteredTerminatedRecords.length} terminated</Badge>}
          description="Employees terminated through probation or other lifecycle paths appear here without creating a separate termination system."
          title="Terminated Employees"
        />
        <div className="overflow-x-auto bg-white/80">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[#FFF7ED]/80 text-xs uppercase tracking-[0.12em] text-[#64748B] backdrop-blur">
              <tr className="border-b border-[#FED7AA]">
                <th className={adminTableHeaderClassName}>Employee</th>
                <th className={adminTableHeaderClassName}>Line</th>
                <th className={adminTableHeaderClassName}>Effective</th>
                <th className={adminTableHeaderClassName}>Reason / Reference</th>
                <th className={adminTableHeaderClassName}>Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filteredTerminatedRecords.length === 0 ? (
                <tr>
                  <td className="px-3 py-10 text-center text-sm text-[#64748B]" colSpan={5}>
                    No terminated employees match the current filters.
                  </td>
                </tr>
              ) : (
                filteredTerminatedRecords.map((record) => (
                  <tr className="align-top transition-colors hover:bg-[#FFF7ED]/55" key={`terminated:${record.id}`}>
                    <td className="px-3 py-4">
                      <p className="font-medium text-[#0F172A]">{formatEmployeeDisplayName(record.employeeName)}</p>
                      <p className="mt-1 font-mono text-xs text-[#64748B]">{record.employeeHrId}</p>
                      <p className="mt-1 text-xs text-[#64748B]">{record.jobTitle ?? "-"}</p>
                    </td>
                    <td className="px-3 py-4 text-[#64748B]">{record.lineName ?? "-"}</td>
                    <td className="px-3 py-4 text-[#64748B]">{formatDate(record.effectiveDate)}</td>
                    <td className="max-w-[360px] px-3 py-4 text-[#64748B]">
                      <p>{record.reason ?? "-"}</p>
                      {record.workflowNotes ? <p className="mt-2 text-xs">{record.workflowNotes}</p> : null}
                    </td>
                    <td className="px-3 py-4">{statusBadge(record.status)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <AdminTableShell title="Create Resignation Workflow" description="Submit a new resignation record and initialize workflow tracking.">
        <div className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-5">
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Employee
            </span>
            <select
              className={adminSelectClassName}
              onChange={(event) => updateForm("employeeHrId", event.target.value)}
              value={form.employeeHrId}
            >
              <option value="">Select employee</option>
              {employees.map((employee, index) => (
                <option key={`${employee.value}:${employee.label}:${index}`} value={employee.value}>
                  {employee.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Submitted Date
            </span>
            <Input
              className={inputClassName}
              onChange={(event) => updateForm("submittedDate", event.target.value)}
              type="date"
              value={form.submittedDate}
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Effective Date
            </span>
            <Input
              className={inputClassName}
              onChange={(event) => updateForm("effectiveDate", event.target.value)}
              type="date"
              value={form.effectiveDate}
            />
          </label>
          <label className="block xl:col-span-2">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Reason
            </span>
            <Input
              className={inputClassName}
              onChange={(event) => updateForm("reason", event.target.value)}
              placeholder="Personal, career move, misconduct, redundancy..."
              value={form.reason ?? ""}
            />
          </label>
          <label className="block md:col-span-2 xl:col-span-5">
            <span className="mb-1.5 block text-[11px] font-black uppercase tracking-[0.14em] text-[#64748B]">
              Workflow Note
            </span>
            <textarea
              className="min-h-24 w-full rounded-2xl border border-[#D8E0EA] bg-white/95 px-3 py-2 text-sm text-[#0F172A] shadow-[0_14px_35px_rgba(15,23,42,0.06)] outline-none transition focus:border-[#FDBA74] focus:ring-2 focus:ring-[#F97316]/15"
              onChange={(event) => updateForm("workflowNotes", event.target.value)}
              placeholder="Optional admin context for the initial submission."
              value={form.workflowNotes ?? ""}
            />
          </label>
          <div className="xl:col-span-5">
            <Button className="h-11 w-full gap-2 rounded-2xl" disabled={isSaving} onClick={() => void submitResignation()}>
              <Plus className="h-4 w-4" />
              Create Workflow
            </Button>
          </div>
        </div>
      </AdminTableShell>

      <AdminTableShell
        action={
            <Button
            className="h-11 gap-2 rounded-2xl"
            disabled={!hasActiveFilters}
            onClick={clearFilters}
            variant="secondary"
          >
            <X className="h-4 w-4" />
            Clear {activeFilterCount > 0 ? `(${activeFilterCount})` : ""}
          </Button>
        }
        description="Use search, status, and line filters to narrow the queue before acting on each resignation."
        title="Workflow Filters"
      >
        <div className="grid gap-3 p-4 xl:grid-cols-4">
          <label className="relative block">
            <span className="sr-only">Search resignations</span>
            <Search className="pointer-events-none absolute left-3 top-10 h-4 w-4 text-[#64748B]" />
            <Input
              className="h-11 rounded-2xl border-[#D8E0EA] bg-white/95 pl-9 shadow-[0_14px_35px_rgba(15,23,42,0.06)]"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search employee, HR ID, reason..."
              value={query}
            />
          </label>
          <SelectFilter
            label="Status"
            onChange={setStatusFilter}
            options={statusOptions}
            value={statusFilter}
          />
          <SelectFilter
            label="Line"
            onChange={setLineFilter}
            options={lineOptions}
            value={lineFilter}
          />
          <SortSelect onChange={setSortBy} value={sortBy} />
        </div>
      </AdminTableShell>

      <Card className={`${panelClassName} overflow-hidden p-0`}>
        <AdminSectionHeader
          action={
            <div className="flex flex-wrap gap-2">
              <Badge className="rounded-full border border-[#D8E0EA] px-3 py-2 text-xs" variant="neutral">
                {filteredWorkflowQueueRows.length} visible
              </Badge>
              <Badge className="rounded-full border border-[#D8E0EA] px-3 py-2 text-xs" variant="neutral">
                {statusFilter === allValue ? filteredPayrollCandidates.length : 0} payroll candidates
              </Badge>
              <Badge className="rounded-full border border-[#D8E0EA] px-3 py-2 text-xs" variant="warning">
                {statusFilter !== allValue ? statusFilter : "all"} filter
              </Badge>
            </div>
          }
          description={`Showing ${filteredRecords.length} workflow records and ${
            statusFilter === allValue ? filteredPayrollCandidates.length : 0
          } payroll upload candidates in one queue.`}
          title="Workflow Queue"
        />

        <div className="overflow-x-auto bg-white/80">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-[#FFF7ED]/80 text-xs uppercase tracking-[0.12em] text-[#64748B] backdrop-blur">
              <tr className="border-b border-[#FED7AA]">
                <th className={adminTableHeaderClassName}>Employee</th>
                <th className={adminTableHeaderClassName}>Line</th>
                <th className={adminTableHeaderClassName}>Submitted</th>
                <th className={adminTableHeaderClassName}>Effective</th>
                <th className={adminTableHeaderClassName}>Days Left</th>
                <th className={adminTableHeaderClassName}>Status</th>
                <th className={adminTableHeaderClassName}>Reason</th>
                <th className={adminTableHeaderClassName}>Audit</th>
                <th className={adminTableHeaderClassName}>Workflow</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#E2E8F0]">
              {filteredWorkflowQueueRows.length === 0 ? (
                <tr>
                  <td className="px-3 py-12 text-center text-sm text-[#64748B]" colSpan={9}>
                    No resignation or payroll candidate rows match the current filters.
                  </td>
                </tr>
              ) : (
                filteredWorkflowQueueRows.map((row) => {
                  if (row.kind === "payrollCandidate") {
                    const { candidate } = row;
                    const candidateSystemId = formatPayrollCandidateSystemId(candidate.id);

                    return (
                      <tr className="align-top bg-[#FFF7ED]/30 transition-colors hover:bg-[#FFF7ED]/65" key={row.key}>
                        <td className="px-3 py-4">
                          <p className="font-medium text-[#0F172A]">
                            {formatEmployeeDisplayName(candidate.employeeName)}
                          </p>
                          <p className="mt-1 font-mono text-xs text-[#64748B]">{candidate.hrId || "No HR ID"}</p>
                          <p className="mt-1 text-xs text-[#64748B]">{candidate.jobTitle ?? "-"}</p>
                        </td>
                        <td className="px-3 py-4 text-[#64748B]">{candidate.lineName ?? "-"}</td>
                        <td className="px-3 py-4 text-[#64748B]">
                          <p>{formatDate(candidate.lastSeenAt.slice(0, 10))}</p>
                          <p className="mt-1 text-xs">Last seen in payroll</p>
                        </td>
                        <td className="px-3 py-4 text-[#64748B]">
                          <p>{formatPayoutMonth(candidate.lastPayoutMonth, candidate.lastPayoutYear)}</p>
                          <p className="mt-1 text-xs">Last payout</p>
                        </td>
                        <td className="px-3 py-4">
                          <Badge variant="neutral">System generated</Badge>
                          <p className="mt-1 text-xs text-[#64748B]">Payroll candidate ID</p>
                        </td>
                        <td className="px-3 py-4">
                          <Badge variant="neutral">Payroll candidate</Badge>
                        </td>
                        <td className="px-3 py-4 text-[#64748B]">
                          <p className="font-medium text-text">Payroll upload generated a resignation candidate.</p>
                          <p className="mt-1 text-xs">
                            Area: {candidate.areaName ?? "-"} | Hiring: {formatDate(candidate.hireDate)}
                          </p>
                        </td>
                        <td className="px-3 py-4 text-xs text-[#64748B]">
                          <p>System ID: {candidateSystemId}</p>
                          <p>Source: {candidate.sourceFileName ?? "-"}</p>
                          <p className="mt-1">Row: {candidate.sourceRow ?? "-"}</p>
                          <p className="mt-1">Updated: {formatDate(candidate.updatedAt.slice(0, 10))}</p>
                        </td>
                        <td className="px-3 py-4">
                          <p className="max-w-[240px] text-xs font-semibold text-[#475569]">
                            System resignation candidate ID: {candidateSystemId}. No manual HR ID generation is required.
                          </p>
                        </td>
                      </tr>
                    );
                  }

                  const { record } = row;
                  const daysLeft = daysUntil(record.effectiveDate);
                  const isBusy = busyAction?.startsWith(`${record.id}:`);
                  const isEditingDates = editingDates?.recordId === record.id;

                  return (
                    <tr className="align-top transition-colors hover:bg-[#FFF7ED]/55" key={row.key}>
                      <td className="px-3 py-4">
                        <p className="font-medium text-[#0F172A]">{formatEmployeeDisplayName(record.employeeName)}</p>
                        <p className="mt-1 font-mono text-xs text-[#64748B]">{record.employeeHrId}</p>
                        <p className="mt-1 text-xs text-[#64748B]">{record.jobTitle ?? "-"}</p>
                      </td>
                      <td className="px-3 py-4 text-[#64748B]">{record.lineName ?? "-"}</td>
                      <td className="px-3 py-4 text-[#64748B]">{formatDate(record.submittedDate)}</td>
                      <td className="px-3 py-4 text-[#64748B]">{formatDate(record.effectiveDate)}</td>
                      <td className="px-3 py-4">
                        <Badge
                          variant={getDaysTone(daysLeft) === "danger" ? "danger" : getDaysTone(daysLeft) === "warning" ? "warning" : "neutral"}
                        >
                          {daysLeft === null ? "-" : `${daysLeft} days`}
                        </Badge>
                        <p className="mt-1 text-xs text-[#64748B]">
                          {daysLeft === null ? "-" : daysLeft <= 7 ? "Escalation window" : "In progress"}
                        </p>
                      </td>
                      <td className="px-3 py-4">{statusBadge(record.status)}</td>
                      <td className="px-3 py-4 text-[#64748B]">
                        <p className="font-medium text-text">{record.reason ?? "-"}</p>
                        {record.rejectedReason ? (
                          <p className="mt-2 rounded-md bg-[#FEF2F2] px-2 py-1 text-xs text-[#991B1B]">
                            Rejection: {record.rejectedReason}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-3 py-4 text-xs text-[#64748B]">
                        <p>Created by: {record.createdBy ?? "-"}</p>
                        <p className="mt-1">Updated: {formatDate(record.updatedAt.slice(0, 10))}</p>
                        {record.workflowNotes ? (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[#C2410C]">View notes</summary>
                            <pre className="mt-2 whitespace-pre-wrap rounded-xl border border-[#E2E8F0] bg-[#F8FAFC] p-2 text-[11px] text-[#0F172A]">
                              {record.workflowNotes}
                            </pre>
                          </details>
                        ) : null}
                      </td>
                      <td className="px-3 py-4">
                        {isEditingDates ? (
                          <div className="mb-3 min-w-[260px] rounded-2xl border border-[#FED7AA] bg-[#FFF7ED] p-3 shadow-[0_12px_30px_rgba(15,23,42,0.08)]">
                            <div className="grid gap-2 sm:grid-cols-2">
                              <label className="block">
                                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]">
                                  Submitted
                                </span>
                                <Input
                                  className="h-9 rounded-xl border-[#FDBA74] bg-white px-2 text-xs"
                                  onChange={(event) => updateEditingDate("submittedDate", event.target.value)}
                                  type="date"
                                  value={editingDates.submittedDate}
                                />
                              </label>
                              <label className="block">
                                <span className="mb-1 block text-[10px] font-black uppercase tracking-[0.12em] text-[#64748B]">
                                  Effective
                                </span>
                                <Input
                                  className="h-9 rounded-xl border-[#FDBA74] bg-white px-2 text-xs"
                                  onChange={(event) => updateEditingDate("effectiveDate", event.target.value)}
                                  type="date"
                                  value={editingDates.effectiveDate}
                                />
                              </label>
                            </div>
                            <div className="mt-3 flex flex-wrap gap-2">
                              <Button
                                className="h-8 gap-1.5 px-3 text-xs"
                                disabled={isBusy}
                                onClick={() => void saveDateEdit(record)}
                              >
                                <Save className="h-3.5 w-3.5" />
                                Save
                              </Button>
                              <Button
                                className="h-8 px-3 text-xs"
                                disabled={isBusy}
                                onClick={() => setEditingDates(null)}
                                variant="secondary"
                              >
                                Cancel
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        <div className="flex flex-wrap gap-2">
                          <Button
                            className="h-9 gap-1.5 px-3 text-xs"
                            disabled={isBusy}
                            onClick={() => startDateEdit(record)}
                            variant="secondary"
                          >
                            {isEditingDates ? <CalendarDays className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
                            Edit Dates
                          </Button>
                          {record.status === "submitted" ? (
                            <Button
                              className="h-9 px-3 text-xs"
                              disabled={isBusy}
                              onClick={() => void runAction(record, "mark_review")}
                              variant="secondary"
                            >
                              Review
                            </Button>
                          ) : null}
                          {record.status === "under_review" || record.status === "submitted" ? (
                            <>
                              <Button
                                className="h-9 px-3 text-xs"
                                disabled={isBusy}
                                onClick={() => void runAction(record, "approve")}
                              >
                                Approve
                              </Button>
                              <Button
                                className="h-9 px-3 text-xs"
                                disabled={isBusy}
                                onClick={() => {
                                  const reason = window.prompt(
                                    "Why is this resignation being rejected?",
                                    record.rejectedReason ?? "",
                                  );
                                  if (reason === null) return;
                                  void runAction(record, "reject", { rejectedReason: reason });
                                }}
                                variant="destructive"
                              >
                                Reject
                              </Button>
                            </>
                          ) : null}
                          {record.status === "approved" ? (
                            <>
                              <Button
                                className="h-9 px-3 text-xs"
                                disabled={isBusy}
                                onClick={() => void runAction(record, "complete")}
                              >
                                Complete
                              </Button>
                              <Button
                                className="h-9 px-3 text-xs"
                                disabled={isBusy}
                                onClick={() => void runAction(record, "reopen")}
                                variant="secondary"
                              >
                                Reopen
                              </Button>
                            </>
                          ) : null}
                          {(record.status === "rejected" || record.status === "cancelled") ? (
                            <Button
                              className="h-9 px-3 text-xs"
                              disabled={isBusy}
                              onClick={() => void runAction(record, "reopen")}
                              variant="secondary"
                            >
                              Reopen
                            </Button>
                          ) : null}
                          {record.status !== "completed" && record.status !== "cancelled" ? (
                            <Button
                              className="h-9 px-3 text-xs"
                              disabled={isBusy}
                              onClick={() => void runAction(record, "cancel")}
                              variant="secondary"
                            >
                              Cancel
                            </Button>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </ResignationsPageShell>
  );
}
