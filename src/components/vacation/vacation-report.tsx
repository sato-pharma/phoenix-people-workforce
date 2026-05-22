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
import { useRouter, useSearchParams } from "next/navigation";
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
  VacationEmployeeEligibilityRow,
  VacationPaymentStatus,
  VacationReportData,
  VacationRequestRecord,
  VacationRequestStatus,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_PAYMENT_STATUSES, VACATION_STATUSES, VACATION_TYPES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";

type VacationReportProps = {
  initialData: VacationReportData | null;
  initialError: string | null;
  showHero?: boolean;
};

type VacationReportTab = "entitlements" | "requests";

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

function decisionSummary(row: VacationRequestRecord): { label: string; timestamp: string | null; variant: "danger" | "success" } | null {
  if (row.hrDecision) {
    return {
      label: `HR ${row.hrDecision === "approved" ? "Approved" : "Rejected"}`,
      timestamp: row.hrDecisionAt,
      variant: row.hrDecision === "approved" ? "success" : "danger",
    };
  }
  if (row.managerDecision) {
    return {
      label: `Manager ${row.managerDecision === "approved" ? "Approved" : "Rejected"}`,
      timestamp: row.managerDecisionAt,
      variant: row.managerDecision === "approved" ? "success" : "danger",
    };
  }
  return null;
}

function paymentBadgeVariant(status: VacationPaymentStatus) {
  return status === "paid" ? "success" : "warning";
}

function paymentStatusLabel(status: VacationPaymentStatus) {
  if (status === "partial") return "Partially paid";
  return status;
}

function eligibilityBadgeVariant(status: VacationEmployeeEligibilityRow["eligibilityStatus"]) {
  if (status === "eligible") return "success";
  if (status === "first_six_months") return "warning";
  return "danger";
}

function eligibilityStatusLabel(status: VacationEmployeeEligibilityRow["eligibilityStatus"]) {
  if (status === "eligible") return "Eligible now";
  if (status === "first_six_months") return "Inside first 6 months";
  return "Missing hire date";
}

function tabCardClassName(active: boolean, tone: "emerald" | "orange") {
  if (tone === "emerald") {
    return active
      ? "border-emerald-300 bg-gradient-to-br from-emerald-100 via-emerald-50 to-white shadow-[0_14px_36px_rgba(16,185,129,0.14)]"
      : "border-slate-200 bg-white hover:border-emerald-200 hover:bg-emerald-50/40";
  }

  return active
    ? "border-orange-300 bg-gradient-to-br from-orange-100 via-orange-50 to-white shadow-[0_14px_36px_rgba(249,115,22,0.14)]"
    : "border-slate-200 bg-white hover:border-orange-200 hover:bg-orange-50/40";
}

