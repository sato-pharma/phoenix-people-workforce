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
  ArrowRight,
  ArrowUp,
  ArrowUpDown,
  CalendarDays,
  ChevronDown,
  Download,
  FileText,
  Filter,
  Plus,
  Printer,
  Search,
  Table2,
  XCircle,
} from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

import { AdminCallout, AdminPageHero } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PaginationControls } from "@/components/ui/pagination-controls";
import { WorkspaceErrorBoundary } from "@/components/ui/workspace-error-boundary";
import { PageContainer } from "@/components/layout/page-container";
import { VacationAttachmentHistory } from "@/components/vacation/vacation-attachment-history";
import { ReturnedRequestPanel, type ReturnedRequestEdits } from "@/components/vacation/returned-request-panel";
import {
  vacationDayPartLabel,
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
import { cairoDateTime12h, utcDate } from "@/lib/format/cairo-datetime";
import { overlapWarningsLabel, showsDailySlaRunCard, vacationDaysLabel } from "@/lib/vacation/report-display";
import { CSV_BOM, csvLine } from "@/lib/export/spreadsheet-safe";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  phxButtonApproveDenseClassName,
  phxButtonDangerDenseClassName,
  phxLabelTextClassName,
  phxSelectClassName,
  phxTextareaClassName,
} from "@/components/ui/form-tokens";


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

function formatDays(days: number) {
  return `${Number(days.toFixed(2))}`;
}

/**
 * The timeline's event type is a stored code (`manager_approved`, `hr_rejected`). The owner's rule is
 * human-readable text everywhere, never a raw code, so the code is spoken as words — the sentence
 * above it (`event.message`) already carries the detail.
 */
function timelineEventLabel(eventType: string) {
  const words = eventType.replace(/[_-]+/g, " ").trim().toLowerCase();
  if (!words) return "";
  return (words.charAt(0).toUpperCase() + words.slice(1)).replace(/\bhr\b/gi, "HR");
}

// DATE-ONLY (leave start/end days, `date` columns — formatDateTime below takes a real instant), which
// `new Date` parses as UTC midnight. UTC here is CORRECT and must stay: it is what stops the calendar
// day being shifted by a zone offset. Not an instant — do not "fix" this one to Cairo. Built from
// digits by utcDate ("08 Oct 2026"), the platform's one date-only format, never by asking the browser.
function formatDate(value: string | null | undefined) {
  if (!value) return "-";
  const shown = utcDate(value.slice(0, 10));
  return shown === "—" ? value : shown;
}

// An INSTANT, shown in Cairo. Built from digits (cairoDateTime12h), never by asking the browser:
// an iPhone puts a narrow no-break space before "PM" where the server puts a plain one, and the page
// re-renders this text in the browser, so the two disagreed (System Audit APP-C3275308).
function formatDateTime(value: string | null | undefined) {
  return cairoDateTime12h(value);
}

function statusBadgeVariant(status: VacationRequestStatus) {
  if (status === "approved") return "success";
  if (status === "rejected") return "danger";
  if (status === "returned") return "warning";
  if (status === "cancelled") return "neutral";
  return "warning";
}

function statusLabel(status: VacationRequestStatus) {
  if (status === "needs_assignment") return "Needs HR Assignment";
  if (status === "pending_manager") return "Pending Manager";
  if (status === "pending_hr") return "Pending HR";
  if (status === "approved") return "Approved";
  if (status === "cancelled") return "Closed";
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
          className="inline-flex items-center gap-1 rounded-sm border border-sky-200 bg-sky-50 px-2 py-1 text-phx-2xs font-bold text-sky-700 transition hover:border-sky-300 hover:bg-sky-100"
          href={attachment.href}
          key={attachment.href}
          rel="noreferrer"
          target="_blank"
          title={attachment.label}
        >
          <FileText className="h-3 w-3" />
          {/* The count, so a request carrying several documents says so in the list rather than
              looking identical to one carrying a single file. The dated history is in the drawer. */}
          {row.attachments.length > 1 ? `Evidence (${row.attachments.length})` : "Evidence"}
        </a>
      ))}
    </div>
  );
}

/**
 * The desktop table's evidence cell: EVERY document with the date it arrived, which is what the
 * admin asked to read off this screen ("3 October he uploaded this, by 10 October he uploaded
 * those"). One file renders one line, so a single-document request is no taller than the chip it
 * replaces. Read-only here — adding files is the drawer and the request page.
 *
 * Falls back to the single legacy chip when the history is empty: an older request, or an
 * environment the attachments migration has not reached yet.
 */
