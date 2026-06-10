"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Filter,
  Pencil,
  Plus,
  Printer,
  Search,
  Table2,
  Trash2,
  XCircle,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
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
  VacationTimelineEvent,
} from "@/lib/vacation/types";
import { VACATION_DAY_PARTS, VACATION_PAYMENT_STATUSES, VACATION_STATUSES, VACATION_TYPES } from "@/lib/vacation/types";
import { cn } from "@/lib/utils";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Types ────────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

type VacationReportProps = {
  initialData: VacationReportData | null;
  initialError: string | null;
  showHero?: boolean;
};

type VacationReportTab = "entitlements" | "requests";

type AdminVacationFormState = {
  dayPart: string;
  employeeHrId: string;
  endDate: string;
  notes: string;
  startDate: string;
  status: string;
  vacationType: string;
};

type SortDirection = "asc" | "desc";

type EntitlementSortKey = "annualBalanceDays" | "daysSinceHire" | "fullName" | "hrId";

type RequestSortKey = "createdAt" | "durationDays" | "employeeName" | "startDate" | "status";

type PendingReportAction =
  | { kind: "decision"; decision: "approve" | "reject"; requestId: string; status: VacationRequestStatus }
  | { kind: "delete"; row: VacationRequestRecord };

const PAGE_SIZE = 25;

