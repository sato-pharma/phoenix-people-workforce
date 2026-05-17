"use client";

import {
  AlertCircle,
  CheckCircle2,
  Filter,
  Search,
  Table2,
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
  vacationTypeLabel,
  vacationUnpaidReasonLabel,
} from "@/lib/vacation/calculations";
import type {
  VacationPaymentStatus,
  VacationReportData,
  VacationRequestStatus,
  VacationType,
} from "@/lib/vacation/types";
import { VACATION_PAYMENT_STATUSES, VACATION_STATUSES, VACATION_TYPES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";

type VacationReportProps = {
  initialData: VacationReportData | null;
  initialError: string | null;
};

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

function statusBadgeVariant(status: VacationRequestStatus) {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  return "warning";
}

function statusLabel(status: VacationRequestStatus) {
  if (status === "pending_manager") return "Pending";
  if (status === "approved") return "Approved";
  return "Rejected";
}

function paymentBadgeVariant(status: VacationPaymentStatus) {
  return status === "paid" ? "success" : "warning";
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
    search: initialData?.filters.search ?? "",
    status: initialData?.filters.status ?? "all",
    vacationType: initialData?.filters.vacationType ?? "all",
  });
  const [actionError, setActionError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  function updateFilter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
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

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <AdminStatCard description="Visible requests after filters." icon={<Table2 className="h-5 w-5" />} label="Total" value={summary?.total ?? 0} tone="blue" />
        <AdminStatCard description="Awaiting direct manager action." icon={<Filter className="h-5 w-5" />} label="Pending" value={summary?.pending ?? 0} tone="orange" />
        <AdminStatCard description="Approved vacation requests." icon={<CheckCircle2 className="h-5 w-5" />} label="Approved" value={summary?.approved ?? 0} tone="emerald" />
        <AdminStatCard description="Rejected vacation requests." icon={<XCircle className="h-5 w-5" />} label="Rejected" value={summary?.rejected ?? 0} tone="rose" />
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

      <Card className={cn(adminPanelClassName, "overflow-hidden p-0")}>
        <div className="overflow-x-auto">
          <table className="min-w-[1180px] w-full border-collapse text-left text-sm">
            <thead className="bg-slate-50 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Employee</th>
                <th className="px-4 py-3">Type</th>
                <th className="px-4 py-3">Dates</th>
                <th className="px-4 py-3">Duration</th>
                <th className="px-4 py-3">Payment</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Manager</th>
                <th className="px-4 py-3">Decision</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} className="bg-white align-top transition hover:bg-orange-50/30">
                  <td className="px-4 py-4">
                    <p className="font-black text-slate-950">{row.employeeName}</p>
                    <p className="text-xs font-semibold text-slate-500">{row.employeeHrId}</p>
                    <p className="mt-1 text-xs text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ")}</p>
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-bold text-slate-800">{vacationTypeLabel(row.vacationType)}</p>
                    <p className="text-xs text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-semibold text-slate-800">{formatDate(row.startDate)}</p>
                    <p className="text-xs text-slate-500">{formatDate(row.endDate)}</p>
                  </td>
                  <td className="px-4 py-4 font-black text-slate-900">{formatDays(row.durationDays)}</td>
                  <td className="px-4 py-4">
                    <Badge variant={paymentBadgeVariant(row.paymentStatus)}>
                      {row.paymentStatus}
                    </Badge>
                    {row.unpaidReason ? <p className="mt-2 text-xs font-semibold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}
                  </td>
                  <td className="px-4 py-4">
                    <Badge variant={statusBadgeVariant(row.status)}>{statusLabel(row.status)}</Badge>
                  </td>
                  <td className="px-4 py-4">
                    <p className="font-semibold text-slate-800">{row.managerName ?? "-"}</p>
                    <p className="text-xs text-slate-500">{row.managerHrId ?? ""}</p>
                    {row.managerOfManagerName ? <p className="mt-1 text-xs text-slate-500">MoM: {row.managerOfManagerName}</p> : null}
                  </td>
                  <td className="px-4 py-4">
                    {row.canDecide ? (
                      <div className="flex flex-wrap gap-2">
                        <Button className="gap-2 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-black hover:bg-emerald-700" disabled={actingId === row.id} onClick={() => decide(row.id, "approve")}>
                          <CheckCircle2 className="h-3.5 w-3.5" />
                          Approve
                        </Button>
                        <Button className="gap-2 rounded-lg bg-rose-600 px-3 py-2 text-xs font-black text-white hover:bg-rose-700" disabled={actingId === row.id} onClick={() => decide(row.id, "reject")}>
                          <XCircle className="h-3.5 w-3.5" />
                          Reject
                        </Button>
                      </div>
                    ) : (
                      <div>
                        <p className="font-semibold text-slate-700">{row.managerDecisionAt ? formatDate(row.managerDecisionAt.slice(0, 10)) : "-"}</p>
                        {row.managerDecisionComment ? <p className="mt-1 max-w-[220px] text-xs leading-5 text-slate-500">{row.managerDecisionComment}</p> : null}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-10 text-center text-sm font-semibold text-slate-500" colSpan={8}>
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
