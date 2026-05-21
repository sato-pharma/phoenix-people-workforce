"use client";

import {
  AlertCircle,
  CheckCircle2,
  Filter,
  Pencil,
  Plus,
  Search,
  Table2,
  Trash2,
  XCircle,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { AdminCallout, AdminPageHero, AdminStatCard, adminPanelClassName } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { PageContainer } from "@/components/layout/page-container";
import {
  vacationDayPartLabel,
  vacationRequestDisplayId,
  vacationTypeLabel,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import type {
  VacationPaymentStatus,
  VacationReportData,
  VacationRequestRecord,
  VacationRequestStatus,
  VacationType,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_PAYMENT_STATUSES, VACATION_STATUSES, VACATION_TYPES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";

type VacationReportProps = {
  initialData: VacationReportData | null;
  initialError: string | null;
};

const reportHeaderCellClass = "border border-slate-300 bg-slate-900 px-3 py-3 text-left text-[11px] font-black uppercase tracking-[0.12em] text-white";
const reportCellClass = "border border-slate-200 px-3 py-3 align-middle text-sm text-slate-700";

type AdminVacationFormState = {
  dayPart: string;
  employeeHrId: string;
  endDate: string;
  notes: string;
  startDate: string;
  status: string;
  vacationType: string;
};

function emptyAdminVacationForm(employeeHrId = ""): AdminVacationFormState {
  return {
    dayPart: "full_day",
    employeeHrId,
    endDate: "",
    notes: "",
    startDate: "",
    status: "approved",
    vacationType: "annual",
  };
}

function adminVacationFormFromRow(row: VacationRequestRecord): AdminVacationFormState {
  return {
    dayPart: row.dayPart,
    employeeHrId: row.employeeHrId,
    endDate: row.endDate,
    notes: row.notes ?? "",
    startDate: row.startDate,
    status: row.status,
    vacationType: row.vacationType,
  };
}

function formatDays(days: number) {
  return `${Number(days.toFixed(2))}`;
}

function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00Z`));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: "Africa/Cairo",
    year: "numeric",
  }).format(new Date(value));
}

function statusBadgeVariant(status: VacationRequestStatus) {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

function statusLabel(status: VacationRequestStatus) {
  if (status === "pending_manager") return "Pending Manager";
  if (status === "pending_hr") return "Pending HR";
  if (status === "approved") return "Approved";
  return "Rejected";
}

function paymentBadgeVariant(status: VacationPaymentStatus) {
  return status === "paid" ? "success" : "warning";
}

function paymentStatusLabel(status: VacationPaymentStatus) {
  if (status === "partial") return "Partially paid";
  return status;
}

export function VacationReport({ initialData, initialError }: VacationReportProps) {
  const router = useRouter();
  const [filters, setFilters] = useState({
    dateFrom: initialData?.filters.dateFrom ?? "",
    dateTo: initialData?.filters.dateTo ?? "",
    department: initialData?.filters.department ?? "",
    employee: initialData?.filters.employee ?? "",
    line: initialData?.filters.line ?? "",
    manager: initialData?.filters.manager ?? "",
    paymentStatus: initialData?.filters.paymentStatus ?? "all",
    requestId: initialData?.filters.requestId ?? "",
    search: initialData?.filters.search ?? "",
    status: initialData?.filters.status ?? "all",
    vacationType: initialData?.filters.vacationType ?? "all",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const [adminError, setAdminError] = useState<string | null>(null);
  const [adminForm, setAdminForm] = useState<AdminVacationFormState>(() => emptyAdminVacationForm(initialData?.options.employees[0]?.value));
  const [adminMode, setAdminMode] = useState<"add" | "edit" | null>(null);
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);

  function updateFilter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function updateAdminForm(key: keyof AdminVacationFormState, value: string) {
    setAdminForm((current) => ({ ...current, [key]: value }));
  }

  function startAdminAdd() {
    setAdminError(null);
    setEditingRequestId(null);
    setAdminForm(emptyAdminVacationForm(options?.employees[0]?.value ?? ""));
    setAdminMode("add");
  }

  function startAdminEdit(row: VacationRequestRecord) {
    setAdminError(null);
    setEditingRequestId(row.id);
    setAdminForm(adminVacationFormFromRow(row));
    setAdminMode("edit");
  }

  async function submitAdminForm() {
    setAdminError(null);
    setActingId(editingRequestId ?? "admin-add");
    try {
      const response = await fetch(
        adminMode === "edit" && editingRequestId
          ? `/api/vacations/requests/${encodeURIComponent(editingRequestId)}`
          : "/api/vacations/requests/admin",
        {
          body: JSON.stringify(adminForm),
          headers: { "Content-Type": "application/json" },
          method: adminMode === "edit" ? "PATCH" : "POST",
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation admin update failed.");
      }
      setAdminMode(null);
      setEditingRequestId(null);
      router.refresh();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Vacation admin update failed.");
    } finally {
      setActingId(null);
    }
  }

  async function deleteAdminRequest(row: VacationRequestRecord) {
    if (!window.confirm(`Delete vacation request ${row.id}? This removes the request record from the master report.`)) return;

    setAdminError(null);
    setActingId(row.id);
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(row.id)}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation delete failed.");
      }
      router.refresh();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Vacation delete failed.");
    } finally {
      setActingId(null);
    }
  }

  function applyFilters() {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value && value !== "all") params.set(key, value);
    });
    router.push(`/leave-management/vacation-report${params.toString() ? `?${params}` : ""}`);
  }

  async function decide(requestId: string, decision: "approve" | "reject") {
    const decisionComment = decision === "reject"
      ? window.prompt("Rejection reason") ?? null
      : null;
    if (decision === "reject" && decisionComment === null) return;

    setActingId(requestId);
    setActionError(null);
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(requestId)}/decision`, {
        body: JSON.stringify({ decision, decisionComment }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation decision failed.");
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Vacation decision failed.");
    } finally {
      setActingId(null);
    }
  }

  const rows = initialData?.rows ?? [];
  const options = initialData?.options;
  const summary = initialData?.summary;
  const canAdminManage = Boolean(initialData?.canAdminManage);
  const addVacationTypeOptions = VACATION_TYPES.filter((option) => option.value !== "sick" && option.value !== "compensatory");
  const editVacationTypeOptions = VACATION_TYPES.some((option) => option.value === adminForm.vacationType)
    ? VACATION_TYPES
    : addVacationTypeOptions;

  return (
    <PageContainer className="max-w-none">
      <AdminPageHero
        description="Vacation records, manager decisions, payment status, and HR visibility in one report."
        eyebrow="Leave Management"
        icon={<Table2 className="h-3.5 w-3.5" />}
        title="Vacation Report"
      />

      {initialError ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{initialError}</span>
        </AdminCallout>
      ) : null}
      {actionError ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{actionError}</span>
        </AdminCallout>
      ) : null}
      {adminError ? (
        <AdminCallout tone="danger">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{adminError}</span>
        </AdminCallout>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard description="Visible requests after filters." icon={<Table2 className="h-5 w-5" />} label="Total" value={summary?.total ?? 0} tone="blue" />
        <AdminStatCard description="Awaiting manager or HR human decision." icon={<Filter className="h-5 w-5" />} label="Pending" value={summary?.pending ?? 0} tone="orange" />
        <AdminStatCard description="Approved by HR final review." icon={<CheckCircle2 className="h-5 w-5" />} label="Approved" value={summary?.approved ?? 0} tone="emerald" />
        <AdminStatCard description="Rejected by HR final review." icon={<XCircle className="h-5 w-5" />} label="Rejected" value={summary?.rejected ?? 0} tone="rose" />
        <AdminStatCard description="Paid / unpaid visible days." icon={<Table2 className="h-5 w-5" />} label="Days" value={`${formatDays(summary?.paidDays ?? 0)} / ${formatDays(summary?.unpaidDays ?? 0)}`} tone="violet" />
      </div>

      <Card className={cn(adminPanelClassName, "p-5")}>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <label className="space-y-2 xl:col-span-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input className="pl-9" value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} />
            </div>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Request ID</span>
            <Input value={filters.requestId} onChange={(event) => updateFilter("requestId", event.target.value)} />
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Status</span>
            <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
              <option value="all">All statuses</option>
              {VACATION_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Payment</span>
            <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={filters.paymentStatus} onChange={(event) => updateFilter("paymentStatus", event.target.value)}>
              <option value="all">All payment</option>
              {VACATION_PAYMENT_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Type</span>
            <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={filters.vacationType} onChange={(event) => updateFilter("vacationType", event.target.value)}>
              <option value="all">All types</option>
              {VACATION_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Employee</span>
            <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={filters.employee} onChange={(event) => updateFilter("employee", event.target.value)}>
              <option value="">All employees</option>
              {(options?.employees ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Manager</span>
            <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={filters.manager} onChange={(event) => updateFilter("manager", event.target.value)}>
              <option value="">All managers</option>
              {(options?.managers ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Department</span>
            <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={filters.department} onChange={(event) => updateFilter("department", event.target.value)}>
              <option value="">All departments</option>
              {(options?.departments ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Line</span>
            <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={filters.line} onChange={(event) => updateFilter("line", event.target.value)}>
              <option value="">All lines</option>
              {(options?.lines ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">From</span>
            <Input type="date" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
          </label>

          <label className="space-y-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">To</span>
            <Input type="date" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} />
          </label>

          <div className="flex items-end">
            <Button className="h-10 w-full gap-2 rounded-xl bg-slate-950 font-black text-white hover:bg-slate-800" onClick={applyFilters}>
              <Filter className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </Card>

      {canAdminManage ? (
        <Card className={cn(adminPanelClassName, "p-5")}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Admin controls</p>
              <h2 className="text-xl font-black text-slate-950">Master vacation report actions</h2>
            </div>
            <Button className="gap-2 rounded-xl bg-orange-600 font-black text-white hover:bg-orange-700" onClick={startAdminAdd}>
              <Plus className="h-4 w-4" />
              Add Vacation
            </Button>
          </div>

          {adminMode ? (
            <div className="mt-5 grid gap-3 rounded-2xl border border-orange-100 bg-orange-50/40 p-4 md:grid-cols-2 xl:grid-cols-4">
              <label className="space-y-2 xl:col-span-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Employee</span>
                <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={adminForm.employeeHrId} onChange={(event) => updateAdminForm("employeeHrId", event.target.value)}>
                  <option value="">Select employee</option>
                  {(options?.employees ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Type</span>
                <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={adminForm.vacationType} onChange={(event) => updateAdminForm("vacationType", event.target.value)}>
                  {(adminMode === "add" ? addVacationTypeOptions : editVacationTypeOptions).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Status</span>
                <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={adminForm.status} onChange={(event) => updateAdminForm("status", event.target.value)}>
                  {VACATION_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Day part</span>
                <select className="h-10 w-full rounded-lg border border-border bg-card px-3 text-sm font-semibold" value={adminForm.dayPart} onChange={(event) => updateAdminForm("dayPart", event.target.value)}>
                  {VACATION_DAY_PARTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>

              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">From</span>
                <Input type="date" value={adminForm.startDate} onChange={(event) => updateAdminForm("startDate", event.target.value)} />
              </label>

              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">To</span>
                <Input type="date" value={adminForm.endDate} onChange={(event) => updateAdminForm("endDate", event.target.value)} />
              </label>

              <label className="space-y-2 xl:col-span-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Admin note</span>
                <Input value={adminForm.notes} onChange={(event) => updateAdminForm("notes", event.target.value)} />
              </label>

              <div className="flex items-end gap-2 xl:col-span-2">
                <Button className="h-10 flex-1 rounded-xl bg-slate-950 font-black text-white hover:bg-slate-800" disabled={Boolean(actingId)} onClick={submitAdminForm}>
                  {adminMode === "edit" ? "Save Changes" : "Create Vacation"}
                </Button>
                <Button className="h-10 rounded-xl border border-slate-200 bg-white font-black text-slate-700 hover:bg-slate-50" disabled={Boolean(actingId)} onClick={() => setAdminMode(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <div className="overflow-x-auto">
          <table className="min-w-[1680px] w-full border-collapse bg-white text-left text-sm">
            <thead>
              <tr>
                <th className={reportHeaderCellClass}>Request ID</th>
                <th className={reportHeaderCellClass}>HR ID</th>
                <th className={reportHeaderCellClass}>Employee</th>
                <th className={reportHeaderCellClass}>Type</th>
                <th className={reportHeaderCellClass}>From</th>
                <th className={reportHeaderCellClass}>To</th>
                <th className={reportHeaderCellClass}>Duration</th>
                <th className={reportHeaderCellClass}>Payment</th>
                <th className={reportHeaderCellClass}>Status</th>
                <th className={reportHeaderCellClass}>Submitted</th>
                <th className={reportHeaderCellClass}>Manager</th>
                <th className={reportHeaderCellClass}>{canAdminManage ? "Decision / Admin" : "Decision"}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="bg-white transition even:bg-slate-50/60 hover:bg-orange-50/40">
                  <td className={cn(reportCellClass, "whitespace-nowrap font-mono font-black text-slate-950")}>
                    <span title={row.id}>{vacationRequestDisplayId(row.id)}</span>
                  </td>
                  <td className={cn(reportCellClass, "whitespace-nowrap font-mono font-black text-slate-900")}>
                    {row.employeeHrId}
                  </td>
                  <td className={cn(reportCellClass, "min-w-[210px]")}>
                    <p className="font-black text-slate-950">{row.employeeName}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}</p>
                  </td>
                  <td className={cn(reportCellClass, "min-w-[190px]")}>
                    <p className="font-bold text-slate-800">{vacationTypeLabel(row.vacationType)}</p>
                    <p className="text-xs text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
                    {row.vacationType === "compensatory" ? (
                      <div className="mt-2 max-w-[260px] rounded-lg border border-orange-100 bg-orange-50/70 px-2.5 py-2 text-xs font-semibold leading-5 text-orange-900">
                        <p>{row.compensatoryEventName ?? "Compensatory event"}</p>
                        <p className="text-orange-700">{[row.compensatoryEventDate, row.compensatoryEventLocation].filter(Boolean).join(" / ")}</p>
                        <p className="text-orange-700">{[row.compensatoryManager1, row.compensatoryManager2].filter(Boolean).join(", ")}</p>
                      </div>
                    ) : null}
                    {row.vacationType === "other" && row.notes ? (
                      <p className="mt-2 max-w-[260px] rounded-lg border border-amber-100 bg-amber-50/70 px-2.5 py-2 text-xs font-semibold leading-5 text-amber-900">
                        {row.notes}
                      </p>
                    ) : null}
                  </td>
                  <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-900")}>
                    {formatDate(row.startDate)}
                  </td>
                  <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-900")}>
                    {formatDate(row.endDate)}
                  </td>
                  <td className={cn(reportCellClass, "whitespace-nowrap text-center font-black text-slate-900")}>{formatDays(row.durationDays)}</td>
                  <td className={reportCellClass}>
                    <Badge variant={paymentBadgeVariant(row.paymentStatus)}>
                      {paymentStatusLabel(row.paymentStatus)}
                    </Badge>
                    {row.paymentStatus === "partial" ? (
                      <p className="mt-2 text-xs font-semibold text-amber-700">
                        {formatDays(row.paidDurationDays)} paid / {formatDays(row.unpaidDurationDays)} unpaid
                      </p>
                    ) : null}
                    {row.unpaidReason ? <p className="mt-2 text-xs font-semibold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}
                  </td>
                  <td className={reportCellClass}>
                    <Badge variant={statusBadgeVariant(row.status)}>{statusLabel(row.status)}</Badge>
                  </td>
                  <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-700")}>
                    {formatDateTime(row.createdAt)}
                  </td>
                  <td className={cn(reportCellClass, "min-w-[190px]")}>
                    <p className="font-semibold text-slate-800">{row.managerName ?? "-"}</p>
                    <p className="text-xs text-slate-500">{row.managerHrId ?? ""}</p>
                    {row.managerOfManagerName ? <p className="mt-1 text-xs text-slate-500">MoM: {row.managerOfManagerName}</p> : null}
                  </td>
                  <td className={cn(reportCellClass, "min-w-[230px]")}>
                    {canAdminManage ? (
                      <div className="mb-3 flex flex-wrap gap-2">
                        <Button className="gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-black text-slate-700 hover:bg-slate-50" disabled={actingId === row.id} onClick={() => startAdminEdit(row)}>
                          <Pencil className="h-3.5 w-3.5" />
                          Edit
                        </Button>
                        <Button className="gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700" disabled={actingId === row.id} onClick={() => deleteAdminRequest(row)}>
                          <Trash2 className="h-3.5 w-3.5" />
                          Delete
                        </Button>
                      </div>
                    ) : null}
                    {row.canDecide ? (
                      <div className="flex flex-wrap gap-2">
                        <Button className="gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-black hover:bg-emerald-700" disabled={actingId === row.id} onClick={() => decide(row.id, "approve")}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          {row.status === "pending_hr" ? "Final Approve" : "Approve"}
                        </Button>
                        <Button className="gap-2 rounded-lg bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700" disabled={actingId === row.id} onClick={() => decide(row.id, "reject")}>
                          <XCircle className="h-3.5 w-3.5" />
                          {row.status === "pending_hr" ? "Final Reject" : "Reject"}
                        </Button>
                      </div>
                    ) : (
                      <div>
                        <p className="font-semibold text-slate-700">{row.hrDecisionAt ? formatDateTime(row.hrDecisionAt) : row.managerDecisionAt ? formatDateTime(row.managerDecisionAt) : "-"}</p>
                        {row.managerDecisionComment ? <p className="mt-1 max-w-[220px] text-xs leading-5 text-slate-500">{row.managerDecisionComment}</p> : null}
                        {row.hrDecisionComment ? <p className="mt-1 max-w-[220px] text-xs leading-5 text-slate-500">{row.hrDecisionComment}</p> : null}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="border border-slate-200 px-4 py-10 text-center text-sm font-semibold text-slate-500" colSpan={12}>
                    No vacation requests found.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>
    </PageContainer>
  );
}