const DATE_PRESETS = [
  { label: "This month", value: "this_month" },
  { label: "Last 30 days", value: "last_30" },
  { label: "This quarter", value: "this_quarter" },
  { label: "This year", value: "this_year" },
] as const;

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Helpers ──────────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function emptyAdminVacationForm(employeeHrId = ""): AdminVacationFormState {
  return {
    dayPart: "full_day",
    employeeHrId,
    endDate: "",
    notes: "",
    startDate: "",
    status: "pending_manager",
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
  if (status === "needs_assignment") return "Needs HR Assignment";
  if (status === "pending_manager") return "Pending Manager";
  if (status === "pending_hr") return "Pending HR";
  if (status === "approved") return "Approved";
  return "Rejected";
}

// Dynamic, role-aware stage label for employee tracking. Built from fields already on the row
// (no extra fetch). For the sequential workflow (Annual/Other/Compensatory/Emergency) HR
// "records" the leave; Sick keeps its plain labels.
function dynamicStatusLabel(row: Pick<
  VacationRequestRecord,
  "status" | "vacationType" | "managerName" | "managerDecision" | "hrDecision"
>): string {
  const sequential = ["annual", "other", "compensatory", "emergency"].includes(row.vacationType);
  if (row.status === "needs_assignment") return "Needs HR Assignment";
  if (row.status === "pending_manager") {
    return row.managerName ? `Waiting for ${row.managerName} approval` : "Waiting for management approval";
  }
  if (row.status === "pending_hr") {
    return sequential ? "Approved by Management - Pending HR Acknowledgement" : "Pending HR";
  }
  if (row.status === "approved") return sequential ? "Recorded by HR" : "Approved";
  if (row.status === "rejected") {
    if (row.hrDecision === "rejected") return "Rejected by HR";
    if (row.managerDecision === "rejected") return row.managerName ? `Rejected by ${row.managerName}` : "Rejected by Management";
    return "Rejected";
  }
  return statusLabel(row.status);
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

function vacationAttachmentUrl(row: VacationRequestRecord, kind: "compensatory" | "sick") {
  return `/api/vacations/requests/${encodeURIComponent(row.id)}/attachments/${kind}`;
}

function VacationAttachmentLinks({
  canReviewAttachments,
  row,
}: {
  canReviewAttachments: boolean;
  row: VacationRequestRecord;
}) {
  if (!canReviewAttachments) return null;
  const attachments = [
    row.sickAttachmentObjectPath
      ? {
          href: vacationAttachmentUrl(row, "sick"),
          label: row.sickAttachmentOriginalName || "Medical document",
        }
      : null,
    row.compensatoryAttachmentObjectPath
      ? {
          href: vacationAttachmentUrl(row, "compensatory"),
          label: row.compensatoryAttachmentOriginalName || "Event photo",
        }
      : null,
  ].filter((attachment): attachment is { href: string; label: string } => Boolean(attachment));

  if (attachments.length === 0) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {attachments.map((attachment) => (
        <a
          className="inline-flex items-center gap-1 rounded-sm border border-sky-200 bg-sky-50 px-2 py-1 text-[10px] font-bold text-sky-700 transition hover:border-sky-300 hover:bg-sky-100"
          href={attachment.href}
          key={attachment.href}
          rel="noreferrer"
          target="_blank"
          title={attachment.label}
        >
          <FileText className="h-3 w-3" />
          Evidence
        </a>
      ))}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── CSV Export ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function csvEscape(v: string | number | null | undefined): string {
  const s = String(v ?? "");
  return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, csvContent: string) {
  const blob = new Blob(["﻿" + csvContent], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportEntitlementsCSV(data: VacationEmployeeEligibilityRow[]) {
  const header = ["HR ID", "Full Name", "Department", "Line", "Hire Date", "Days Since Hire", "6-Month Date", "Eligibility", "Entitlement Days", "Used Days", "Balance Days", "Manager", "Review Flags"];
  const rows = data.map((r) => [
    csvEscape(r.hrId), csvEscape(r.fullName), csvEscape(r.departmentName), csvEscape(r.lineName),
    csvEscape(r.hireDate), csvEscape(r.daysSinceHire), csvEscape(r.sixMonthAnniversary),
    csvEscape(eligibilityStatusLabel(r.eligibilityStatus)),
    csvEscape(r.annualEntitlementDays), csvEscape(r.annualUsedDays), csvEscape(r.annualBalanceDays),
    csvEscape(r.managerName), csvEscape(r.reviewFlags.join("; ")),
  ].join(","));
  downloadCsv(`entitlements-${new Date().toISOString().slice(0, 10)}.csv`, [header.join(","), ...rows].join("\n"));
}

function exportRequestsCSV(data: VacationRequestRecord[]) {
  const header = ["Request ID", "HR ID", "Employee", "Department", "Line", "Type", "Day Part", "Start", "End", "Duration", "Status", "Payment", "Paid Days", "Unpaid Days", "Submitted", "Manager"];
  const rows = data.map((r) => [
    csvEscape(vacationRequestDisplayId(r.id)), csvEscape(r.employeeHrId), csvEscape(r.employeeName),
    csvEscape(r.departmentName), csvEscape(r.lineName), csvEscape(vacationTypeLabel(r.vacationType)),
    csvEscape(vacationDayPartLabel(r.dayPart)), csvEscape(r.startDate), csvEscape(r.endDate),
    csvEscape(r.durationDays), csvEscape(statusLabel(r.status)), csvEscape(paymentStatusLabel(r.paymentStatus)),
    csvEscape(r.paidDurationDays), csvEscape(r.unpaidDurationDays),
    csvEscape(r.createdAt), csvEscape(r.managerName),
  ].join(","));
  downloadCsv(`vacation-requests-${new Date().toISOString().slice(0, 10)}.csv`, [header.join(","), ...rows].join("\n"));
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Date Preset Computation ─────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function computeDatePreset(preset: (typeof DATE_PRESETS)[number]["value"]): { from: string; to: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  switch (preset) {
    case "this_month":
      return { from: `${y}-${pad(m + 1)}-01`, to: fmt(new Date(y, m + 1, 0)) };
    case "last_30": {
      const from = new Date(now);
      from.setDate(from.getDate() - 30);
      return { from: fmt(from), to: fmt(now) };
    }
    case "this_quarter": {
      const qStart = Math.floor(m / 3) * 3;
      return { from: `${y}-${pad(qStart + 1)}-01`, to: fmt(new Date(y, qStart + 3, 0)) };
    }
    case "this_year":
      return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Sort Comparisons ────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function compareEntitlements(a: VacationEmployeeEligibilityRow, b: VacationEmployeeEligibilityRow, key: EntitlementSortKey, dir: SortDirection): number {
  let cmp = 0;
  switch (key) {
    case "hrId":
      cmp = (a.hrId ?? "").localeCompare(b.hrId ?? "");
      break;
    case "fullName":
      cmp = (a.fullName ?? "").localeCompare(b.fullName ?? "");
      break;
    case "annualBalanceDays":
      cmp = (a.annualBalanceDays ?? 0) - (b.annualBalanceDays ?? 0);
      break;
    case "daysSinceHire":
      cmp = (a.daysSinceHire ?? 0) - (b.daysSinceHire ?? 0);
      break;
  }
  return dir === "desc" ? -cmp : cmp;
}

function compareRequests(a: VacationRequestRecord, b: VacationRequestRecord, key: RequestSortKey, dir: SortDirection): number {
  let cmp = 0;
  switch (key) {
    case "employeeName":
      cmp = (a.employeeName ?? "").localeCompare(b.employeeName ?? "");
      break;
    case "startDate":
      cmp = (a.startDate ?? "").localeCompare(b.startDate ?? "");
      break;
    case "durationDays":
      cmp = (a.durationDays ?? 0) - (b.durationDays ?? 0);
      break;
    case "status":
      cmp = (a.status ?? "").localeCompare(b.status ?? "");
      break;
    case "createdAt":
      cmp = (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
      break;
  }
  return dir === "desc" ? -cmp : cmp;
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Sortable Table Header ───────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function SortableHeader<K extends string>({
  active,
  children,
  className: cls,
  direction,
  sortKey,
  onSort,
}: {
  active: boolean;
  children: React.ReactNode;
  className?: string;
  direction: SortDirection;
  sortKey: K;
  onSort: (key: K) => void;
}) {
  return (
    <th
      className={cn("cursor-pointer select-none border-b border-r border-slate-100 px-3 py-2.5 transition hover:bg-slate-100", cls)}
      onClick={() => onSort(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {children}
        {active ? (
          direction === "asc" ? <ArrowUp className="h-3 w-3 text-orange-500" /> : <ArrowDown className="h-3 w-3 text-orange-500" />
        ) : (
          <ArrowUpDown className="h-3 w-3 text-slate-300" />
        )}
      </span>
    </th>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Pagination Controls ─────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function PaginationControls({
  page,
  pageSize,
  total,
  onPageChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (p: number) => void;
}) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;

  const from = page * pageSize + 1;
  const to = Math.min((page + 1) * pageSize, total);

  return (
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-2.5">
      <p className="text-[11px] font-bold text-slate-500">
        {from}–{to} of {total}
      </p>
      <div className="flex items-center gap-1">
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          disabled={page === 0}
          onClick={() => onPageChange(page - 1)}
          type="button"
          aria-label="Previous page"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="px-2 text-[11px] font-bold text-slate-700">
          {page + 1} / {totalPages}
        </span>
        <button
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm border border-slate-200 bg-white text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          disabled={page >= totalPages - 1}
          onClick={() => onPageChange(page + 1)}
          type="button"
          aria-label="Next page"
        >
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Select with focus trap ──────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const selectClass =
  "h-10 w-full rounded-sm border border-slate-200 bg-white px-3 text-[13px] font-semibold text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100";

const labelClass = "text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500";

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Skeleton Loaders ─────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function MetricCardSkeleton() {
  return (
    <div className="animate-pulse rounded-sm border border-slate-200 bg-white p-4">
      <div className="h-2.5 w-16 rounded-sm bg-slate-200" />
      <div className="mt-3 h-7 w-12 rounded-sm bg-slate-200" />
      <div className="mt-2 h-2 w-32 rounded-sm bg-slate-100" />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Metric Card ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function MetricCard({
  description,
  label,
  tone,
  value,
}: {
  description: string;
  label: string;
  tone: "blue" | "emerald" | "orange" | "rose" | "violet";
  value: number | string;
}) {
  const toneMap = {
    blue: {
      bg: "bg-sky-50",
      border: "border-sky-100",
      label: "text-sky-600",
      value: "text-sky-900",
    },
    emerald: {
      bg: "bg-emerald-50",
      border: "border-emerald-100",
      label: "text-emerald-600",
      value: "text-emerald-900",
    },
    orange: {
      bg: "bg-orange-50",
      border: "border-orange-100",
      label: "text-orange-600",
      value: "text-orange-900",
    },
    rose: {
      bg: "bg-rose-50",
      border: "border-rose-100",
      label: "text-rose-600",
      value: "text-rose-900",
    },
    violet: {
      bg: "bg-violet-50",
      border: "border-violet-100",
      label: "text-violet-600",
      value: "text-violet-900",
    },
  };

  const t = toneMap[tone];

  return (
    <div className={cn("rounded-sm border p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]", t.border, t.bg)}>
      <p className={cn("text-[10px] font-bold uppercase tracking-[0.12em]", t.label)}>
        {label}
      </p>
      <p className={cn("mt-1.5 text-[1.75rem] font-extrabold leading-none tracking-[-0.04em]", t.value)}>
        {value}
      </p>
      <p className="mt-2 text-[11px] font-medium leading-4 text-slate-500">{description}</p>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Status Distribution Bar ──────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function StatusDistributionBar({
  approved,
  pending,
  rejected,
  total,
}: {
  approved: number;
  pending: number;
  rejected: number;
  total: number;
}) {
  if (total === 0) return null;

  const approvedPct = (approved / total) * 100;
  const pendingPct = (pending / total) * 100;
  const rejectedPct = (rejected / total) * 100;

  return (
    <div className="rounded-sm border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Request status distribution</p>
        <p className="text-[11px] font-bold text-slate-400">{total} total</p>
      </div>
      <div className="mt-2.5 flex h-3 w-full overflow-hidden rounded-sm bg-slate-100">
        {approvedPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
            style={{ width: `${approvedPct}%` }}
            title={`Approved: ${approved}`}
          />
        ) : null}
        {pendingPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
            style={{ width: `${pendingPct}%` }}
            title={`Pending: ${pending}`}
          />
        ) : null}
        {rejectedPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-rose-600 to-rose-400 transition-all duration-500"
            style={{ width: `${rejectedPct}%` }}
            title={`Rejected: ${rejected}`}
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold uppercase tracking-[0.08em]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
          <span className="text-emerald-700">Approved {approved}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />
          <span className="text-amber-700">Pending {pending}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-rose-500" />
          <span className="text-rose-700">Rejected {rejected}</span>
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Balance Distribution Bar ─────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function EligibilityDistributionBar({
  eligible,
  firstSixMonths,
  missingHireDate,
  total,
}: {
  eligible: number;
  firstSixMonths: number;
  missingHireDate: number;
  total: number;
}) {
  if (total === 0) return null;

  const eligiblePct = (eligible / total) * 100;
  const sixMonthPct = (firstSixMonths / total) * 100;
  const missingPct = (missingHireDate / total) * 100;

  return (
    <div className="rounded-sm border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Eligibility distribution</p>
        <p className="text-[11px] font-bold text-slate-400">{total} employees</p>
      </div>
      <div className="mt-2.5 flex h-3 w-full overflow-hidden rounded-sm bg-slate-100">
        {eligiblePct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-emerald-600 to-emerald-400 transition-all duration-500"
            style={{ width: `${eligiblePct}%` }}
            title={`Eligible: ${eligible}`}
          />
        ) : null}
        {sixMonthPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
            style={{ width: `${sixMonthPct}%` }}
            title={`First 6 months: ${firstSixMonths}`}
          />
        ) : null}
        {missingPct > 0 ? (
          <div
            className="h-full bg-gradient-to-r from-rose-600 to-rose-400 transition-all duration-500"
            style={{ width: `${missingPct}%` }}
            title={`Missing hire date: ${missingHireDate}`}
          />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold uppercase tracking-[0.08em]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
          <span className="text-emerald-700">Eligible {eligible}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />
          <span className="text-amber-700">First 6 months {firstSixMonths}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-rose-500" />
          <span className="text-rose-700">Missing data {missingHireDate}</span>
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Paid vs Unpaid Days Bar ──────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function PaidUnpaidBar({
  paidDays,
  unpaidDays,
}: {
  paidDays: number;
  unpaidDays: number;
}) {
  const total = paidDays + unpaidDays;
  if (total === 0) return null;

  const paidPct = (paidDays / total) * 100;

  return (
    <div className="rounded-sm border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-center justify-between">
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Paid vs Unpaid days</p>
        <p className="text-[11px] font-bold text-slate-400">{formatDays(total)} total</p>
      </div>
      <div className="mt-2.5 flex h-3 w-full overflow-hidden rounded-sm bg-slate-100">
        <div
          className="h-full bg-gradient-to-r from-emerald-600 to-emerald-300 transition-all duration-500"
          style={{ width: `${paidPct}%` }}
          title={`Paid: ${formatDays(paidDays)}`}
        />
        <div
          className="h-full bg-gradient-to-r from-amber-500 to-amber-300 transition-all duration-500"
          style={{ width: `${100 - paidPct}%` }}
          title={`Unpaid: ${formatDays(unpaidDays)}`}
        />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-bold uppercase tracking-[0.08em]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
          <span className="text-emerald-700">Paid {formatDays(paidDays)} days</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />
          <span className="text-amber-700">Unpaid {formatDays(unpaidDays)} days</span>
        </span>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Collapsible Filter Panel ─────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function FilterPanel({
  children,
  filterCount,
  onApply,
}: {
  children: React.ReactNode;
  filterCount: number;
  onApply: () => void;
}) {
  const [open, setOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus trap when open
  useEffect(() => {
    if (!open) return;
    const container = panelRef.current;
    if (!container) return;

    const focusableSelector =
      'button:not([disabled]), select:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])';

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setOpen(false);
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = container!.querySelectorAll<HTMLElement>(focusableSelector);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  return (
    <div ref={panelRef} className="rounded-sm border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <button
        className="flex w-full items-center justify-between px-4 py-3 text-left transition hover:bg-slate-50"
        onClick={() => setOpen((c) => !c)}
        type="button"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2">
          <Filter className="h-3.5 w-3.5 text-slate-400" />
          <span className="text-[13px] font-bold text-slate-800">Filters</span>
          {filterCount > 0 ? (
            <Badge className="border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-[10px] font-bold text-orange-700">
              {filterCount} active
            </Badge>
          ) : null}
        </div>
        <ChevronDown className={cn("h-3.5 w-3.5 text-slate-400 transition-transform duration-200", open ? "rotate-180" : "")} />
      </button>
      {open ? (
        <div className="border-t border-slate-100 px-4 py-3">
          <div className="grid gap-3 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {children}
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <Button
              className="h-9 gap-2 rounded-sm bg-orange-500 px-4 text-[12px] font-bold text-white hover:bg-orange-600"
              onClick={() => {
                onApply();
                setOpen(false);
              }}
              type="button"
            >
              <Filter className="h-3 w-3" />
              Apply Filters
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Entitlements Mobile Card ─────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function EntitlementCard({ row }: { row: VacationEmployeeEligibilityRow }) {
  const usedPct = row.annualEntitlementDays > 0
    ? Math.min((row.annualUsedDays / row.annualEntitlementDays) * 100, 100)
    : 0;
  const remainPct = 100 - usedPct;
  const barColor =
    remainPct >= 60
      ? "from-emerald-600 to-emerald-300"
      : remainPct >= 30
        ? "from-amber-500 to-amber-300"
        : "from-rose-600 to-rose-300";

  return (
    <div className="rounded-sm border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-slate-900">{row.fullName}</p>
          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
            {row.hrId} {[row.departmentName, row.lineName].filter(Boolean).join(" / ") ? ` · ${[row.departmentName, row.lineName].filter(Boolean).join(" / ")}` : ""}
          </p>
        </div>
        <Badge variant={eligibilityBadgeVariant(row.eligibilityStatus)}>
          {eligibilityStatusLabel(row.eligibilityStatus)}
        </Badge>
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Hire date</p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-700">{formatDate(row.hireDate)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Since hire</p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-700">{row.daysSinceHire ?? "-"} days</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">6-mo date</p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-700">{formatDate(row.sixMonthAnniversary)}</p>
        </div>
      </div>

      {/* Balance bar */}
      <div className="mt-2.5">
        <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">
          <span>Used {formatDays(row.annualUsedDays)}</span>
          <span>of {formatDays(row.annualEntitlementDays)}</span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-sm bg-slate-100">
          <div
            className={cn("h-full bg-gradient-to-r transition-all duration-500", barColor)}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        <p className="mt-1 text-[12px] font-extrabold text-slate-900">{formatDays(row.annualBalanceDays)} days remaining</p>
      </div>

      {row.eligibilityStatus === "first_six_months" && (row.daysUntilEligibility ?? 0) > 0 ? (
        <p className="mt-1.5 text-[11px] font-bold text-amber-700">{row.daysUntilEligibility} days until eligible</p>
      ) : null}

      {row.managerName ? (
        <p className="mt-1.5 text-[11px] font-medium text-slate-500">Manager: {row.managerName}</p>
      ) : null}

      {row.reviewFlags.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {row.reviewFlags.map((flag) => (
            <Badge key={flag} variant="warning">{flag}</Badge>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Request Mobile Card ──────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function RequestCard({
  actingId,
  canAdminManage,
  canReviewAttachments,
  onDecide,
  onDelete,
  onEdit,
  onReview,
  row,
}: {
  actingId: string | null;
  canAdminManage: boolean;
  canReviewAttachments: boolean;
  onDecide: (row: VacationRequestRecord, decision: "approve" | "reject") => void;
  onDelete: (row: VacationRequestRecord) => void;
  onEdit: (row: VacationRequestRecord) => void;
  onReview: (row: VacationRequestRecord) => void;
  row: VacationRequestRecord;
}) {
  return (
    <div className="rounded-sm border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-bold text-slate-900">{row.employeeName}</p>
          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
            {row.employeeHrId} · {vacationRequestDisplayId(row.id)}
          </p>
          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
            {[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={statusBadgeVariant(row.status)}>{dynamicStatusLabel(row)}</Badge>
          <Badge variant={paymentBadgeVariant(row.paymentStatus)}>{paymentStatusLabel(row.paymentStatus)}</Badge>
        </div>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Type</p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-700">{vacationTypeLabel(row.vacationType)}</p>
          <p className="text-[11px] font-medium text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">Duration</p>
          <p className="mt-0.5 text-[12px] font-extrabold text-slate-900">{formatDays(row.durationDays)} days</p>
        </div>
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">From</p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-700">{formatDate(row.startDate)}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.08em] text-slate-400">To</p>
          <p className="mt-0.5 text-[12px] font-semibold text-slate-700">{formatDate(row.endDate)}</p>
        </div>
      </div>

      {row.paymentStatus === "partial" ? (
        <p className="mt-1.5 text-[11px] font-bold text-amber-700">
          {formatDays(row.paidDurationDays)} paid / {formatDays(row.unpaidDurationDays)} unpaid
        </p>
      ) : null}
      {row.unpaidReason ? <p className="mt-1 text-[11px] font-bold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}

      {row.vacationType === "compensatory" ? (
        <div className="mt-2 rounded-sm border border-orange-100 bg-orange-50/70 px-2.5 py-2 text-[11px] font-semibold leading-4 text-orange-900">
          <p>{row.compensatoryEventName ?? "Compensatory event"}</p>
          <p className="text-orange-700">{[row.compensatoryEventDate, row.compensatoryEventLocation].filter(Boolean).join(" / ")}</p>
          <VacationAttachmentLinks canReviewAttachments={canReviewAttachments} row={row} />
        </div>
      ) : null}
      {row.vacationType === "sick" ? <VacationAttachmentLinks canReviewAttachments={canReviewAttachments} row={row} /> : null}
      {row.vacationType === "other" && row.notes ? (
        <p className="mt-2 rounded-sm border border-amber-100 bg-amber-50/70 px-2.5 py-2 text-[11px] font-semibold leading-4 text-amber-900">
          {row.notes}
        </p>
      ) : null}

      <div className="mt-2 flex items-center justify-between text-[11px] font-medium text-slate-500">
        <span>Submitted {formatDateTime(row.createdAt)}</span>
        {row.managerName ? <span>Mgr: {row.managerName}</span> : null}
      </div>
      {(row.slaStatus.isOverdue || row.overlapWarnings.length > 0) ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {row.slaStatus.isOverdue ? <Badge variant="danger">SLA overdue</Badge> : null}
          {row.overlapWarnings.length > 0 ? <Badge variant="warning">{row.overlapWarnings.length} warning(s)</Badge> : null}
        </div>
      ) : null}
      {!canAdminManage ? (
        <button
          className="mt-2 flex items-center gap-1 text-[11px] font-bold text-slate-500 transition hover:text-slate-700"
          onClick={() => onReview(row)}
          type="button"
        >
          <FileText className="h-3 w-3" /> Timeline
        </button>
      ) : null}

      {/* Decision info or action buttons */}
      {row.canDecide ? (
        <div className="mt-2.5 flex gap-2">
          <Button
            className="h-8 flex-1 gap-1.5 rounded-sm bg-emerald-600 text-[11px] font-bold hover:bg-emerald-700"
            disabled={actingId === row.id}
            onClick={() => onDecide(row, "approve")}
            type="button"
          >
            <CheckCircle2 className="h-3 w-3" />
            {row.status === "pending_hr" ? "Final Approve" : "Approve"}
          </Button>
          <Button
            className="h-8 flex-1 gap-1.5 rounded-sm bg-rose-600 text-[11px] font-bold text-white hover:bg-rose-700"
            disabled={actingId === row.id}
            onClick={() => onDecide(row, "reject")}
            type="button"
          >
            <XCircle className="h-3 w-3" />
            {row.status === "pending_hr" ? "Final Reject" : "Reject"}
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-[11px] text-slate-500">
          {row.hrDecisionAt ? <p>HR: {formatDateTime(row.hrDecisionAt)}</p> : null}
          {row.managerDecisionAt ? <p>Manager: {formatDateTime(row.managerDecisionAt)}</p> : null}
          {row.managerDecisionComment ? <p className="text-slate-600">{row.managerDecisionComment}</p> : null}
          {row.hrDecisionComment ? <p className="text-slate-600">{row.hrDecisionComment}</p> : null}
        </div>
      )}

      {canAdminManage ? (
        <div className="mt-2 flex gap-2 border-t border-slate-100 pt-2">
          <button
            className="flex items-center gap-1 text-[11px] font-bold text-slate-500 transition hover:text-slate-700"
            onClick={() => onReview(row)}
            type="button"
          >
            <FileText className="h-3 w-3" /> Timeline
          </button>
          <button
            className="flex items-center gap-1 text-[11px] font-bold text-slate-500 transition hover:text-slate-700"
            disabled={actingId === row.id}
            onClick={() => onEdit(row)}
            type="button"
          >
            <Pencil className="h-3 w-3" /> Edit
          </button>
          <button
            className="flex items-center gap-1 text-[11px] font-bold text-rose-500 transition hover:text-rose-700"
            disabled={actingId === row.id}
            onClick={() => onDelete(row)}
            type="button"
          >
            <Trash2 className="h-3 w-3" /> Delete
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Exported Component (Error Boundary Wrapper) ──────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

export function VacationReport(props: VacationReportProps) {
  return (
    <WorkspaceErrorBoundary fallbackTitle="Vacation report failed to load">
      <VacationReportInner {...props} />
    </WorkspaceErrorBoundary>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Main Report ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

function VacationReportInner({ initialData, initialError, showHero = true }: VacationReportProps) {
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
  const [decisionComment, setDecisionComment] = useState("");
  const [editingRequestId, setEditingRequestId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<PendingReportAction | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<VacationRequestRecord | null>(null);
  const [timeline, setTimeline] = useState<VacationTimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [evidenceReviewNote, setEvidenceReviewNote] = useState("");

  /* ── Pagination state ────────────────────────────── */
  const [entitlementPage, setEntitlementPage] = useState(0);
  const [requestPage, setRequestPage] = useState(0);

  /* ── Sort state ──────────────────────────────────── */
  const [entitlementSort, setEntitlementSort] = useState<EntitlementSortKey>("hrId");
  const [entitlementSortDir, setEntitlementSortDir] = useState<SortDirection>("asc");
  const [requestSort, setRequestSort] = useState<RequestSortKey>("createdAt");
  const [requestSortDir, setRequestSortDir] = useState<SortDirection>("desc");

  const rows = useMemo(() => initialData?.rows ?? [], [initialData?.rows]);
  const employeeEligibility = useMemo(() => initialData?.employeeEligibility ?? [], [initialData?.employeeEligibility]);
  const employeeEligibilitySummary = initialData?.employeeEligibilitySummary;
  const options = initialData?.options;
  const summary = initialData?.summary;
  const dashboard = initialData?.dashboard;
  const canAdminManage = Boolean(initialData?.canAdminManage);
  const canExport = Boolean(initialData?.canExport);
  const canReviewAttachments = Boolean(initialData?.canReviewAttachments);
  const showEntitlementsTab = activeTab === "entitlements";
  const showRequestsTab = activeTab === "requests";
  const addVacationTypeOptions = VACATION_TYPES.filter((option) => option.value !== "sick" && option.value !== "compensatory");
  const editVacationTypeOptions = VACATION_TYPES.some((option) => option.value === adminForm.vacationType)
    ? VACATION_TYPES
    : addVacationTypeOptions;

  const activeFilterCount = useMemo(() => {
    let count = 0;
    if (filters.search) count++;
    if (filters.requestId) count++;
    if (filters.status && filters.status !== "all") count++;
    if (filters.paymentStatus && filters.paymentStatus !== "all") count++;
    if (filters.vacationType && filters.vacationType !== "all") count++;
    if (filters.employee) count++;
    if (filters.manager) count++;
    if (filters.department) count++;
    if (filters.line) count++;
    if (filters.dateFrom) count++;
    if (filters.dateTo) count++;
    return count;
  }, [filters]);

  function updateFilter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
  }

  function updateAdminForm(key: keyof AdminVacationFormState, value: string) {
    setAdminForm((current) => ({ ...current, [key]: value }));
  }

  /* ── Sorted + paginated entitlements ────────────── */
  const sortedEntitlements = useMemo(() => {
    const sorted = [...employeeEligibility].sort((a, b) => compareEntitlements(a, b, entitlementSort, entitlementSortDir));
    return sorted;
  }, [employeeEligibility, entitlementSort, entitlementSortDir]);

  const paginatedEntitlements = useMemo(() => {
    const start = entitlementPage * PAGE_SIZE;
    return sortedEntitlements.slice(start, start + PAGE_SIZE);
  }, [sortedEntitlements, entitlementPage]);

  /* ── Sorted + paginated requests ─────────────────── */
  const sortedRequests = useMemo(() => {
    const sorted = [...rows].sort((a, b) => compareRequests(a, b, requestSort, requestSortDir));
    return sorted;
  }, [rows, requestSort, requestSortDir]);

  const paginatedRequests = useMemo(() => {
    const start = requestPage * PAGE_SIZE;
    return sortedRequests.slice(start, start + PAGE_SIZE);
  }, [sortedRequests, requestPage]);

  /* ── Sort toggle handlers ────────────────────────── */
  function toggleEntitlementSort(key: EntitlementSortKey) {
    if (entitlementSort === key) {
      setEntitlementSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setEntitlementSort(key);
      setEntitlementSortDir("asc");
    }
    setEntitlementPage(0);
  }

  function toggleRequestSort(key: RequestSortKey) {
    if (requestSort === key) {
      setRequestSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setRequestSort(key);
      setRequestSortDir("asc");
    }
    setRequestPage(0);
  }

  /* ── Date preset handler ─────────────────────────── */
  function applyDatePreset(preset: (typeof DATE_PRESETS)[number]["value"]) {
    const { from, to } = computeDatePreset(preset);
    setFilters((current) => ({ ...current, dateFrom: from, dateTo: to }));
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

  async function performDeleteAdminRequest(row: VacationRequestRecord) {
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

  function deleteAdminRequest(row: VacationRequestRecord) {
    setDecisionComment("");
    setPendingAction({ kind: "delete", row });
  }

  function applyFilters() {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value && value !== "all") params.set(key, value);
    });
    router.push(buildReportUrl(activeTab, params));
  }

  const performDecision = useCallback(async (requestId: string, decision: "approve" | "reject", comment: string | null) => {
    setActingId(requestId);
    setActionError(null);
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(requestId)}/decision`, {
        body: JSON.stringify({ decision, decisionComment: comment }),
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
  }, [router]);

  const decide = useCallback((row: VacationRequestRecord, decision: "approve" | "reject") => {
    setDecisionComment("");
    setPendingAction({ decision, kind: "decision", requestId: row.id, status: row.status });
  }, []);

  async function confirmPendingAction() {
    if (!pendingAction) return;
    if (pendingAction.kind === "decision" && pendingAction.decision === "reject" && !decisionComment.trim()) {
      setActionError("Rejection reason is required.");
      return;
    }

    const action = pendingAction;
    setPendingAction(null);
    if (action.kind === "delete") {
      await performDeleteAdminRequest(action.row);
      return;
    }

    await performDecision(
      action.requestId,
      action.decision,
      action.decision === "reject" ? decisionComment.trim() : null,
    );
  }

  async function openRequestReview(row: VacationRequestRecord) {
    setSelectedRequest(row);
    setTimeline([]);
    setTimelineLoading(true);
    setEvidenceReviewNote("");
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(row.id)}/timeline`);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "Timeline failed.");
      setTimeline(Array.isArray(payload.timeline) ? payload.timeline : []);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Timeline failed.");
    } finally {
      setTimelineLoading(false);
    }
  }

  async function submitEvidenceReview(status: "accepted" | "needs_follow_up" | "rejected") {
    if (!selectedRequest) return;
    const evidenceType = selectedRequest.vacationType === "compensatory" ? "compensatory" : "sick";
    setActingId(selectedRequest.id);
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(selectedRequest.id)}/evidence-review`, {
        body: JSON.stringify({ evidenceType, reviewNote: evidenceReviewNote, status }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.message === "string" ? payload.message : "Evidence review failed.");
      router.refresh();
      await openRequestReview(selectedRequest);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Evidence review failed.");
    } finally {
      setActingId(null);
    }
  }

  const auditExportHref = useMemo(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => {
      if (value && value !== "all") params.set(key, value);
    });
    return `/api/vacations/report/export${params.toString() ? `?${params}` : ""}`;
  }, [filters]);

  /* ═══════════════════════════════════════════════════════════════ */
  /* ─── Tab Items ─────────────────────────────────────────────────── */
  /* ═══════════════════════════════════════════════════════════════ */

  const tabItems = [
    {
      count: employeeEligibility.length,
      label: "Leave Entitlements",
      value: "entitlements" as const,
    },
    {
      count: rows.length,
      label: "Master Requests",
      value: "requests" as const,
    },
  ];

  /* ═══════════════════════════════════════════════════════════════ */
  /* ─── Render ───────────────────────────────────────────────────── */
  /* ═══════════════════════════════════════════════════════════════ */

  return (
    <PageContainer className="vacation-report-premium">
      {/* Print-friendly stylesheet */}
      <style>{`
        @media print {
          body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
          .vacation-report-premium { padding: 0; }
          .vacation-report-premium [role="tablist"],
          .vacation-report-premium button[aria-expanded],
          .vacation-report-premium .print\\:hidden { display: none !important; }
          .vacation-report-premium table { font-size: 10px; }
          .vacation-report-premium td, .vacation-report-premium th { padding: 4px 6px; }
          nav, header, footer, aside { display: none !important; }
        }
      `}</style>
      <div className="space-y-3" dir="auto">
        {showHero ? (
          <AdminPageHero
            description="Employee leave entitlements and request tracking in one admin workspace."
            eyebrow="Leave Management"
            icon={<Table2 className="h-3.5 w-3.5" />}
            title="Vacation Report"
          />
        ) : null}

        {/* ── Error Banners ──────────────────────────────────────── */}
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

        {/* ── Tab Bar ────────────────────────────────────────────── */}
        {pendingAction ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/35 px-4 py-6 print:hidden" role="presentation">
            <div
              aria-modal="true"
              className="w-full max-w-md rounded-sm border border-slate-200 bg-white p-4 shadow-xl"
              role="dialog"
            >
              <h3 className="text-base font-extrabold text-slate-950">
                {pendingAction.kind === "delete"
                  ? "Delete vacation request"
                  : pendingAction.decision === "approve"
                    ? pendingAction.status === "pending_hr" ? "Final approve request" : "Approve request"
                    : pendingAction.status === "pending_hr" ? "Final reject request" : "Reject request"}
              </h3>
              <p className="mt-2 text-[13px] font-medium leading-5 text-slate-600">
                {pendingAction.kind === "delete"
                  ? `This removes ${vacationRequestDisplayId(pendingAction.row.id)} from the master report. The admin audit log keeps the deleted record context.`
                  : "This records the workflow decision and notifies the next responsible people."}
              </p>
              {pendingAction.kind === "decision" && pendingAction.decision === "reject" ? (
                <label className="mt-3 block space-y-1.5">
                  <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Rejection reason</span>
                  <textarea
                    className="min-h-24 w-full rounded-sm border border-slate-200 bg-white px-3 py-2 text-[13px] font-medium text-slate-800 outline-none transition focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                    value={decisionComment}
                    onChange={(event) => setDecisionComment(event.target.value)}
                  />
                </label>
              ) : null}
              <div className="mt-4 flex justify-end gap-2">
                <Button
                  className="rounded-sm border border-slate-200 bg-white text-[12px] font-bold text-slate-700 hover:bg-slate-50"
                  onClick={() => setPendingAction(null)}
                  type="button"
                >
                  Cancel
                </Button>
                <Button
                  className={cn(
                    "rounded-sm text-[12px] font-bold text-white",
                    pendingAction.kind === "delete" || (pendingAction.kind === "decision" && pendingAction.decision === "reject")
                      ? "bg-rose-600 hover:bg-rose-700"
                      : "bg-emerald-600 hover:bg-emerald-700",
                  )}
                  disabled={Boolean(actingId)}
                  onClick={() => void confirmPendingAction()}
                  type="button"
                >
                  Confirm
                </Button>
              </div>
            </div>
          </div>
        ) : null}

        <div
          className="flex w-full gap-0.5 overflow-x-auto rounded-sm border border-slate-200 bg-slate-50 p-0.5"
          role="tablist"
          aria-label="Vacation report tabs"
        >
          {tabItems.map((tab) => {
            const active = activeTab === tab.value;
            return (
              <button
                aria-selected={active}
                className={cn(
                  "flex h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-sm px-3 text-[13px] font-bold transition",
                  active ? "bg-white text-orange-600 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-700",
                )}
                key={tab.value}
                role="tab"
                type="button"
                onClick={() => switchTab(tab.value)}
              >
                {tab.label}
                <span className={cn(
                  "inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 text-[10px] font-bold",
                  active ? "bg-orange-100 text-orange-700" : "bg-slate-200 text-slate-600",
                )}>
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Filters ────────────────────────────────────────────── */}
        <FilterPanel filterCount={activeFilterCount} onApply={applyFilters}>
          <label className="space-y-1.5 xs:col-span-2">
            <span className={labelClass}>Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
              <Input
                className="rounded-sm pl-9"
                placeholder="Name, HR ID, department..."
                value={filters.search}
                onChange={(event) => updateFilter("search", event.target.value)}
              />
            </div>
          </label>

          {showRequestsTab ? (
            <>
              <label className="space-y-1.5">
                <span className={labelClass}>Request ID</span>
                <Input className="rounded-sm" placeholder="VAC-XXXX" value={filters.requestId} onChange={(event) => updateFilter("requestId", event.target.value)} />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Status</span>
                <select className={selectClass} value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
                  <option value="all">All statuses</option>
                  {VACATION_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Payment</span>
                <select className={selectClass} value={filters.paymentStatus} onChange={(event) => updateFilter("paymentStatus", event.target.value)}>
                  <option value="all">All payment</option>
                  {VACATION_PAYMENT_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Type</span>
                <select className={selectClass} value={filters.vacationType} onChange={(event) => updateFilter("vacationType", event.target.value)}>
                  <option value="all">All types</option>
                  {VACATION_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
            </>
          ) : null}

          <label className="space-y-1.5">
            <span className={labelClass}>Employee</span>
            <select className={selectClass} value={filters.employee} onChange={(event) => updateFilter("employee", event.target.value)}>
              <option value="">All employees</option>
              {(options?.employees ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className={labelClass}>Manager</span>
            <select className={selectClass} value={filters.manager} onChange={(event) => updateFilter("manager", event.target.value)}>
              <option value="">All managers</option>
              {(options?.managers ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className={labelClass}>Department</span>
            <select className={selectClass} value={filters.department} onChange={(event) => updateFilter("department", event.target.value)}>
              <option value="">All departments</option>
              {(options?.departments ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
          <label className="space-y-1.5">
            <span className={labelClass}>Line</span>
            <select className={selectClass} value={filters.line} onChange={(event) => updateFilter("line", event.target.value)}>
              <option value="">All lines</option>
              {(options?.lines ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>

          {showRequestsTab ? (
            <>
              <label className="space-y-1.5">
                <span className={labelClass}>From</span>
                <Input className="rounded-sm" type="date" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>To</span>
                <Input className="rounded-sm" type="date" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} />
              </label>
              {/* Date presets */}
              <div className="space-y-1.5 xs:col-span-2 md:col-span-3 xl:col-span-4">
                <span className={labelClass}>Quick date range</span>
                <div className="flex flex-wrap gap-1.5">
                  {DATE_PRESETS.map((preset) => (
                    <button
                      className="rounded-sm border border-slate-200 bg-white px-3 py-1.5 text-[11px] font-bold text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
                      key={preset.value}
                      onClick={() => applyDatePreset(preset.value)}
                      type="button"
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </FilterPanel>

        {/* ══════════════════════════════════════════════════════════ */}
        {/* ── ENTITLEMENTS TAB ──────────────────────────────────── */}
        {/* ══════════════════════════════════════════════════════════ */}

        {showEntitlementsTab ? (
          <div className="space-y-3">
            {/* Metric cards */}
            {!initialData ? (
              <div className="grid gap-2 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                {[0, 1, 2, 3, 4].map((i) => <MetricCardSkeleton key={i} />)}
              </div>
            ) : (
              <div className="grid gap-2 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                <MetricCard
                  description="Active employees in your visible review scope."
                  label="Active employees"
                  tone="blue"
                  value={employeeEligibilitySummary?.activeEmployees ?? 0}
                />
                <MetricCard
                  description="Completed 6 months, can use paid annual leave."
                  label="Eligible now"
                  tone="emerald"
                  value={employeeEligibilitySummary?.eligibleNow ?? 0}
                />
                <MetricCard
                  description="Still inside the first 6 months of service."
                  label="First 6 months"
                  tone="orange"
                  value={employeeEligibilitySummary?.inFirstSixMonths ?? 0}
                />
                <MetricCard
                  description="Need HR data correction before eligibility."
                  label="Missing hire date"
                  tone="rose"
                  value={employeeEligibilitySummary?.missingHireDate ?? 0}
                />
                <MetricCard
                  description="Eligible employees with no paid balance left."
                  label="Zero balance"
                  tone="violet"
                  value={employeeEligibilitySummary?.zeroBalance ?? 0}
                />
              </div>
            )}

            {/* Eligibility distribution bar */}
            {employeeEligibilitySummary ? (
              <EligibilityDistributionBar
                eligible={employeeEligibilitySummary.eligibleNow}
                firstSixMonths={employeeEligibilitySummary.inFirstSixMonths}
                missingHireDate={employeeEligibilitySummary.missingHireDate}
                total={employeeEligibilitySummary.activeEmployees}
              />
            ) : null}

            {/* Table header */}
            <div className="rounded-sm border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-600">
                      {canAdminManage ? "Master review" : "Visible scope review"}
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-slate-900">Employee leave entitlements</h3>
                    <p className="mt-0.5 text-[12px] font-medium leading-5 text-slate-500">
                      Tracks visible employees against the 6-month rule and current annual leave balance.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="w-fit border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">
                      {employeeEligibility.length} records
                    </Badge>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => exportEntitlementsCSV(sortedEntitlements)}
                      title="Export to CSV"
                      type="button"
                    >
                      <Download className="h-3 w-3" /> CSV
                    </button>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => window.print()}
                      title="Print report"
                      type="button"
                    >
                      <Printer className="h-3 w-3" /> Print
                    </button>
                  </div>
                </div>
              </div>

              {/* Desktop table (xs+) */}
              <div className="hidden xs:block overflow-x-auto">
                <table className="w-full border-collapse text-left text-[12px]">
                  <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <SortableHeader active={entitlementSort === "hrId"} direction={entitlementSortDir} sortKey="hrId" onSort={toggleEntitlementSort}>HR ID</SortableHeader>
                      <SortableHeader active={entitlementSort === "fullName"} direction={entitlementSortDir} sortKey="fullName" onSort={toggleEntitlementSort}>Employee</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Hire Date</th>
                      <SortableHeader active={entitlementSort === "daysSinceHire"} direction={entitlementSortDir} sortKey="daysSinceHire" onSort={toggleEntitlementSort}>Since Hire</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">6-Mo Date</th>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Eligibility</th>
                      <SortableHeader active={entitlementSort === "annualBalanceDays"} direction={entitlementSortDir} sortKey="annualBalanceDays" onSort={toggleEntitlementSort}>Balance</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Manager</th>
                      <th className="border-b border-slate-100 px-3 py-2.5">Review</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedEntitlements.map((row) => (
                      <tr key={row.hrId} className="bg-white transition hover:bg-emerald-50/30">
                        <td className="border-r border-slate-100 px-3 py-2.5 font-mono text-[12px] font-bold text-slate-900">{row.hrId}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-bold text-slate-900">{row.fullName}</p>
                          <p className="mt-0.5 text-[11px] font-medium text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}</p>
                          <p className="text-[11px] text-slate-400">{row.employmentStatus ?? "-"}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-700">{formatDate(row.hireDate)}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5 text-center font-bold text-slate-800">{row.daysSinceHire ?? "-"}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-700">{formatDate(row.sixMonthAnniversary)}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <Badge variant={eligibilityBadgeVariant(row.eligibilityStatus)}>
                            {eligibilityStatusLabel(row.eligibilityStatus)}
                          </Badge>
                          {row.eligibilityStatus === "first_six_months" && (row.daysUntilEligibility ?? 0) > 0 ? (
                            <p className="mt-1 text-[11px] font-bold text-amber-700">{row.daysUntilEligibility} days left</p>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-bold text-slate-900">{formatDays(row.annualBalanceDays)} left</p>
                          <p className="mt-0.5 text-[11px] font-medium text-slate-500">
                            {formatDays(row.annualEntitlementDays)} total / {formatDays(row.annualUsedDays)} used
                          </p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-semibold text-slate-700">{row.managerName ?? "-"}</p>
                          <p className="text-[11px] text-slate-400">{row.managerHrId ?? ""}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          {row.reviewFlags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {row.reviewFlags.map((flag) => (
                                <Badge key={flag} variant="warning">{flag}</Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-[11px] font-bold text-emerald-600">No issue</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {paginatedEntitlements.length === 0 ? (
                      <tr>
                        <td className="border-b border-slate-100 px-4 py-8 text-center text-[13px] font-medium text-slate-500" colSpan={9}>
                          No active employees matched the current filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <PaginationControls page={entitlementPage} pageSize={PAGE_SIZE} total={sortedEntitlements.length} onPageChange={setEntitlementPage} />
              </div>

              {/* Mobile card view (< xs) */}
              <div className="block xs:hidden space-y-2 p-3">
                {paginatedEntitlements.length === 0 ? (
                  <p className="py-6 text-center text-[13px] font-medium text-slate-500">
                    No active employees matched the current filters.
                  </p>
                ) : (
                  paginatedEntitlements.map((row) => (
                    <EntitlementCard key={row.hrId} row={row} />
                  ))
                )}
                <PaginationControls page={entitlementPage} pageSize={PAGE_SIZE} total={sortedEntitlements.length} onPageChange={setEntitlementPage} />
              </div>
            </div>
          </div>
        ) : null}

        {/* ══════════════════════════════════════════════════════════ */}
        {/* ── REQUESTS TAB ─────────────────────────────────────── */}
        {/* ══════════════════════════════════════════════════════════ */}

        {showRequestsTab ? (
          <div className="space-y-3">
            {/* Metric cards */}
            {!initialData ? (
              <div className="grid gap-2 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                {[0, 1, 2, 3, 4].map((i) => <MetricCardSkeleton key={i} />)}
              </div>
            ) : (
              <div className="grid gap-2 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-5">
                <MetricCard
                  description="Visible requests after applied filters."
                  label="Total"
                  tone="blue"
                  value={summary?.total ?? 0}
                />
                <MetricCard
                  description="Awaiting manager or HR decision."
                  label="Pending"
                  tone="orange"
                  value={summary?.pending ?? 0}
                />
                <MetricCard
                  description="Approved by HR final review."
                  label="Approved"
                  tone="emerald"
                  value={summary?.approved ?? 0}
                />
                <MetricCard
                  description="Rejected by HR final review."
                  label="Rejected"
                  tone="rose"
                  value={summary?.rejected ?? 0}
                />
                <MetricCard
                  description={`${formatDays(summary?.paidDays ?? 0)} paid / ${formatDays(summary?.unpaidDays ?? 0)} unpaid days.`}
                  label="Days"
                  tone="violet"
                  value={`${formatDays((summary?.paidDays ?? 0) + (summary?.unpaidDays ?? 0))}`}
                />
              </div>
            )}

            {dashboard ? (
              <div className="grid gap-2 md:grid-cols-4">
                <div className="rounded-sm border border-slate-200 bg-white p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Pending by stage</p>
                  <p className="mt-1 text-xl font-black text-slate-900">{dashboard.pendingByStage.total}</p>
                  <p className="text-[11px] font-semibold text-slate-500">Manager {dashboard.pendingByStage.manager} / HR {dashboard.pendingByStage.hr}</p>
                </div>
                <div className="rounded-sm border border-slate-200 bg-white p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Overdue SLA</p>
                  <p className="mt-1 text-xl font-black text-rose-700">{dashboard.overdueBySla.total}</p>
                  <p className="text-[11px] font-semibold text-slate-500">Manager {dashboard.overdueBySla.manager} / HR {dashboard.overdueBySla.hr}</p>
                </div>
                <div className="rounded-sm border border-slate-200 bg-white p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Evidence review</p>
                  <p className="mt-1 text-xl font-black text-slate-900">{dashboard.evidence.pending + dashboard.evidence.needsFollowUp + dashboard.evidence.rejected}</p>
                  <p className="text-[11px] font-semibold text-slate-500">Pending {dashboard.evidence.pending} / rejected {dashboard.evidence.rejected}</p>
                </div>
                <div className="rounded-sm border border-slate-200 bg-white p-3">
                  <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Daily SLA run</p>
                  <p className="mt-1 text-xl font-black text-slate-900">{dashboard.dailyEscalationRunStatus.status}</p>
                  <p className="text-[11px] font-semibold text-slate-500">{dashboard.dailyEscalationRunStatus.runDate ?? "No run recorded"}</p>
                </div>
              </div>
            ) : null}

            {/* Distribution bars */}
            {summary ? (
              <div className="grid gap-2 md:grid-cols-2">
                <StatusDistributionBar
                  approved={summary.approved}
                  pending={summary.pending}
                  rejected={summary.rejected}
                  total={summary.total}
                />
                <PaidUnpaidBar
                  paidDays={summary.paidDays}
                  unpaidDays={summary.unpaidDays}
                />
              </div>
            ) : null}

            {/* Admin controls */}
            {canAdminManage ? (
              <div className="rounded-sm border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">Admin controls</p>
                    <h3 className="mt-1 text-base font-extrabold text-slate-900">Employee master requests</h3>
                  </div>
                  <Button
                    className="gap-2 rounded-sm bg-orange-500 px-4 py-2 text-[12px] font-bold text-white hover:bg-orange-600"
                    onClick={startAdminAdd}
                    type="button"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    Add Vacation
                  </Button>
                </div>

                {adminMode ? (
                  <div className="mt-4 grid gap-3 rounded-sm border border-orange-100 bg-orange-50/40 p-3 xs:grid-cols-2 xl:grid-cols-4">
                    <label className="space-y-1.5 xs:col-span-2">
                      <span className={labelClass}>Employee</span>
                      <select className={selectClass} value={adminForm.employeeHrId} onChange={(event) => updateAdminForm("employeeHrId", event.target.value)}>
                        <option value="">Select employee</option>
                        {(options?.employees ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Type</span>
                      <select className={selectClass} value={adminForm.vacationType} onChange={(event) => updateAdminForm("vacationType", event.target.value)}>
                        {(adminMode === "add" ? addVacationTypeOptions : editVacationTypeOptions).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Status</span>
                      <select className={selectClass} value={adminForm.status} onChange={(event) => updateAdminForm("status", event.target.value)}>
                        {VACATION_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Day part</span>
                      <select className={selectClass} value={adminForm.dayPart} onChange={(event) => updateAdminForm("dayPart", event.target.value)}>
                        {VACATION_DAY_PARTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>From</span>
                      <Input className="rounded-sm" type="date" value={adminForm.startDate} onChange={(event) => updateAdminForm("startDate", event.target.value)} />
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>To</span>
                      <Input className="rounded-sm" type="date" value={adminForm.endDate} onChange={(event) => updateAdminForm("endDate", event.target.value)} />
                    </label>
                    <label className="space-y-1.5 xs:col-span-2">
                      <span className={labelClass}>Admin note</span>
                      <Input className="rounded-sm" value={adminForm.notes} onChange={(event) => updateAdminForm("notes", event.target.value)} />
                    </label>
                    <div className="flex items-end gap-2 xs:col-span-2">
                      <Button
                        className="h-9 flex-1 rounded-sm bg-orange-500 text-[12px] font-bold text-white hover:bg-orange-600"
                        disabled={Boolean(actingId)}
                        onClick={submitAdminForm}
                        type="button"
                      >
                        {adminMode === "edit" ? "Save Changes" : "Create Vacation"}
                      </Button>
                      <Button
                        className="h-9 rounded-sm border border-slate-200 bg-white text-[12px] font-bold text-slate-700 hover:bg-slate-50"
                        disabled={Boolean(actingId)}
                        onClick={() => setAdminMode(null)}
                        type="button"
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Requests table */}
            <div className="rounded-sm border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
              <div className="border-b border-slate-100 px-4 py-3">
                <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">
                      {canAdminManage ? "Master ledger" : "Request history"}
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-slate-900">Vacation requests</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="w-fit border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.12em] text-slate-600">
                      {rows.length} requests
                    </Badge>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => exportRequestsCSV(sortedRequests)}
                      title="Export to CSV"
                      type="button"
                    >
                      <Download className="h-3 w-3" /> CSV
                    </button>
                    {canExport ? (
                      <a
                        className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-orange-200 bg-orange-50 px-2.5 text-[10px] font-bold text-orange-700 transition hover:bg-orange-100 print:hidden"
                        href={auditExportHref}
                        title="Audit-grade XLSX export"
                      >
                        <Download className="h-3 w-3" /> Audit XLSX
                      </a>
                    ) : null}
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => window.print()}
                      title="Print report"
                      type="button"
                    >
                      <Printer className="h-3 w-3" /> Print
                    </button>
                  </div>
                </div>
              </div>

              {/* Desktop table (xs+) */}
              <div className="hidden xs:block overflow-x-auto">
                <table className="w-full border-collapse text-left text-[12px]">
                  <thead className="bg-slate-50 text-[10px] font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">ID</th>
                      <SortableHeader active={requestSort === "employeeName"} direction={requestSortDir} sortKey="employeeName" onSort={toggleRequestSort}>Employee</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Type</th>
                      <SortableHeader active={requestSort === "startDate"} direction={requestSortDir} sortKey="startDate" onSort={toggleRequestSort}>From</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">To</th>
                      <SortableHeader active={requestSort === "durationDays"} direction={requestSortDir} sortKey="durationDays" onSort={toggleRequestSort}>Days</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Payment</th>
                      <SortableHeader active={requestSort === "status"} direction={requestSortDir} sortKey="status" onSort={toggleRequestSort}>Status</SortableHeader>
                      <SortableHeader active={requestSort === "createdAt"} direction={requestSortDir} sortKey="createdAt" onSort={toggleRequestSort}>Submitted</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Manager</th>
                      <th className="border-b border-slate-100 px-3 py-2.5">{canAdminManage ? "Decision / Admin" : "Decision"}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedRequests.map((row) => (
                      <tr key={row.id} className="bg-white transition hover:bg-orange-50/30">
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <span className="font-mono text-[11px] font-bold text-slate-800" title={row.id}>{vacationRequestDisplayId(row.id)}</span>
                          <p className="mt-0.5 text-[10px] font-medium text-slate-400">{row.employeeHrId}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-bold text-slate-900">{row.employeeName}</p>
                          <p className="mt-0.5 text-[11px] font-medium text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-semibold text-slate-800">{vacationTypeLabel(row.vacationType)}</p>
                          <p className="text-[11px] text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
                          {row.vacationType === "compensatory" ? (
                            <div className="mt-1.5 rounded-sm border border-orange-100 bg-orange-50/70 px-2 py-1.5 text-[10px] font-semibold leading-4 text-orange-900">
                              <p>{row.compensatoryEventName ?? "Event"}</p>
                              <p className="text-orange-700">{[row.compensatoryEventDate, row.compensatoryEventLocation].filter(Boolean).join(" / ")}</p>
                              <VacationAttachmentLinks canReviewAttachments={canReviewAttachments} row={row} />
                            </div>
                          ) : null}
                          {row.vacationType === "sick" ? <VacationAttachmentLinks canReviewAttachments={canReviewAttachments} row={row} /> : null}
                          {row.vacationType === "other" && row.notes ? (
                            <p className="mt-1.5 rounded-sm border border-amber-100 bg-amber-50/70 px-2 py-1.5 text-[10px] font-semibold leading-4 text-amber-900">{row.notes}</p>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-700">{formatDate(row.startDate)}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-semibold text-slate-700">{formatDate(row.endDate)}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5 text-center font-bold text-slate-900">{formatDays(row.durationDays)}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <Badge variant={paymentBadgeVariant(row.paymentStatus)}>
                            {paymentStatusLabel(row.paymentStatus)}
                          </Badge>
                          {row.paymentStatus === "partial" ? (
                            <p className="mt-1 text-[10px] font-bold text-amber-700">
                              {formatDays(row.paidDurationDays)} paid / {formatDays(row.unpaidDurationDays)} unpaid
                            </p>
                          ) : null}
                          {row.unpaidReason ? <p className="mt-1 text-[10px] font-bold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <Badge variant={statusBadgeVariant(row.status)}>{dynamicStatusLabel(row)}</Badge>
                          {row.slaStatus.isOverdue ? (
                            <p className="mt-1 text-[10px] font-bold text-rose-700">SLA overdue</p>
                          ) : null}
                          {row.overlapWarnings.length > 0 ? (
                            <p className="mt-1 text-[10px] font-bold text-amber-700">{row.overlapWarnings.length} warning(s)</p>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5 font-medium text-slate-600">{formatDateTime(row.createdAt)}</td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-semibold text-slate-700">{row.managerName ?? "-"}</p>
                          <p className="text-[11px] text-slate-400">{row.managerHrId ?? ""}</p>
                          {row.managerOfManagerName ? <p className="mt-0.5 text-[10px] text-slate-400">MoM: {row.managerOfManagerName}</p> : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <button
                            className="mb-2 flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50"
                            onClick={() => openRequestReview(row)}
                            type="button"
                          >
                            <FileText className="h-3 w-3" /> Timeline
                            {row.timelineEventCount > 0 ? <span className="text-slate-400">({row.timelineEventCount})</span> : null}
                          </button>
                          {canAdminManage ? (
                            <div className="mb-2 flex flex-wrap gap-1.5">
                              <button
                                className="flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2 py-1 text-[10px] font-bold text-slate-600 transition hover:bg-slate-50"
                                disabled={actingId === row.id}
                                onClick={() => startAdminEdit(row)}
                                type="button"
                              >
                                <Pencil className="h-3 w-3" /> Edit
                              </button>
                              <button
                                className="flex items-center gap-1 rounded-sm bg-rose-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-rose-700"
                                disabled={actingId === row.id}
                                onClick={() => deleteAdminRequest(row)}
                                type="button"
                              >
                                <Trash2 className="h-3 w-3" /> Delete
                              </button>
                            </div>
                          ) : null}
                          {row.canDecide ? (
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                className="flex items-center gap-1 rounded-sm bg-emerald-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-emerald-700"
                                disabled={actingId === row.id}
                                onClick={() => decide(row, "approve")}
                                type="button"
                              >
                                <CheckCircle2 className="h-3 w-3" />
                                {row.status === "pending_hr" ? "Final Approve" : "Approve"}
                              </button>
                              <button
                                className="flex items-center gap-1 rounded-sm bg-rose-600 px-2 py-1 text-[10px] font-bold text-white transition hover:bg-rose-700"
                                disabled={actingId === row.id}
                                onClick={() => decide(row, "reject")}
                                type="button"
                              >
                                <XCircle className="h-3 w-3" />
                                {row.status === "pending_hr" ? "Final Reject" : "Reject"}
                              </button>
                            </div>
                          ) : (
                            <div className="text-[11px]">
                              <p className="font-medium text-slate-600">{row.hrDecisionAt ? formatDateTime(row.hrDecisionAt) : row.managerDecisionAt ? formatDateTime(row.managerDecisionAt) : "-"}</p>
                              {row.managerDecisionComment ? <p className="mt-0.5 leading-4 text-slate-500">{row.managerDecisionComment}</p> : null}
                              {row.hrDecisionComment ? <p className="mt-0.5 leading-4 text-slate-500">{row.hrDecisionComment}</p> : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {paginatedRequests.length === 0 ? (
                      <tr>
                        <td className="border-b border-slate-100 px-4 py-8 text-center text-[13px] font-medium text-slate-500" colSpan={11}>
                          No vacation requests found.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <PaginationControls page={requestPage} pageSize={PAGE_SIZE} total={sortedRequests.length} onPageChange={setRequestPage} />
              </div>

              {/* Mobile card view (< xs) */}
              <div className="block xs:hidden space-y-2 p-3">
                {paginatedRequests.length === 0 ? (
                  <p className="py-6 text-center text-[13px] font-medium text-slate-500">
                    No vacation requests found.
                  </p>
                ) : (
                  paginatedRequests.map((row) => (
                    <RequestCard
                      key={row.id}
                      actingId={actingId}
                      canAdminManage={canAdminManage}
                      canReviewAttachments={canReviewAttachments}
                      onDecide={decide}
                      onDelete={deleteAdminRequest}
                      onEdit={startAdminEdit}
                      onReview={openRequestReview}
                      row={row}
                    />
                  ))
                )}
                <PaginationControls page={requestPage} pageSize={PAGE_SIZE} total={sortedRequests.length} onPageChange={setRequestPage} />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {selectedRequest ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 p-3 print:hidden" role="dialog" aria-modal="true">
          <div className="flex h-full w-full max-w-xl flex-col overflow-hidden rounded-sm bg-white shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-orange-600">Request review</p>
                <h3 className="mt-1 text-lg font-black text-slate-900">{vacationRequestDisplayId(selectedRequest.id)}</h3>
                <p className="text-[12px] font-semibold text-slate-500">{selectedRequest.employeeName} / {dynamicStatusLabel(selectedRequest)}</p>
              </div>
              <button className="rounded-sm p-2 text-slate-500 hover:bg-slate-100" onClick={() => setSelectedRequest(null)} type="button">
                <XCircle className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {selectedRequest.overlapWarnings.length > 0 ? (
                <div className="rounded-sm border border-amber-200 bg-amber-50 p-3">
                  <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-amber-700">Overlap intelligence</p>
                  <div className="mt-2 space-y-1.5">
                    {selectedRequest.overlapWarnings.map((warning) => (
                      <p className="text-[12px] font-semibold text-amber-900" key={`${warning.code}-${warning.relatedRequestIds.join("-")}`}>{warning.message}</p>
                    ))}
                  </div>
                </div>
              ) : null}

              {(selectedRequest.vacationType === "sick" || selectedRequest.vacationType === "compensatory") && canReviewAttachments ? (
                <div className="rounded-sm border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Evidence review</p>
                      <p className="mt-1 text-[12px] font-semibold text-slate-600">
                        Current: {selectedRequest.evidenceReviews[0]?.status ?? "pending"}
                      </p>
                    </div>
                    <VacationAttachmentLinks canReviewAttachments={canReviewAttachments} row={selectedRequest} />
                  </div>
                  <textarea
                    className="mt-3 min-h-20 w-full rounded-sm border border-slate-200 px-3 py-2 text-sm outline-none focus:border-orange-300"
                    onChange={(event) => setEvidenceReviewNote(event.target.value)}
                    placeholder="HR review note"
                    value={evidenceReviewNote}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button className="h-8 rounded-sm bg-emerald-600 text-[11px] font-bold text-white hover:bg-emerald-700" disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("accepted")} type="button">Accept</Button>
                    <Button className="h-8 rounded-sm bg-amber-500 text-[11px] font-bold text-white hover:bg-amber-600" disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("needs_follow_up")} type="button">Needs follow-up</Button>
                    <Button className="h-8 rounded-sm bg-rose-600 text-[11px] font-bold text-white hover:bg-rose-700" disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("rejected")} type="button">Reject</Button>
                  </div>
                </div>
              ) : null}

              <div className="rounded-sm border border-slate-200 p-3">
                <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-slate-500">Approval timeline</p>
                {timelineLoading ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">Loading timeline...</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {timeline.map((event) => (
                      <div className="border-l-2 border-orange-200 pl-3" key={event.id}>
                        <p className="text-[12px] font-black text-slate-900">{event.message}</p>
                        <p className="mt-0.5 text-[11px] font-semibold text-slate-500">{formatDateTime(event.createdAt)} / {event.eventType}</p>
                      </div>
                    ))}
                    {timeline.length === 0 ? <p className="text-sm font-semibold text-slate-500">No timeline events recorded yet.</p> : null}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </PageContainer>
  );
}