export function VacationReport({ initialData, initialError, showHero = true }: VacationReportProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const activeTab: VacationReportTab = searchParams.get("tab") === "requests" ? "requests" : "entitlements";

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

  const rows = initialData?.rows ?? [];
  const employeeEligibility = initialData?.employeeEligibility ?? [];
  const employeeEligibilitySummary = initialData?.employeeEligibilitySummary;
  const options = initialData?.options;
  const summary = initialData?.summary;
  const canAdminManage = Boolean(initialData?.canAdminManage);
  const showEntitlementsTab = activeTab === "entitlements";
  const showRequestsTab = activeTab === "requests";
  const addVacationTypeOptions = VACATION_TYPES.filter((option) => option.value !== "sick" && option.value !== "compensatory");
  const editVacationTypeOptions = VACATION_TYPES.some((option) => option.value === adminForm.vacationType)
    ? VACATION_TYPES
    : addVacationTypeOptions;

  function updateFilter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function updateAdminForm(key: keyof AdminVacationFormState, value: string) {
    setAdminForm((current) => ({ ...current, [key]: value }));
  }

  function buildReportUrl(tab: VacationReportTab, source: URLSearchParams) {
    const params = new URLSearchParams(source.toString());
    if (tab === "requests") {
      params.set("tab", "requests");
    } else {
      params.delete("tab");
    }
    return `/leave-management/vacation-report${params.toString() ? `?${params}` : ""}`;
  }

  function switchTab(nextTab: VacationReportTab) {
    router.push(buildReportUrl(nextTab, searchParams));
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
    router.push(buildReportUrl(activeTab, params));
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

  return (
    <PageContainer className="max-w-none">
      {showHero ? (
        <AdminPageHero
          description="Employee leave entitlements and request tracking in one admin workspace."
          eyebrow="Leave Management"
          icon={<Table2 className="h-3.5 w-3.5" />}
          title="Vacation Report"
        />
      ) : null}

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

      <Card className={cn(adminPanelClassName, "p-2")}>
        <div className="grid gap-2 md:grid-cols-2">
          <button className={cn("rounded-2xl border px-5 py-4 text-left transition-all duration-200", tabCardClassName(showEntitlementsTab, "emerald"))} onClick={() => switchTab("entitlements")} type="button">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-700">Tab 1</p>
            <h2 className="mt-2 text-xl font-black text-slate-950">Employee Leave Entitlements</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              All active employees, 6-month eligibility, and annual balance position.
            </p>
          </button>

          <button className={cn("rounded-2xl border px-5 py-4 text-left transition-all duration-200", tabCardClassName(showRequestsTab, "orange"))} onClick={() => switchTab("requests")} type="button">
            <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-700">Tab 2</p>
            <h2 className="mt-2 text-xl font-black text-slate-950">Employee Master Requests</h2>
            <p className="mt-1 text-sm leading-6 text-slate-600">
              Full leave request ledger with approvals, payment status, and admin actions.
            </p>
          </button>
        </div>
      </Card>

      <Card className={cn(adminPanelClassName, "p-5")}>
        <div className="mb-4">
          <p className="text-xs font-black uppercase tracking-[0.18em] text-slate-500">
            {showEntitlementsTab ? "Entitlements filters" : "Request filters"}
          </p>
          <h2 className="mt-2 text-xl font-black text-slate-950">
            {showEntitlementsTab ? "Employee leave entitlements" : "Employee master requests"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {showEntitlementsTab
              ? "Review active employees by person, manager, department, line, and current eligibility status."
              : "Review all leave requests with approval flow, dates, payment status, and request history."}
          </p>
        </div>

        <div className={cn("grid gap-3 md:grid-cols-2", showRequestsTab ? "xl:grid-cols-4" : "xl:grid-cols-5")}>
          <label className="space-y-2 xl:col-span-2">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <Input className="pl-9" value={filters.search} onChange={(event) => updateFilter("search", event.target.value)} />
            </div>
          </label>

          {showRequestsTab ? (
            <>
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
            </>
          ) : null}

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

          {showRequestsTab ? (
            <>
              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">From</span>
                <Input type="date" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
              </label>

              <label className="space-y-2">
                <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">To</span>
                <Input type="date" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} />
              </label>
            </>
          ) : null}

          <div className="flex items-end">
            <Button className="h-10 w-full gap-2 rounded-xl bg-slate-950 font-black text-white hover:bg-slate-800" onClick={applyFilters}>
              <Filter className="h-4 w-4" />
              Apply
            </Button>
          </div>
        </div>
      </Card>

      {showEntitlementsTab ? (
          <>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
              <AdminStatCard description="Active employees included in your visible review scope." icon={<Table2 className="h-5 w-5" />} label="Active employees" value={employeeEligibilitySummary?.activeEmployees ?? 0} tone="blue" variant="full" />
              <AdminStatCard description="Completed 6 months and can use paid annual leave rules." icon={<CheckCircle2 className="h-5 w-5" />} label="Eligible now" value={employeeEligibilitySummary?.eligibleNow ?? 0} tone="emerald" variant="full" />
              <AdminStatCard description="Still inside the first 6 months of service." icon={<Filter className="h-5 w-5" />} label="First 6 months" value={employeeEligibilitySummary?.inFirstSixMonths ?? 0} tone="orange" variant="full" />
              <AdminStatCard description="Employees needing HR data correction before leave eligibility can be confirmed." icon={<AlertCircle className="h-5 w-5" />} label="Missing hire date" value={employeeEligibilitySummary?.missingHireDate ?? 0} tone="rose" variant="full" />
              <AdminStatCard description="Eligible employees with no paid annual balance left right now." icon={<XCircle className="h-5 w-5" />} label="Zero balance" value={employeeEligibilitySummary?.zeroBalance ?? 0} tone="violet" variant="full" />
            </div>

            <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
              <div className="border-b border-slate-200 px-5 py-4">
                <p className="text-xs font-black uppercase tracking-[0.18em] text-emerald-700">
                  {canAdminManage ? "Master review" : "Visible scope review"}
                </p>
                <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-xl font-black text-slate-950">Employee leave entitlements</h2>
                    <p className="mt-1 text-sm font-medium text-slate-600">
                      Tracks visible employees against the 6-month rule and current annual leave balance.
                    </p>
                  </div>
                  <p className="max-w-xl text-right text-xs font-semibold leading-5 text-slate-500">
                    This tab follows your role scope plus employee, manager, department, line, and search filters.
                  </p>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="min-w-[1500px] w-full border-collapse bg-white text-left text-sm">
                  <thead>
                    <tr>
                      <th className={reportHeaderCellClass}>HR ID</th>
                      <th className={reportHeaderCellClass}>Employee</th>
                      <th className={reportHeaderCellClass}>Hire Date</th>
                      <th className={reportHeaderCellClass}>Days Since Hire</th>
                      <th className={reportHeaderCellClass}>6-Month Date</th>
                      <th className={reportHeaderCellClass}>Eligibility</th>
                      <th className={reportHeaderCellClass}>Annual Balance</th>
                      <th className={reportHeaderCellClass}>Manager</th>
                      <th className={reportHeaderCellClass}>Review</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employeeEligibility.map((row) => (
                      <tr key={row.hrId} className="bg-white transition even:bg-slate-50/60 hover:bg-emerald-50/40">
                        <td className={cn(reportCellClass, "whitespace-nowrap font-mono font-black text-slate-900")}>{row.hrId}</td>
                        <td className={cn(reportCellClass, "min-w-[240px]")}>
                          <p className="font-black text-slate-950">{row.fullName}</p>
                          <p className="mt-1 text-xs font-semibold text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}</p>
                          <p className="mt-1 text-xs text-slate-500">{row.employmentStatus ?? "-"}</p>
                        </td>
                        <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-900")}>{formatDate(row.hireDate)}</td>
                        <td className={cn(reportCellClass, "whitespace-nowrap text-center font-black text-slate-900")}>{row.daysSinceHire ?? "-"}</td>
                        <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-900")}>{formatDate(row.sixMonthAnniversary)}</td>
                        <td className={reportCellClass}>
                          <Badge variant={eligibilityBadgeVariant(row.eligibilityStatus)}>
                            {eligibilityStatusLabel(row.eligibilityStatus)}
                          </Badge>
                          {row.eligibilityStatus === "first_six_months" && (row.daysUntilEligibility ?? 0) > 0 ? (
                            <p className="mt-2 text-xs font-semibold text-amber-700">{row.daysUntilEligibility} days remaining</p>
                          ) : null}
                        </td>
                        <td className={cn(reportCellClass, "min-w-[200px]")}>
                          <p className="font-black text-slate-950">{formatDays(row.annualBalanceDays)} days left</p>
                          <p className="mt-1 text-xs font-semibold text-slate-500">
                            Opened {formatDays(row.annualEntitlementDays)} / Used {formatDays(row.annualUsedDays)}
                          </p>
                        </td>
                        <td className={cn(reportCellClass, "min-w-[180px]")}>
                          <p className="font-semibold text-slate-800">{row.managerName ?? "-"}</p>
                          <p className="text-xs text-slate-500">{row.managerHrId ?? ""}</p>
                        </td>
                        <td className={cn(reportCellClass, "min-w-[260px]")}>
                          {row.reviewFlags.length > 0 ? (
                            <div className="flex flex-wrap gap-2">
                              {row.reviewFlags.map((flag) => (
                                <Badge key={flag} variant="warning">{flag}</Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-sm font-semibold text-emerald-700">No immediate issue</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {employeeEligibility.length === 0 ? (
                      <tr>
                        <td className="border border-slate-200 px-4 py-10 text-center text-sm font-semibold text-slate-500" colSpan={9}>
                          No active employees matched the current filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
      ) : null}

      {showRequestsTab ? (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
            <AdminStatCard description="Visible requests after filters." icon={<Table2 className="h-5 w-5" />} label="Total" value={summary?.total ?? 0} tone="blue" />
            <AdminStatCard description="Awaiting manager or HR human decision." icon={<Filter className="h-5 w-5" />} label="Pending" value={summary?.pending ?? 0} tone="orange" />
            <AdminStatCard description="Approved by HR final review." icon={<CheckCircle2 className="h-5 w-5" />} label="Approved" value={summary?.approved ?? 0} tone="emerald" />
            <AdminStatCard description="Rejected by HR final review." icon={<XCircle className="h-5 w-5" />} label="Rejected" value={summary?.rejected ?? 0} tone="rose" />
            <AdminStatCard description="Paid / unpaid visible days." icon={<Table2 className="h-5 w-5" />} label="Days" value={`${formatDays(summary?.paidDays ?? 0)} / ${formatDays(summary?.unpaidDays ?? 0)}`} tone="violet" />
          </div>

          {canAdminManage ? (
            <Card className={cn(adminPanelClassName, "p-5")}>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="text-xs font-black uppercase tracking-[0.18em] text-orange-600">Admin controls</p>
                  <h2 className="text-xl font-black text-slate-950">Employee master requests</h2>
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
                      <td className={cn(reportCellClass, "whitespace-nowrap font-mono font-black text-slate-900")}>{row.employeeHrId}</td>
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
                      <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-900")}>{formatDate(row.startDate)}</td>
                      <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-900")}>{formatDate(row.endDate)}</td>
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
                      <td className={cn(reportCellClass, "whitespace-nowrap font-semibold text-slate-700")}>{formatDateTime(row.createdAt)}</td>
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
                          <div className="space-y-1.5">
                            {(() => {
                              const decision = decisionSummary(row);
                              if (!decision) {
                                return <p className="font-semibold text-slate-700">-</p>;
                              }
                              return (
                                <div className="flex flex-wrap items-center gap-2">
                                  <Badge variant={decision.variant}>{decision.label}</Badge>
                                  <span className="text-xs font-semibold text-slate-500">{decision.timestamp ? formatDateTime(decision.timestamp) : "-"}</span>
                                </div>
                              );
                            })()}
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
        </>
      ) : null}
    </PageContainer>
  );
}