function RowEvidence({
  canReviewAttachments,
  row,
}: {
  canReviewAttachments: boolean;
  row: VacationRequestRecord;
}) {
  if (!canReviewAttachments) return null;
  if (row.attachments.length === 0) {
    return <VacationAttachmentLinks canReviewAttachments={canReviewAttachments} row={row} />;
  }
  return (
    <div className="mt-1.5">
      <VacationAttachmentHistory
        attachments={row.attachments}
        canUpload={false}
        kind={row.vacationType === "compensatory" ? "compensatory" : "sick"}
        requestId={row.id}
      />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── CSV Export ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

// Every cell goes through the shared spreadsheet guard (`csvLine`): it quotes a comma, quote or line
// break AND neutralises a formula lead (= + - @), because names, departments and review flags are typed
// text and HR opens the file in Excel. Numbers pass through as numbers, so a negative balance stays one.
function downloadCsv(filename: string, csvContent: string) {
  const blob = new Blob([CSV_BOM + csvContent], { type: "text/csv;charset=utf-8;" });
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
  const rows = data.map((r) => csvLine([
    r.hrId, r.displayName, r.departmentName, r.lineName,
    r.hireDate, r.daysSinceHire, r.sixMonthAnniversary,
    eligibilityStatusLabel(r.eligibilityStatus),
    r.annualEntitlementDays, r.annualUsedDays, r.annualBalanceDays,
    r.managerName, r.reviewFlags.join("; "),
  ]));
  downloadCsv(`entitlements-${new Date().toISOString().slice(0, 10)}.csv`, [csvLine(header), ...rows].join("\n"));
}

function exportRequestsCSV(data: VacationRequestRecord[]) {
  const header = ["Request ID", "HR ID", "Employee", "Department", "Line", "Type", "Day Part", "Start", "End", "Duration", "Balance Before", "Balance After", "Status", "Payment", "Paid Days", "Unpaid Days", "Submitted", "Manager"];
  const rows = data.map((r) => csvLine([
    r.requestCode, r.employeeHrId, r.employeeName,
    r.departmentName, r.lineName, vacationTypeLabel(r.vacationType),
    vacationDayPartLabel(r.dayPart), r.startDate, r.endDate,
    r.durationDays, r.balanceBeforeDays, r.balanceAfterDays,
    statusLabel(r.status), paymentStatusLabel(r.paymentStatus),
    r.paidDurationDays, r.unpaidDurationDays,
    r.createdAt, r.managerName,
  ]));
  downloadCsv(`vacation-requests-${new Date().toISOString().slice(0, 10)}.csv`, [csvLine(header), ...rows].join("\n"));
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

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Select with focus trap ──────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

const selectClass  = phxSelectClassName;

const labelClass = phxLabelTextClassName;

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
      <p className={cn("text-phx-2xs font-bold uppercase tracking-[0.12em]", t.label)}>
        {label}
      </p>
      <p className={cn("mt-1.5 text-[1.75rem] font-extrabold leading-none tracking-[-0.04em]", t.value)}>
        {value}
      </p>
      <p className="mt-2 text-phx-xs font-medium leading-4 text-slate-500">{description}</p>
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
        <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Request status distribution</p>
        <p className="text-phx-xs font-bold text-slate-400">{total} total</p>
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
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-2xs font-bold uppercase tracking-[0.08em]">
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
        <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Eligibility distribution</p>
        <p className="text-phx-xs font-bold text-slate-400">{total} employees</p>
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
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-2xs font-bold uppercase tracking-[0.08em]">
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
        <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Paid vs Unpaid days</p>
        <p className="text-phx-xs font-bold text-slate-400">{formatDays(total)} total</p>
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
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-2xs font-bold uppercase tracking-[0.08em]">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-emerald-500" />
          <span className="text-emerald-700">Paid {vacationDaysLabel(paidDays)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-sm bg-amber-500" />
          <span className="text-amber-700">Unpaid {vacationDaysLabel(unpaidDays)}</span>
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
          <span className="text-phx-md font-bold text-slate-800">Filters</span>
          {filterCount > 0 ? (
            <Badge className="border border-orange-200 bg-orange-50 px-1.5 py-0.5 text-phx-2xs font-bold text-orange-700">
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
              className="h-9 gap-2 rounded-sm bg-orange-500 px-4 text-phx-sm font-bold text-white hover:bg-orange-600"
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
          <p className="text-phx-md font-bold text-slate-900">{row.displayName}</p>
          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
            {[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}
          </p>
        </div>
        <Badge variant={eligibilityBadgeVariant(row.eligibilityStatus)}>
          {eligibilityStatusLabel(row.eligibilityStatus)}
        </Badge>
      </div>

      <div className="mt-2.5 grid grid-cols-3 gap-2">
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Hire date</p>
          <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{formatDate(row.hireDate)}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Since hire</p>
          <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{row.daysSinceHire == null ? "-" : vacationDaysLabel(row.daysSinceHire)}</p>
        </div>
        <div>
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">6-mo date</p>
          <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{formatDate(row.sixMonthAnniversary)}</p>
        </div>
      </div>

      {/* Balance bar */}
      <div className="mt-2.5">
        <div className="flex items-center justify-between text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">
          <span>Used {formatDays(row.annualUsedDays)}</span>
          <span>of {formatDays(row.annualEntitlementDays)}</span>
        </div>
        <div className="mt-1 h-2 w-full overflow-hidden rounded-sm bg-slate-100">
          <div
            className={cn("h-full bg-gradient-to-r transition-all duration-500", barColor)}
            style={{ width: `${usedPct}%` }}
          />
        </div>
        <p className="mt-1 text-phx-sm font-extrabold text-slate-900">{vacationDaysLabel(row.annualBalanceDays)} remaining</p>
      </div>

      {row.eligibilityStatus === "first_six_months" && (row.daysUntilEligibility ?? 0) > 0 ? (
        <p className="mt-1.5 text-phx-xs font-bold text-amber-700">{vacationDaysLabel(row.daysUntilEligibility ?? 0)} until eligible</p>
      ) : null}

      {row.managerName ? (
        <p className="mt-1.5 text-phx-xs font-medium text-slate-500">Manager: {row.managerName}</p>
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
/* ─── Own-leave panel (a viewer whose scope is only themselves) ────── */
/* ═══════════════════════════════════════════════════════════════════ */

function SelfLeaveFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 bg-white px-3 py-2.5">
      <dt className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">{label}</dt>
      <dd className={cn("mt-0.5 break-words text-phx-md font-bold text-slate-900", tone)}>{value}</dd>
    </div>
  );
}

/**
 * Deductions the Super Admin took from annual leave instead of salary (Deductions → "Deduct from leave
 * balance", owner 2026-10-09), each with the comment he wrote — shown exactly as written. These days are
 * already inside "Used" above. A failed read says so rather than printing an empty list.
 */
function LeaveBalanceDeductionsPanel({
  data,
  isSelfView,
}: {
  data: NonNullable<VacationReportData["leaveBalanceDeductions"]>;
  isSelfView: boolean;
}) {
  if (!data.failed && data.rows.length === 0) return null;
  return (
    <section className="mt-2 min-w-0 rounded-sm border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-5">
      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">
        {isSelfView ? "Taken from your annual leave" : "Deductions taken from annual leave"}
      </p>
      {data.failed ? (
        <p className="mt-2 text-phx-sm font-semibold text-amber-700">
          The deductions taken from annual leave could not be read right now. Reload the page to try again.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100">
          {data.rows.map((row) => (
            <li className="py-3 first:pt-0 last:pb-0" key={`${row.employeeHrId}-${row.workDate}-${row.chargedAt}`}>
              <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-phx-sm font-bold text-slate-900">
                {isSelfView ? null : <span>{row.employeeName}</span>}
                {/*
                  Said beside the NAME, because that is what it is about. Not in the self view: a
                  leaver cannot sign in anyway, and "you have left the company" is not something to
                  print in somebody's own report. Both dates are date-only and read "23 Sept 2026",
                  the same formatDate the rest of the report uses.
                */}
                {!isSelfView && row.employeeHasLeft ? (
                  <span className="font-semibold text-amber-700">
                    left the company{row.lastWorkingDate ? ` ${formatDate(row.lastWorkingDate)}` : ""}
                  </span>
                ) : null}
                <span className="tabular-nums text-slate-600">{formatDate(row.workDate)}</span>
                <span className="text-sky-800">
                  {vacationDaysLabel(row.days)} from annual leave
                </span>
              </p>
              <p className="mt-1 whitespace-pre-wrap break-words text-phx-sm leading-5 text-slate-700">{row.comment}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The Entitlements tab for a viewer who can see nobody but themselves — every Medical Rep, and any
 * employee without a team. The team report it replaces for them (five population counters, an
 * eligibility distribution drawn over one person, a nine-column register holding one row, and an
 * Employee and a Manager column that always named the same two people) answered no question an
 * employee asks about their own leave. This answers the three they do: how many days are left, can
 * I use them yet, and where are my requests. Every figure is the same row the table printed.
 */
function SelfLeaveBalancePanel({
  requestHref,
  requestsHref,
  row,
}: {
  requestHref: string;
  requestsHref: string;
  row: VacationEmployeeEligibilityRow | null;
}) {
  if (!row) {
    return (
      <div className="rounded-sm border border-slate-200 bg-white px-4 py-8 text-center shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
        <CalendarDays className="mx-auto h-6 w-6 text-slate-300" />
        <p className="mt-3 text-phx-md font-bold text-slate-900">Your leave balance is not available yet</p>
        <p className="mx-auto mt-1 max-w-md text-phx-sm font-medium leading-5 text-slate-500">
          HR needs your employee record complete before it can be calculated. Ask them through Request Support.
        </p>
      </div>
    );
  }

  const hasEntitlement = row.annualEntitlementDays > 0;
  const usedPct = hasEntitlement ? Math.min((row.annualUsedDays / row.annualEntitlementDays) * 100, 100) : 0;
  const remainPct = 100 - usedPct;
  const tone = !hasEntitlement
    ? { bar: "from-slate-400 to-slate-300", rail: "bg-slate-300", text: "text-slate-700" }
    : remainPct >= 60
      ? { bar: "from-emerald-600 to-emerald-300", rail: "bg-emerald-500", text: "text-emerald-700" }
      : remainPct >= 30
        ? { bar: "from-amber-500 to-amber-300", rail: "bg-amber-500", text: "text-amber-700" }
        : { bar: "from-rose-600 to-rose-300", rail: "bg-rose-500", text: "text-rose-700" };
  const daysUntilEligible = row.eligibilityStatus === "first_six_months" ? (row.daysUntilEligibility ?? 0) : 0;

  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <section className="min-w-0 rounded-sm border border-slate-200 bg-white shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
        <div aria-hidden="true" className={cn("h-0.5 w-full", tone.rail)} />
        <div className="p-4 sm:p-5">
          <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Annual leave left</p>
          <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className={cn("text-phx-3xl font-extrabold leading-none tracking-[-0.04em] tabular-nums", tone.text)}>
              {formatDays(row.annualBalanceDays)}
            </span>
            <span className="text-phx-md font-bold text-slate-500">
              {row.annualBalanceDays === 1 ? "day" : "days"}
            </span>
          </p>
          <div className="mt-4">
            <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-500">
              <span>Used {formatDays(row.annualUsedDays)}</span>
              <span>of {formatDays(row.annualEntitlementDays)} this leave year</span>
            </div>
            <div className="mt-1 h-2 w-full overflow-hidden rounded-sm bg-slate-100">
              <div className={cn("h-full bg-gradient-to-r transition-all duration-500", tone.bar)} style={{ width: `${usedPct}%` }} />
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <Link
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-sm bg-orange-500 px-4 text-phx-sm font-bold text-white transition hover:bg-orange-600"
              href={requestHref}
            >
              <CalendarDays className="h-3.5 w-3.5" />
              Request vacation
            </Link>
            <Link
              className="inline-flex min-h-10 items-center justify-center gap-2 rounded-sm border border-slate-200 bg-white px-4 text-phx-sm font-bold text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
              href={requestsHref}
            >
              My requests
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </div>
        </div>
      </section>

      <section className="min-w-0 rounded-sm border border-slate-200 bg-white p-4 shadow-[0_1px_3px_rgba(15,23,42,0.04)] sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Eligibility</p>
          <Badge variant={eligibilityBadgeVariant(row.eligibilityStatus)}>
            {eligibilityStatusLabel(row.eligibilityStatus)}
          </Badge>
        </div>
        {daysUntilEligible > 0 ? (
          <p className="mt-2 text-phx-md font-bold leading-5 text-amber-700">
            {daysUntilEligible} {daysUntilEligible === 1 ? "day" : "days"} until you can take paid annual leave
          </p>
        ) : null}
        <dl className="mt-3 grid grid-cols-2 gap-px border border-slate-100 bg-slate-100">
          <SelfLeaveFact label="Hire date" value={formatDate(row.hireDate)} />
          <SelfLeaveFact label="Six months on" value={formatDate(row.sixMonthAnniversary)} />
          <SelfLeaveFact label="Days since hire" value={row.daysSinceHire != null ? String(row.daysSinceHire) : "-"} />
          <SelfLeaveFact label="Manager" value={row.managerName ?? "Not assigned"} />
        </dl>
        {row.reviewFlags.length > 0 ? (
          <div className="mt-3 flex flex-wrap gap-1">
            {row.reviewFlags.map((flag) => (
              <Badge key={flag} variant="warning">{flag}</Badge>
            ))}
          </div>
        ) : null}
      </section>
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
  selfView = false,
  viewerHrId,
  approvalsBase,
  onResubmit,
  onReview,
  row,
}: {
  actingId: string | null;
  /** Where this surface's Leave Approvals request pages live — decisions are made there, never here. */
  approvalsBase: string;
  canAdminManage: boolean;
  canReviewAttachments: boolean;
  /**
   * The viewer is reading their OWN requests (see isSelfView in VacationReportInner). The card then
   * leads with the dates — the thing that identifies a request to the person who made it — instead
   * of their own name and HR ID repeated on every card.
   */
  selfView?: boolean;
  viewerHrId: string | null;
  onResubmit: (row: VacationRequestRecord, edits: ReturnedRequestEdits | null) => void;
  onReview: (row: VacationRequestRecord) => void;
  row: VacationRequestRecord;
}) {
  const dateRange = row.startDate === row.endDate ? formatDate(row.startDate) : `${formatDate(row.startDate)} to ${formatDate(row.endDate)}`;
  return (
    <div className="rounded-sm border border-slate-200 bg-white p-3 shadow-[0_1px_3px_rgba(15,23,42,0.04)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {selfView ? (
            <>
              <p className="text-phx-md font-bold text-slate-900">{dateRange}</p>
              <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                {vacationTypeLabel(row.vacationType)} · {vacationDayPartLabel(row.dayPart)} · {row.requestCode}
              </p>
            </>
          ) : (
            <>
              <p className="text-phx-md font-bold text-slate-900">{row.employeeName}</p>
              <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                {[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}
              </p>
              <p className="mt-0.5 text-phx-2xs font-medium text-slate-400">{row.requestCode}</p>
            </>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Badge variant={statusBadgeVariant(row.status)}>{dynamicStatusLabel(row)}</Badge>
          <Badge variant={paymentBadgeVariant(row.paymentStatus)}>{paymentStatusLabel(row.paymentStatus)}</Badge>
        </div>
      </div>

      {selfView ? (
        <div className="mt-2.5 grid grid-cols-2 gap-2">
          <div>
            <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Duration</p>
            <p className="mt-0.5 text-phx-sm font-extrabold text-slate-900">
              {formatDays(row.durationDays)} {row.durationDays === 1 ? "day" : "days"}
            </p>
          </div>
          <div>
            <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Balance</p>
            <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">
              {formatDays(row.balanceBeforeDays)} <span className="text-slate-400">&rarr;</span>{" "}
              <span className="font-bold text-slate-900">{formatDays(row.balanceAfterDays)}</span>
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <div>
              <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Type</p>
              <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{vacationTypeLabel(row.vacationType)}</p>
              <p className="text-phx-xs font-medium text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
            </div>
            <div>
              <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Duration</p>
              <p className="mt-0.5 text-phx-sm font-extrabold text-slate-900">{vacationDaysLabel(row.durationDays)}</p>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">From</p>
              <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{formatDate(row.startDate)}</p>
            </div>
            <div>
              <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">To</p>
              <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">{formatDate(row.endDate)}</p>
            </div>
          </div>
        </>
      )}

      {selfView ? null : (
        <div className="mt-2">
          <p className="text-phx-2xs font-bold uppercase tracking-[0.08em] text-slate-400">Balance</p>
          <p className="mt-0.5 text-phx-sm font-semibold text-slate-700">
            {formatDays(row.balanceBeforeDays)} <span className="text-slate-400">&rarr;</span>{" "}
            <span className="font-bold text-slate-900">{formatDays(row.balanceAfterDays)}</span>
          </p>
        </div>
      )}

      {row.paymentStatus === "partial" ? (
        <p className="mt-1.5 text-phx-xs font-bold text-amber-700">
          {formatDays(row.paidDurationDays)} paid / {formatDays(row.unpaidDurationDays)} unpaid
        </p>
      ) : null}
      {row.unpaidReason ? <p className="mt-1 text-phx-xs font-bold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}

      {row.vacationType === "compensatory" ? (
        <div className="mt-2 rounded-sm border border-orange-100 bg-orange-50/70 px-2.5 py-2 text-phx-xs font-semibold leading-4 text-orange-900">
          <p>{row.compensatoryEventName ?? "Compensatory event"}</p>
          <p className="text-orange-700">{[row.compensatoryEventDate, row.compensatoryEventLocation].filter(Boolean).join(" / ")}</p>
          <RowEvidence canReviewAttachments={canReviewAttachments} row={row} />
        </div>
      ) : null}
      {row.vacationType === "sick" ? <RowEvidence canReviewAttachments={canReviewAttachments} row={row} /> : null}
      {row.vacationType === "other" && row.notes ? (
        <p className="mt-2 rounded-sm border border-amber-100 bg-amber-50/70 px-2.5 py-2 text-phx-xs font-semibold leading-4 text-amber-900">
          {row.notes}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-phx-xs font-medium text-slate-500">
        <span>Submitted {formatDateTime(row.createdAt)}</span>
        {row.managerName ? <span>Manager: {row.managerName}</span> : null}
      </div>
      {(row.slaStatus.isOverdue || row.overlapWarnings.length > 0) ? (
        <div className="mt-2 flex flex-wrap gap-1">
          {row.slaStatus.isOverdue ? <Badge variant="danger">SLA overdue</Badge> : null}
          {row.overlapWarnings.length > 0 ? <Badge variant="warning">{overlapWarningsLabel(row.overlapWarnings.length)}</Badge> : null}
        </div>
      ) : null}
      {!canAdminManage ? (
        <button
          className="mt-2 flex items-center gap-1 text-phx-xs font-bold text-slate-500 transition hover:text-slate-700"
          onClick={() => onReview(row)}
          type="button"
        >
          {/* For a sick or compensatory request the drawer also holds the dated documents and the
              button that adds more to them, so the label has to say so or the employee never finds it. */}
          <FileText className="h-3 w-3" />{" "}
          {row.vacationType === "sick" || row.vacationType === "compensatory" ? "Documents & timeline" : "Timeline"}
        </button>
      ) : null}

      {/* A request sent back for editing: the employee who filed it can edit and resubmit, or resubmit as it stands */}
      {row.status === "returned" && viewerHrId && row.employeeHrId.toUpperCase() === viewerHrId.toUpperCase() ? (
        <ReturnedRequestPanel busy={actingId === row.id} onResubmit={onResubmit} row={row} />
      ) : null}

      {/* Decision info or action buttons */}
      {row.canDecide ? (
        <Link
          className="mt-2.5 flex items-center justify-center gap-1.5 rounded-sm border border-orange-300 bg-white px-3 py-1.5 text-phx-xs font-bold text-orange-700 transition hover:bg-orange-50"
          href={`${approvalsBase}/${encodeURIComponent(row.id)}`}
        >
          <ArrowRight className="h-3 w-3" /> Decide in Leave Approvals
        </Link>
      ) : (
        <div className="mt-2 text-phx-xs text-slate-500">
          {row.hrDecisionAt ? <p>HR: {formatDateTime(row.hrDecisionAt)}</p> : null}
          {row.managerDecisionAt ? <p>Manager: {formatDateTime(row.managerDecisionAt)}</p> : null}
          {row.managerDecisionComment ? <p className="text-slate-600">{row.managerDecisionComment}</p> : null}
          {row.hrDecisionComment ? <p className="text-slate-600">{row.hrDecisionComment}</p> : null}
        </div>
      )}

      {canAdminManage ? (
        <div className="mt-2 flex gap-2 border-t border-slate-100 pt-2">
          <button
            className="flex items-center gap-1 text-phx-xs font-bold text-slate-500 transition hover:text-slate-700"
            onClick={() => onReview(row)}
            type="button"
          >
            <FileText className="h-3 w-3" />{" "}
            {row.vacationType === "sick" || row.vacationType === "compensatory" ? "Documents & timeline" : "Timeline"}
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
  // Base navigation on the CURRENT route, not a hardcoded admin path. This component is rendered at
  // BOTH /leave-management/vacation-report (admin) AND /employee-portals/vacation-report (portal);
  // pushing a hardcoded admin URL from the portal bounces the user through the (admin) layout, which
  // redirects employee-portal users to /employee-portals (the landing page). Staying on `pathname`
  // keeps tab/filter/pagination navigation inside whichever surface the user is actually on.
  const pathname = usePathname();
  // The request pages in Leave Approvals, on whichever surface this report is on — a decision is made
  // there and never here.
  const approvalsBase = pathname?.startsWith("/employee-portals")
    ? "/employee-portals/approvals/vacation"
    : "/admin/approvals/vacation";
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
  const [adminMode, setAdminMode] = useState<"add" | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<VacationRequestRecord | null>(null);
  const [timeline, setTimeline] = useState<VacationTimelineEvent[]>([]);
  const [timelineLoading, setTimelineLoading] = useState(false);
  const [evidenceReviewNote, setEvidenceReviewNote] = useState("");

  /* ── Pagination state ────────────────────────────── */
  const [entitlementPage, setEntitlementPage] = useState(0);
  const [requestPage, setRequestPage] = useState(0);

  /* ── Sort state ──────────────────────────────────── */
  const [entitlementSort, setEntitlementSort] = useState<EntitlementSortKey>("fullName");
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
  const viewerHrId = initialData?.viewerHrId ?? null;
  // The employee reading HIS OWN request in the drawer: he may see every document he sent and add
  // more to them. The route checks the same thing server-side.
  const isOwnSelectedRequest = Boolean(
    selectedRequest && viewerHrId && selectedRequest.employeeHrId.toUpperCase() === viewerHrId.toUpperCase(),
  );
  // A viewer whose visible scope holds nobody but themselves — every Medical Rep, and any employee
  // without a team — is reading their OWN leave, not reviewing a population. `options.employees` is
  // built from the viewer's access scope, never from the active filters, so a manager who filters
  // down to one person keeps the report. Admins always keep it.
  const isSelfView = Boolean(initialData) && !canAdminManage && (options?.employees.length ?? 0) <= 1;
  const showEntitlementsTab = activeTab === "entitlements";
  const showRequestsTab = activeTab === "requests";
  const addVacationTypeOptions = VACATION_TYPES.filter((option) => option.value !== "sick" && option.value !== "compensatory");

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
    const base = pathname || "/leave-management/vacation-report";
    return `${base}${params.toString() ? `?${params}` : ""}`;
  }

  function switchTab(nextTab: VacationReportTab) {
    // A TAB IS NOT A PAGE LOAD (2026-10-01, "slow to transfer between page and page"). The server
    // never reads `tab` — all three pages that render this report build their filters from the other
    // params only — and `activeTab` is read from useSearchParams above, so router.push paid for a
    // whole server render of the report just to flip a tab. The native pushState is folded into the
    // App Router: useSearchParams picks up the new URL, the tab switches at once, the address and
    // Back button behave as before, and no request is made. Filters still go through router.push
    // (applyFilters below), because those the server does read.
    window.history.pushState(null, "", buildReportUrl(nextTab, searchParams));
  }

  // Editing and deleting a request are NOT done from this report (owner, 2026-10-08): they live on the
  // request's own page in the Leave Approvals hub. This report only records a new admin vacation.
  function startAdminAdd() {
    setAdminError(null);
    setAdminForm(emptyAdminVacationForm(options?.employees[0]?.value ?? ""));
    setAdminMode("add");
  }

  async function submitAdminForm() {
    setAdminError(null);
    setActingId("admin-add");
    try {
      const response = await fetch("/api/vacations/requests/admin", {
        body: JSON.stringify(adminForm),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Vacation admin update failed.");
      }
      setAdminMode(null);
      router.refresh();
    } catch (error) {
      setAdminError(error instanceof Error ? error.message : "Vacation admin update failed.");
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

  // Approve and Reject are NOT decided from this report (owner, 2026-10-08): a request waiting on the
  // viewer links to its page in Leave Approvals, which is the one place every leave decision is made.
  const resubmit = useCallback(async (row: VacationRequestRecord, edits: ReturnedRequestEdits | null) => {
    setActingId(row.id);
    setActionError(null);
    try {
      const response = await fetch(`/api/vacations/requests/${encodeURIComponent(row.id)}/resubmit`, {
        body: JSON.stringify(edits ? { edits } : {}),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Resubmit failed.");
      }
      router.refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Resubmit failed.");
    } finally {
      setActingId(null);
    }
  }, [router]);

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

  const tabItems: { count: number | null; label: string; value: VacationReportTab }[] = [
    {
      // A count of one row — the viewer — says nothing, so the own-leave tab carries none.
      count: isSelfView ? null : employeeEligibility.length,
      label: isSelfView ? "My Balance" : "Leave Entitlements",
      value: "entitlements" as const,
    },
    {
      count: rows.length,
      label: isSelfView ? "My Requests" : "All Requests",
      value: "requests" as const,
    },
  ];
  const selfRequestsHref = buildReportUrl("requests", new URLSearchParams());
  const vacationRequestHref = pathname?.startsWith("/employee-portals")
    ? "/employee-portals/vacation-request"
    : "/leave-management/vacation-request";

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

        {/* Two equal columns on a phone, never a sideways-scrolling strip: `overflow-x-auto` over
            nowrap tabs is the pattern the fits-the-screen rule names. A label that outgrows its half
            wraps inside the tab. From `sm` the strip is the content-width row it always was. */}
        <div
          className="grid w-full grid-cols-2 gap-0.5 rounded-sm border border-slate-200 bg-slate-50 p-0.5 sm:flex"
          role="tablist"
          aria-label="Vacation report tabs"
        >
          {tabItems.map((tab) => {
            const active = activeTab === tab.value;
            return (
              <button
                aria-selected={active}
                className={cn(
                  "flex min-h-9 items-center justify-center gap-2 rounded-sm px-3 py-1 text-center text-phx-md font-bold leading-tight transition sm:shrink-0 sm:whitespace-nowrap",
                  active ? "bg-white text-orange-600 shadow-sm" : "text-slate-500 hover:bg-white/70 hover:text-slate-700",
                )}
                key={tab.value}
                role="tab"
                type="button"
                onClick={() => switchTab(tab.value)}
              >
                {tab.label}
                {tab.count !== null ? (
                  <span className={cn(
                    "inline-flex h-5 min-w-5 items-center justify-center rounded-sm px-1 text-phx-2xs font-bold",
                    active ? "bg-orange-100 text-orange-700" : "bg-slate-200 text-slate-600",
                  )}>
                    {tab.count}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        {/* ── Filters ────────────────────────────────────────────── */}
        {/* Own-leave viewers get no filter panel on their balance (one row, nothing to narrow) and
            only Status / Type / dates on their requests: the employee, manager, department and line
            pickers each offer exactly one value to someone whose scope is themselves. */}
        {isSelfView && showEntitlementsTab ? null : (
        <FilterPanel filterCount={activeFilterCount} onApply={applyFilters}>
          {isSelfView ? null : (
            <label className="space-y-1.5 xs:col-span-2">
              <span className={labelClass}>Search</span>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
                <Input
                  className="pl-9"
                  placeholder="Name, HR ID, department..."
                  value={filters.search}
                  onChange={(event) => updateFilter("search", event.target.value)}
                />
              </div>
            </label>
          )}

          {showRequestsTab ? (
            <>
              {isSelfView ? null : (
                <label className="space-y-1.5">
                  <span className={labelClass}>Request ID</span>
                  <Input placeholder="VAC-XXXX" value={filters.requestId} onChange={(event) => updateFilter("requestId", event.target.value)} />
                </label>
              )}
              <label className="space-y-1.5">
                <span className={labelClass}>Status</span>
                <SearchableSelect className={selectClass} value={filters.status} onChange={(event) => updateFilter("status", event.target.value)}>
                  <option value="all">All statuses</option>
                  {VACATION_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </label>
              {isSelfView ? null : (
                <label className="space-y-1.5">
                  <span className={labelClass}>Payment</span>
                  <SearchableSelect className={selectClass} value={filters.paymentStatus} onChange={(event) => updateFilter("paymentStatus", event.target.value)}>
                    <option value="all">All payment</option>
                    {VACATION_PAYMENT_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </SearchableSelect>
                </label>
              )}
              <label className="space-y-1.5">
                <span className={labelClass}>Type</span>
                <SearchableSelect className={selectClass} value={filters.vacationType} onChange={(event) => updateFilter("vacationType", event.target.value)}>
                  <option value="all">All types</option>
                  {VACATION_TYPES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </label>
            </>
          ) : null}

          {isSelfView ? null : (
            <>
              <label className="space-y-1.5">
                <span className={labelClass}>Employee</span>
                <SearchableSelect className={selectClass} value={filters.employee} onChange={(event) => updateFilter("employee", event.target.value)}>
                  <option value="">All employees</option>
                  {(options?.employees ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Manager</span>
                <SearchableSelect className={selectClass} value={filters.manager} onChange={(event) => updateFilter("manager", event.target.value)}>
                  <option value="">All managers</option>
                  {(options?.managers ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </SearchableSelect>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Department</span>
                <SearchableSelect className={selectClass} value={filters.department} onChange={(event) => updateFilter("department", event.target.value)}>
                  <option value="">All departments</option>
                  {(options?.departments ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                </SearchableSelect>
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>Line</span>
                <SearchableSelect className={selectClass} value={filters.line} onChange={(event) => updateFilter("line", event.target.value)}>
                  <option value="">All lines</option>
                  {(options?.lines ?? []).map((option) => <option key={option} value={option}>{option}</option>)}
                </SearchableSelect>
              </label>
            </>
          )}

          {showRequestsTab ? (
            <>
              <label className="space-y-1.5">
                <span className={labelClass}>From</span>
                <Input type="date" value={filters.dateFrom} onChange={(event) => updateFilter("dateFrom", event.target.value)} />
              </label>
              <label className="space-y-1.5">
                <span className={labelClass}>To</span>
                <Input type="date" value={filters.dateTo} onChange={(event) => updateFilter("dateTo", event.target.value)} />
              </label>
              {/* Date presets */}
              <div className="space-y-1.5 xs:col-span-2 md:col-span-3 xl:col-span-4">
                <span className={labelClass}>Quick date range</span>
                <div className="flex flex-wrap gap-1.5">
                  {DATE_PRESETS.map((preset) => (
                    <button
                      className="rounded-sm border border-slate-200 bg-white px-3 py-1.5 text-phx-xs font-bold text-slate-700 transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-700"
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
        )}

        {/* ══════════════════════════════════════════════════════════ */}
        {/* ── ENTITLEMENTS TAB ──────────────────────────────────── */}
        {/* ══════════════════════════════════════════════════════════ */}

        {showEntitlementsTab && isSelfView ? (
          <SelfLeaveBalancePanel
            requestHref={vacationRequestHref}
            requestsHref={selfRequestsHref}
            row={employeeEligibility[0] ?? null}
          />
        ) : null}

        {showEntitlementsTab && initialData?.leaveBalanceDeductions ? (
          <LeaveBalanceDeductionsPanel data={initialData.leaveBalanceDeductions} isSelfView={isSelfView} />
        ) : null}

        {showEntitlementsTab && !isSelfView ? (
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
                    <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-emerald-600">
                      {canAdminManage ? "All entitlements" : "Visible scope review"}
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-slate-900">Employee leave entitlements</h3>
                    <p className="mt-0.5 text-phx-sm font-medium leading-5 text-slate-500">
                      Tracks visible employees against the 6-month rule and current annual leave balance.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="w-fit border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-600">
                      {employeeEligibility.length} records
                    </Badge>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-phx-2xs font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => exportEntitlementsCSV(sortedEntitlements)}
                      title="Export to CSV"
                      type="button"
                    >
                      <Download className="h-3 w-3" /> CSV
                    </button>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-phx-2xs font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => window.print()}
                      title="Print report"
                      type="button"
                    >
                      <Printer className="h-3 w-3" /> Print
                    </button>
                  </div>
                </div>
              </div>

              {/* Desktop table (xl+). table-fixed + colgroup so every column shares the
                  available width and the table never scrolls sideways — cards carry every
                  narrower viewport below. Columns are MERGED, not shrunk, and raw HR IDs are
                  gone from display (names only); the HR ID stays in the CSV export and search. */}
              <div className="hidden xl:block">
                <table className="w-full table-fixed border-collapse text-left text-phx-sm">
                  <colgroup>
                    <col className="w-[26%]" />
                    <col className="w-[17%]" />
                    <col className="w-[15%]" />
                    <col className="w-[16%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                  </colgroup>
                  <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <SortableHeader active={entitlementSort === "fullName"} direction={entitlementSortDir} sortKey="fullName" onSort={toggleEntitlementSort}>Employee</SortableHeader>
                      <SortableHeader active={entitlementSort === "daysSinceHire"} direction={entitlementSortDir} sortKey="daysSinceHire" onSort={toggleEntitlementSort}>Hire &amp; tenure</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Eligibility</th>
                      <SortableHeader active={entitlementSort === "annualBalanceDays"} direction={entitlementSortDir} sortKey="annualBalanceDays" onSort={toggleEntitlementSort}>Balance</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Manager</th>
                      <th className="border-b border-slate-100 px-3 py-2.5">Review</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedEntitlements.map((row) => (
                      <tr key={row.hrId} className="bg-white align-top transition hover:bg-emerald-50/30">
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="break-words font-bold text-slate-900">{row.displayName}</p>
                          <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}</p>
                          <p className="text-phx-xs text-slate-400">{row.employmentStatus ?? "-"}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-semibold text-slate-700">{formatDate(row.hireDate)}</p>
                          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">{row.daysSinceHire == null ? "-" : vacationDaysLabel(row.daysSinceHire)} since hire</p>
                          <p className="text-phx-xs text-slate-400">6-mo: {formatDate(row.sixMonthAnniversary)}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <Badge variant={eligibilityBadgeVariant(row.eligibilityStatus)}>
                            {eligibilityStatusLabel(row.eligibilityStatus)}
                          </Badge>
                          {row.eligibilityStatus === "first_six_months" && (row.daysUntilEligibility ?? 0) > 0 ? (
                            <p className="mt-1 text-phx-xs font-bold text-amber-700">{vacationDaysLabel(row.daysUntilEligibility ?? 0)} left</p>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-bold text-slate-900">{formatDays(row.annualBalanceDays)} left</p>
                          <p className="mt-0.5 text-phx-xs font-medium text-slate-500">
                            {formatDays(row.annualEntitlementDays)} total / {formatDays(row.annualUsedDays)} used
                          </p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="break-words font-semibold text-slate-700">{row.managerName ?? "-"}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          {row.reviewFlags.length > 0 ? (
                            <div className="flex flex-wrap gap-1">
                              {row.reviewFlags.map((flag) => (
                                <Badge key={flag} variant="warning">{flag}</Badge>
                              ))}
                            </div>
                          ) : (
                            <span className="text-phx-xs font-bold text-emerald-600">No issue</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {paginatedEntitlements.length === 0 ? (
                      <tr>
                        <td className="border-b border-slate-100 px-4 py-8 text-center text-phx-md font-medium text-slate-500" colSpan={6}>
                          No active employees matched the current filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <PaginationControls page={entitlementPage} pageSize={PAGE_SIZE} total={sortedEntitlements.length} onPageChange={setEntitlementPage} />
              </div>

              {/* Card view (< xl) */}
              <div className="block xl:hidden space-y-2 p-3">
                {paginatedEntitlements.length === 0 ? (
                  <p className="py-6 text-center text-phx-md font-medium text-slate-500">
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
            ) : isSelfView ? (
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <MetricCard
                  description="Waiting on your manager or HR."
                  label="Pending"
                  tone="orange"
                  value={summary?.pending ?? 0}
                />
                <MetricCard
                  description="Approved by HR."
                  label="Approved"
                  tone="emerald"
                  value={summary?.approved ?? 0}
                />
                <MetricCard
                  description="Rejected by your manager or HR."
                  label="Rejected"
                  tone="rose"
                  value={summary?.rejected ?? 0}
                />
                <MetricCard
                  description={`${formatDays(summary?.paidDays ?? 0)} paid · ${formatDays(summary?.unpaidDays ?? 0)} unpaid`}
                  label="Days requested"
                  tone="violet"
                  value={formatDays((summary?.paidDays ?? 0) + (summary?.unpaidDays ?? 0))}
                />
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

            {/* HR's operating view (queue by stage, SLA breaches, evidence backlog, the daily SLA
                run). None of it is about the viewer's own requests, so an own-leave viewer skips it. */}
            {dashboard && !isSelfView ? (
              <div className={cn("grid gap-2", showsDailySlaRunCard({ canAdminManage, isSelfView }) ? "md:grid-cols-4" : "md:grid-cols-3")}>
                <div className="rounded-sm border border-slate-200 bg-white p-3">
                  <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Pending by stage</p>
                  <p className="mt-1 text-xl font-black text-slate-900">{dashboard.pendingByStage.total}</p>
                  <p className="text-phx-xs font-semibold text-slate-500">Manager {dashboard.pendingByStage.manager} / HR {dashboard.pendingByStage.hr}</p>
                </div>
                <div className="rounded-sm border border-slate-200 bg-white p-3">
                  <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Overdue SLA</p>
                  <p className="mt-1 text-xl font-black text-rose-700">{dashboard.overdueBySla.total}</p>
                  <p className="text-phx-xs font-semibold text-slate-500">Manager {dashboard.overdueBySla.manager} / HR {dashboard.overdueBySla.hr}</p>
                </div>
                <div className="rounded-sm border border-slate-200 bg-white p-3">
                  <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Evidence review</p>
                  <p className="mt-1 text-xl font-black text-slate-900">{dashboard.evidence.pending + dashboard.evidence.needsFollowUp + dashboard.evidence.rejected}</p>
                  <p className="text-phx-xs font-semibold text-slate-500">Pending {dashboard.evidence.pending} / rejected {dashboard.evidence.rejected}</p>
                </div>
                {/* The background job's last run is an HR operations fact — Super Admin and HR only. */}
                {showsDailySlaRunCard({ canAdminManage, isSelfView }) ? (
                  <div className="rounded-sm border border-slate-200 bg-white p-3">
                    <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-500">Daily SLA run</p>
                    <p className="mt-1 text-xl font-black text-slate-900">{dashboard.dailyEscalationRunStatus.status}</p>
                    <p className="text-phx-xs font-semibold text-slate-500">{dashboard.dailyEscalationRunStatus.runDate ? formatDate(dashboard.dailyEscalationRunStatus.runDate) : "No run recorded"}</p>
                  </div>
                ) : null}
              </div>
            ) : null}

            {/* Distribution bars */}
            {summary && !isSelfView ? (
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
                    <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">Admin controls</p>
                    <h3 className="mt-1 text-base font-extrabold text-slate-900">Employee master requests</h3>
                  </div>
                  <Button
                    className="gap-2 rounded-sm bg-orange-500 px-4 py-2 text-phx-sm font-bold text-white hover:bg-orange-600"
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
                      <SearchableSelect className={selectClass} value={adminForm.employeeHrId} onChange={(event) => updateAdminForm("employeeHrId", event.target.value)}>
                        <option value="">Select employee</option>
                        {(options?.employees ?? []).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </SearchableSelect>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Type</span>
                      <SearchableSelect className={selectClass} value={adminForm.vacationType} onChange={(event) => updateAdminForm("vacationType", event.target.value)}>
                        {addVacationTypeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </SearchableSelect>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Status</span>
                      <SearchableSelect className={selectClass} value={adminForm.status} onChange={(event) => updateAdminForm("status", event.target.value)}>
                        {VACATION_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </SearchableSelect>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>Day part</span>
                      <SearchableSelect className={selectClass} value={adminForm.dayPart} onChange={(event) => updateAdminForm("dayPart", event.target.value)}>
                        {VACATION_DAY_PARTS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </SearchableSelect>
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>From</span>
                      <Input type="date" value={adminForm.startDate} onChange={(event) => updateAdminForm("startDate", event.target.value)} />
                    </label>
                    <label className="space-y-1.5">
                      <span className={labelClass}>To</span>
                      <Input type="date" value={adminForm.endDate} onChange={(event) => updateAdminForm("endDate", event.target.value)} />
                    </label>
                    <label className="space-y-1.5 xs:col-span-2">
                      <span className={labelClass}>Admin note</span>
                      <Input value={adminForm.notes} onChange={(event) => updateAdminForm("notes", event.target.value)} />
                    </label>
                    <div className="flex items-end gap-2 xs:col-span-2">
                      <Button
                        className="h-9 flex-1 rounded-sm bg-orange-500 text-phx-sm font-bold text-white hover:bg-orange-600"
                        disabled={Boolean(actingId)}
                        onClick={submitAdminForm}
                        type="button"
                      >
                        Create Vacation
                      </Button>
                      <Button
                        className="h-9 rounded-sm border border-slate-200 bg-white text-phx-sm font-bold text-slate-700 hover:bg-slate-50"
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
                    <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">
                      {canAdminManage ? "All requests" : "Request history"}
                    </p>
                    <h3 className="mt-1 text-base font-extrabold text-slate-900">{isSelfView ? "My vacation requests" : "Vacation requests"}</h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge className="w-fit border border-slate-200 bg-slate-50 px-2.5 py-1 text-phx-2xs font-bold uppercase tracking-[0.12em] text-slate-600">
                      {rows.length} requests
                    </Badge>
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-phx-2xs font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => exportRequestsCSV(sortedRequests)}
                      title="Export to CSV"
                      type="button"
                    >
                      <Download className="h-3 w-3" /> CSV
                    </button>
                    {canExport ? (
                      <a
                        className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-orange-200 bg-orange-50 px-2.5 text-phx-2xs font-bold text-orange-700 transition hover:bg-orange-100 print:hidden"
                        href={auditExportHref}
                        title="Audit-grade XLSX export"
                      >
                        <Download className="h-3 w-3" /> Audit XLSX
                      </a>
                    ) : null}
                    <button
                      className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-slate-200 bg-white px-2.5 text-phx-2xs font-bold text-slate-600 transition hover:bg-slate-50 print:hidden"
                      onClick={() => window.print()}
                      title="Print report"
                      type="button"
                    >
                      <Printer className="h-3 w-3" /> Print
                    </button>
                  </div>
                </div>
              </div>

              {/* Desktop table (xl+). An own-leave viewer never gets it: its Employee and Manager
                  columns name the same two people on every row — the cards below serve every width.
                  For everyone else: table-fixed + colgroup so the 12 source fields fit as merged
                  columns with no sideways scroll; cards carry every narrower viewport below. Columns
                  are MERGED, not shrunk, and raw HR IDs are dropped from display (names only) — the
                  employee/manager HR IDs stay in the CSV/XLSX exports and search. */}
              {isSelfView ? null : (
              <div className="hidden xl:block">
                <table className="w-full table-fixed border-collapse text-left text-phx-sm">
                  <colgroup>
                    <col className="w-[15%]" />
                    <col className="w-[11%]" />
                    <col className="w-[14%]" />
                    <col className="w-[12%]" />
                    <col className="w-[13%]" />
                    <col className="w-[12%]" />
                    <col className="w-[9%]" />
                    <col className="w-[14%]" />
                  </colgroup>
                  <thead className="bg-slate-50 text-phx-2xs font-bold uppercase tracking-[0.10em] text-slate-500">
                    <tr>
                      <SortableHeader active={requestSort === "employeeName"} direction={requestSortDir} sortKey="employeeName" onSort={toggleRequestSort}>Employee</SortableHeader>
                      <SortableHeader active={requestSort === "createdAt"} direction={requestSortDir} sortKey="createdAt" onSort={toggleRequestSort}>Submitted</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Type</th>
                      <SortableHeader active={requestSort === "startDate"} direction={requestSortDir} sortKey="startDate" onSort={toggleRequestSort}>Dates</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Balance &amp; pay</th>
                      <SortableHeader active={requestSort === "status"} direction={requestSortDir} sortKey="status" onSort={toggleRequestSort}>Status</SortableHeader>
                      <th className="border-b border-r border-slate-100 px-3 py-2.5">Manager</th>
                      <th className="border-b border-slate-100 px-3 py-2.5">{canAdminManage ? "Decision / Admin" : "Decision"}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {paginatedRequests.map((row) => (
                      <tr key={row.id} className="bg-white align-top transition hover:bg-orange-50/30">
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="break-words font-bold text-slate-900">{row.employeeName}</p>
                          <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="break-words text-phx-xs font-semibold text-slate-700">{formatDateTime(row.createdAt)}</p>
                          <p className="mt-0.5 break-words text-phx-2xs font-medium text-slate-400" title={row.id}>{row.requestCode}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="break-words font-semibold text-slate-800">{vacationTypeLabel(row.vacationType)}</p>
                          <p className="text-phx-xs text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
                          {row.vacationType === "compensatory" ? (
                            <div className="mt-1.5 rounded-sm border border-orange-100 bg-orange-50/70 px-2 py-1.5 text-phx-2xs font-semibold leading-4 text-orange-900">
                              <p className="break-words">{row.compensatoryEventName ?? "Event"}</p>
                              <p className="break-words text-orange-700">{[row.compensatoryEventDate, row.compensatoryEventLocation].filter(Boolean).join(" / ")}</p>
                              <RowEvidence canReviewAttachments={canReviewAttachments} row={row} />
                            </div>
                          ) : null}
                          {row.vacationType === "sick" ? <RowEvidence canReviewAttachments={canReviewAttachments} row={row} /> : null}
                          {row.vacationType === "other" && row.notes ? (
                            <p className="mt-1.5 break-words rounded-sm border border-amber-100 bg-amber-50/70 px-2 py-1.5 text-phx-2xs font-semibold leading-4 text-amber-900">{row.notes}</p>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="font-semibold text-slate-700">{formatDate(row.startDate)}</p>
                          <p className="text-phx-xs text-slate-400">to {formatDate(row.endDate)}</p>
                          <p className="mt-0.5 text-phx-sm font-bold text-slate-900">{vacationDaysLabel(row.durationDays)}</p>
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="break-words text-slate-700">
                            <span className="font-semibold">{formatDays(row.balanceBeforeDays)}</span>
                            <span className="mx-1 text-slate-400">&rarr;</span>
                            <span className="font-bold text-slate-900">{formatDays(row.balanceAfterDays)}</span>
                          </p>
                          <div className="mt-1">
                            <Badge variant={paymentBadgeVariant(row.paymentStatus)}>
                              {paymentStatusLabel(row.paymentStatus)}
                            </Badge>
                          </div>
                          {row.paymentStatus === "partial" ? (
                            <p className="mt-1 text-phx-2xs font-bold text-amber-700">
                              {formatDays(row.paidDurationDays)} paid / {formatDays(row.unpaidDurationDays)} unpaid
                            </p>
                          ) : null}
                          {row.unpaidReason ? <p className="mt-1 text-phx-2xs font-bold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <Badge variant={statusBadgeVariant(row.status)}>{dynamicStatusLabel(row)}</Badge>
                          {row.slaStatus.isOverdue ? (
                            <p className="mt-1 text-phx-2xs font-bold text-rose-700">SLA overdue</p>
                          ) : null}
                          {row.overlapWarnings.length > 0 ? (
                            <p className="mt-1 text-phx-2xs font-bold text-amber-700">{overlapWarningsLabel(row.overlapWarnings.length)}</p>
                          ) : null}
                        </td>
                        <td className="border-r border-slate-100 px-3 py-2.5">
                          <p className="break-words font-semibold text-slate-700">{row.managerName ?? "-"}</p>
                          {row.managerOfManagerName ? <p className="mt-0.5 break-words text-phx-2xs text-slate-400">MoM: {row.managerOfManagerName}</p> : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <button
                            className="mb-2 flex items-center gap-1 rounded-sm border border-slate-200 bg-white px-2 py-1 text-phx-2xs font-bold text-slate-600 transition hover:bg-slate-50"
                            onClick={() => openRequestReview(row)}
                            type="button"
                          >
                            <FileText className="h-3 w-3" /> Timeline
                            {row.timelineEventCount > 0 ? <span className="text-slate-400">({row.timelineEventCount})</span> : null}
                          </button>
                          {row.canDecide ? (
                            <Link
                              className="flex items-center gap-1 rounded-sm border border-orange-300 bg-white px-2 py-1 text-phx-2xs font-bold text-orange-700 transition hover:bg-orange-50"
                              href={`${approvalsBase}/${encodeURIComponent(row.id)}`}
                            >
                              <ArrowRight className="h-3 w-3" /> Decide in Leave Approvals
                            </Link>
                          ) : (
                            <div className="text-phx-xs">
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
                        <td className="border-b border-slate-100 px-4 py-8 text-center text-phx-md font-medium text-slate-500" colSpan={8}>
                          No vacation requests found.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <PaginationControls page={requestPage} pageSize={PAGE_SIZE} total={sortedRequests.length} onPageChange={setRequestPage} />
              </div>
              )}

              {/* Card view (< xl) — and every width for an own-leave viewer, two cards a row from
                  `lg` so a laptop is not one long column. */}
              <div className={isSelfView ? "grid gap-2 p-3 lg:grid-cols-2" : "block xl:hidden space-y-2 p-3"}>
                {paginatedRequests.length === 0 ? (
                  <p className="py-6 text-center text-phx-md font-medium text-slate-500 lg:col-span-2">
                    {isSelfView ? "You have no vacation requests yet." : "No vacation requests found."}
                  </p>
                ) : (
                  paginatedRequests.map((row) => (
                    <RequestCard
                      key={row.id}
                      actingId={actingId}
                      canAdminManage={canAdminManage}
                      canReviewAttachments={canReviewAttachments}
                      selfView={isSelfView}
                      viewerHrId={viewerHrId}
                      approvalsBase={approvalsBase}
                      onResubmit={resubmit}
                      onReview={openRequestReview}
                      row={row}
                    />
                  ))
                )}
                <div className={isSelfView ? "lg:col-span-2" : undefined}>
                  <PaginationControls page={requestPage} pageSize={PAGE_SIZE} total={sortedRequests.length} onPageChange={setRequestPage} />
                </div>
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
                <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-orange-600">Request review</p>
                <h3 className="mt-1 font-mono text-lg font-black text-slate-900">{selectedRequest.requestCode}</h3>
                <p className="text-phx-sm font-semibold text-slate-500">{selectedRequest.employeeName} / {dynamicStatusLabel(selectedRequest)}</p>
              </div>
              <button className="rounded-sm p-2 text-slate-500 hover:bg-slate-100" onClick={() => setSelectedRequest(null)} type="button">
                <XCircle className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {selectedRequest.overlapWarnings.length > 0 ? (
                <div className="rounded-sm border border-amber-200 bg-amber-50 p-3">
                  <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-amber-700">Overlap intelligence</p>
                  <div className="mt-2 space-y-1.5">
                    {selectedRequest.overlapWarnings.map((warning) => (
                      <p className="text-phx-sm font-semibold text-amber-900" key={`${warning.code}-${warning.relatedRequestIds.join("-")}`}>{warning.message}</p>
                    ))}
                  </div>
                </div>
              ) : null}

              {/* THE DATED DOCUMENT HISTORY. Every file with the date it arrived — the owner's
                  2026-10-03 ruling that a later upload adds a line instead of replacing the first
                  one, and the screen where he reads "3 October this, 10 October those".
                  The employee sees it for HIS OWN request and can add to it here; HR sees it for
                  everyone. A manager approver is not given it — the report's canReviewAttachments
                  is HR/Super Admin only. */}
              {(selectedRequest.vacationType === "sick" || selectedRequest.vacationType === "compensatory") &&
              (canReviewAttachments || isOwnSelectedRequest) ? (
                <div className="rounded-sm border border-slate-200 p-3">
                  <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                    Documents{selectedRequest.attachments.length > 0 ? ` (${selectedRequest.attachments.length})` : ""}
                  </p>
                  <div className="mt-2">
                    <VacationAttachmentHistory
                      attachments={selectedRequest.attachments}
                      canUpload={canReviewAttachments || isOwnSelectedRequest}
                      kind={selectedRequest.vacationType === "compensatory" ? "compensatory" : "sick"}
                      requestId={selectedRequest.id}
                    />
                  </div>
                </div>
              ) : null}

              {(selectedRequest.vacationType === "sick" || selectedRequest.vacationType === "compensatory") && canReviewAttachments ? (
                <div className="rounded-sm border border-slate-200 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div>
                      <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Evidence review</p>
                      <p className="mt-1 text-phx-sm font-semibold text-slate-600">
                        Current: {selectedRequest.evidenceReviews[0]?.status ?? "pending"}
                      </p>
                    </div>
                    {/* The files themselves are the dated Documents block directly above — repeating
                        the chip here only duplicated the first one. */}
                  </div>
                  <textarea
                    className={cn(phxTextareaClassName, "mt-3 min-h-20")}
                    onChange={(event) => setEvidenceReviewNote(event.target.value)}
                    placeholder="HR review note"
                    value={evidenceReviewNote}
                  />
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button className={cn(phxButtonApproveDenseClassName, "h-8 text-phx-xs font-bold")} disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("accepted")} type="button">Accept</Button>
                    <Button className="h-8 rounded-sm bg-amber-500 text-phx-xs font-bold text-white hover:bg-amber-600" disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("needs_follow_up")} type="button">Needs follow-up</Button>
                    <Button className={cn(phxButtonDangerDenseClassName, "h-8 text-phx-xs font-bold")} disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("rejected")} type="button">Reject</Button>
                  </div>
                </div>
              ) : null}

              <div className="rounded-sm border border-slate-200 p-3">
                <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Approval timeline</p>
                {timelineLoading ? (
                  <p className="mt-3 text-sm font-semibold text-slate-500">Loading timeline...</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {timeline.map((event) => (
                      <div className="border-l-2 border-orange-200 pl-3" key={event.id}>
                        <p className="text-phx-sm font-black text-slate-900">{event.message}</p>
                        <p className="mt-0.5 text-phx-xs font-semibold text-slate-500">{formatDateTime(event.createdAt)} · {timelineEventLabel(event.eventType)}</p>
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
