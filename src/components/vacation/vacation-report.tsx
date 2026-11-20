"use client";

import { employmentStatusLabel } from "@/lib/employees/employment-status-label";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
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

import { AdminPageHero } from "@/components/admin/admin-design-system";
import { adminSoftDepthClassName } from "@/components/admin/admin-design-tokens";
import {
  LANDING_FOCUS,
  LANDING_INK,
  LANDING_NAVY_TILE,
  LandingCta,
  LandingFigure,
  LandingMeta,
  LandingNavyBoard,
  LandingNavyBoardLoading,
  LandingPanel,
  LandingRailLine,
  LandingTick,
  landingActionClassName,
} from "@/components/employee-portal/landing-kit";
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
  phxButtonAccentClassName,
  phxButtonApproveDenseClassName,
  phxButtonDangerDenseClassName,
  phxButtonGhostClassName,
  phxButtonPrimaryClassName,
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

type StateTone = "success" | "danger" | "warning" | "neutral";

/**
 * A state — a request's stage, its payment, an eligibility, a review flag — is coloured small
 * capitals on a 2px rail, never a filled pill (the portal's landing language). The tone still comes
 * from the *BadgeVariant functions above, so every state keeps the colour it always had; `fill` is
 * the same colour for a record row's left rail.
 */
const STATE_TONES: Record<StateTone, { fill: string; rail: string; text: string }> = {
  danger: { fill: "bg-rose-500", rail: "border-rose-500", text: "text-rose-700" },
  neutral: { fill: "bg-slate-300", rail: "border-slate-300", text: "text-slate-600" },
  success: { fill: "bg-emerald-500", rail: "border-emerald-500", text: "text-emerald-700" },
  warning: { fill: "bg-amber-500", rail: "border-amber-500", text: "text-amber-700" },
};

function StateText({ children, tone }: { children: React.ReactNode; tone: StateTone }) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center break-words border-l-2 pl-1.5 text-phx-xs font-bold uppercase leading-tight tracking-[0.06em]",
        STATE_TONES[tone].rail,
        STATE_TONES[tone].text,
      )}
    >
      {children}
    </span>
  );
}

/** The small capitals that name a figure inside a record row. */
const ROW_LABEL = "text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-500";

/** An error the page could not act on: a white sheet with a rose rail, read out at once. */
function ReportAlert({ children }: { children: React.ReactNode }) {
  return (
    <div className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`} role="alert">
      <LandingRailLine rail="bg-rose-500">{children}</LandingRailLine>
    </div>
  );
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
          className={`inline-flex min-h-8 items-center gap-1 text-phx-xs font-bold uppercase tracking-[0.08em] text-sky-700 underline decoration-sky-300 underline-offset-2 transition hover:decoration-sky-700 motion-reduce:transition-none ${LANDING_FOCUS}`}
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
  // The header cell stays a plain cell; the sort is a real button inside it, so a keyboard reaches it
  // and the focus ring has something to sit on.
  return (
    <th
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("border-b border-slate-200 px-3 py-2.5", cls)}
    >
      <button
        className={`inline-flex select-none items-center gap-1 text-left uppercase tracking-[0.1em] transition hover:text-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
        onClick={() => onSort(sortKey)}
        type="button"
      >
        {children}
        {active ? (
          direction === "asc" ? (
            <ArrowUp aria-hidden="true" className="h-3 w-3 shrink-0 text-[#08111f]" />
          ) : (
            <ArrowDown aria-hidden="true" className="h-3 w-3 shrink-0 text-[#08111f]" />
          )
        ) : (
          <ArrowUpDown aria-hidden="true" className="h-3 w-3 shrink-0 text-slate-300" />
        )}
      </button>
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
/* ─── Metric Card ──────────────────────────────────────────────────── */
/* ═══════════════════════════════════════════════════════════════════ */

/**
 * One headline count, as a tile on the view's navy board (its loading shape is the board's own
 * LandingNavyBoardLoading). The tone is the tile's 2px rail; the figure stays white.
 */
const METRIC_RAIL: Record<"blue" | "emerald" | "orange" | "rose" | "violet", string> = {
  blue: "bg-sky-400",
  emerald: "bg-emerald-400",
  orange: "bg-amber-400",
  rose: "bg-rose-400",
  violet: "bg-violet-400",
};

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
  return (
    <div className={`relative flex min-w-0 flex-col border border-white/[0.08] p-3 pl-3.5 ${LANDING_NAVY_TILE}`}>
      <span aria-hidden="true" className={cn("absolute inset-y-0 left-0 w-0.5", METRIC_RAIL[tone])} />
      <p className="break-words text-phx-xs font-bold uppercase tracking-[0.1em] text-white/65">{label}</p>
      <div className="mt-1.5">
        <LandingFigure onNavy size="md">
          {value}
        </LandingFigure>
      </div>
      <p className="mt-2 break-words text-phx-xs leading-snug text-white/55">{description}</p>
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
    <LandingPanel bodyClassName="px-3 py-3 sm:px-4" right={<LandingMeta items={[`${total} total`]} />} title="Request status distribution">
      <div className="flex h-2 w-full overflow-hidden bg-slate-100">
        {approvedPct > 0 ? (
          <div className="h-full bg-emerald-500" style={{ width: `${approvedPct}%` }} title={`Approved: ${approved}`} />
        ) : null}
        {pendingPct > 0 ? (
          <div className="h-full bg-amber-400" style={{ width: `${pendingPct}%` }} title={`Pending: ${pending}`} />
        ) : null}
        {rejectedPct > 0 ? (
          <div className="h-full bg-rose-500" style={{ width: `${rejectedPct}%` }} title={`Rejected: ${rejected}`} />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-emerald-500" />
          <span className="text-emerald-700">Approved {approved}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-amber-400" />
          <span className="text-amber-700">Pending {pending}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-rose-500" />
          <span className="text-rose-700">Rejected {rejected}</span>
        </span>
      </div>
    </LandingPanel>
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
    <LandingPanel bodyClassName="px-3 py-3 sm:px-4" right={<LandingMeta items={[`${total} employees`]} />} title="Eligibility distribution">
      <div className="flex h-2 w-full overflow-hidden bg-slate-100">
        {eligiblePct > 0 ? (
          <div className="h-full bg-emerald-500" style={{ width: `${eligiblePct}%` }} title={`Eligible: ${eligible}`} />
        ) : null}
        {sixMonthPct > 0 ? (
          <div className="h-full bg-amber-400" style={{ width: `${sixMonthPct}%` }} title={`First 6 months: ${firstSixMonths}`} />
        ) : null}
        {missingPct > 0 ? (
          <div className="h-full bg-rose-500" style={{ width: `${missingPct}%` }} title={`Missing hire date: ${missingHireDate}`} />
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-emerald-500" />
          <span className="text-emerald-700">Eligible {eligible}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-amber-400" />
          <span className="text-amber-700">First 6 months {firstSixMonths}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-rose-500" />
          <span className="text-rose-700">Missing data {missingHireDate}</span>
        </span>
      </div>
    </LandingPanel>
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
    <LandingPanel bodyClassName="px-3 py-3 sm:px-4" right={<LandingMeta items={[`${formatDays(total)} total`]} />} title="Paid vs Unpaid days">
      <div className="flex h-2 w-full overflow-hidden bg-slate-100">
        <div className="h-full bg-emerald-500" style={{ width: `${paidPct}%` }} title={`Paid: ${formatDays(paidDays)}`} />
        <div className="h-full bg-amber-400" style={{ width: `${100 - paidPct}%` }} title={`Unpaid: ${formatDays(unpaidDays)}`} />
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums">
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-emerald-500" />
          <span className="text-emerald-700">Paid {vacationDaysLabel(paidDays)}</span>
        </span>
        <span className="flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 bg-amber-400" />
          <span className="text-amber-700">Unpaid {vacationDaysLabel(unpaidDays)}</span>
        </span>
      </div>
    </LandingPanel>
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
    <div ref={panelRef} className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
      <button
        className={`flex min-h-11 w-full items-center justify-between gap-3 px-3 py-2.5 text-left transition hover:bg-slate-50 motion-reduce:transition-none sm:px-4 ${LANDING_FOCUS}`}
        onClick={() => setOpen((c) => !c)}
        type="button"
        aria-expanded={open}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
          <LandingTick />
          <span className={`text-phx-xs font-black uppercase tracking-[0.12em] ${LANDING_INK}`}>Filters</span>
          {filterCount > 0 ? (
            <span className="text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums text-amber-700">
              {filterCount} active
            </span>
          ) : null}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("h-3.5 w-3.5 shrink-0 text-slate-400 transition-transform duration-200 motion-reduce:transition-none", open ? "rotate-180" : "")}
        />
      </button>
      {open ? (
        <div className="border-t border-slate-200 px-3 py-3 sm:px-4">
          <div className="grid gap-3 xs:grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
            {children}
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              className={cn(phxButtonPrimaryClassName, "gap-2", LANDING_FOCUS)}
              onClick={() => {
                onApply();
                setOpen(false);
              }}
              type="button"
            >
              <Filter aria-hidden="true" className="h-3 w-3" />
              Apply Filters
            </button>
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
  const barColor = remainPct >= 60 ? "bg-emerald-500" : remainPct >= 30 ? "bg-amber-400" : "bg-rose-500";
  const eligibilityTone = eligibilityBadgeVariant(row.eligibilityStatus);

  return (
    <div className="flex min-w-0 gap-3 border-b border-slate-200 px-3 py-3 sm:px-4">
      <span aria-hidden="true" className={cn("w-1 shrink-0 self-stretch", STATE_TONES[eligibilityTone].fill)} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1">
            <p className={`break-words text-phx-md font-bold ${LANDING_INK}`} dir="auto">{row.displayName}</p>
            <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">
              {[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}
            </p>
          </div>
          <StateText tone={eligibilityTone}>{eligibilityStatusLabel(row.eligibilityStatus)}</StateText>
        </div>

        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2 min-[360px]:grid-cols-3">
          <div className="min-w-0">
            <p className={ROW_LABEL}>Hire date</p>
            <p className={`mt-0.5 break-words text-phx-sm font-semibold tabular-nums ${LANDING_INK}`}>{formatDate(row.hireDate)}</p>
          </div>
          <div className="min-w-0">
            <p className={ROW_LABEL}>Since hire</p>
            <p className={`mt-0.5 break-words text-phx-sm font-semibold tabular-nums ${LANDING_INK}`}>{row.daysSinceHire == null ? "-" : vacationDaysLabel(row.daysSinceHire)}</p>
          </div>
          <div className="min-w-0">
            <p className={ROW_LABEL}>6-mo date</p>
            <p className={`mt-0.5 break-words text-phx-sm font-semibold tabular-nums ${LANDING_INK}`}>{formatDate(row.sixMonthAnniversary)}</p>
          </div>
        </div>

        {/* Balance bar */}
        <div className="mt-2.5">
          <div className="flex flex-wrap items-center justify-between gap-x-3 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums text-slate-500">
            <span>Used {formatDays(row.annualUsedDays)}</span>
            <span>of {formatDays(row.annualEntitlementDays)}</span>
          </div>
          <div className="mt-1 h-1 w-full overflow-hidden bg-slate-100">
            <div className={cn("h-full", barColor)} style={{ width: `${usedPct}%` }} />
          </div>
          <p className={`mt-1 text-phx-sm font-extrabold tabular-nums ${LANDING_INK}`}>{vacationDaysLabel(row.annualBalanceDays)} remaining</p>
        </div>

        {row.eligibilityStatus === "first_six_months" && (row.daysUntilEligibility ?? 0) > 0 ? (
          <p className="mt-1.5 text-phx-xs font-bold tabular-nums text-amber-700">{vacationDaysLabel(row.daysUntilEligibility ?? 0)} until eligible</p>
        ) : null}

        {row.managerName ? (
          <p className="mt-1.5 break-words text-phx-xs font-medium text-slate-500">
            Manager: <span dir="auto">{row.managerName}</span>
          </p>
        ) : null}

        {row.reviewFlags.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {row.reviewFlags.map((flag) => (
              <StateText key={flag} tone="warning">{flag}</StateText>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════ */
/* ─── Own-leave panel (a viewer whose scope is only themselves) ────── */
/* ═══════════════════════════════════════════════════════════════════ */

function SelfLeaveFact({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="min-w-0 bg-white px-3 py-2.5 sm:px-4">
      <dt className={ROW_LABEL}>{label}</dt>
      <dd className={cn("mt-0.5 break-words text-phx-md font-bold tabular-nums", tone ?? LANDING_INK)} dir="auto">{value}</dd>
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
    <LandingPanel className="mt-2" title={isSelfView ? "Taken from your annual leave" : "Deductions taken from annual leave"}>
      {data.failed ? (
        <LandingRailLine rail="bg-amber-400">
          The deductions taken from annual leave could not be read right now. Reload the page to try again.
        </LandingRailLine>
      ) : (
        <ul className="divide-y divide-slate-200">
          {data.rows.map((row) => (
            <li className="px-3 py-3 sm:px-4" key={`${row.employeeHrId}-${row.workDate}-${row.chargedAt}`}>
              <p className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-phx-sm font-bold ${LANDING_INK}`}>
                {isSelfView ? null : <span dir="auto">{row.employeeName}</span>}
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
                <span className="tabular-nums text-sky-800">
                  {vacationDaysLabel(row.days)} from annual leave
                </span>
              </p>
              <p dir="auto" className="mt-1 whitespace-pre-wrap break-words text-phx-sm leading-5 text-slate-700">{row.comment}</p>
            </li>
          ))}
        </ul>
      )}
    </LandingPanel>
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
      <div className={`min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
        <LandingRailLine rail="bg-slate-300">
          <span className={`block font-bold ${LANDING_INK}`}>Your leave balance is not available yet</span>
          <span className="mt-0.5 block">
            HR needs your employee record complete before it can be calculated. Ask them through Request Support.
          </span>
        </LandingRailLine>
      </div>
    );
  }

  const hasEntitlement = row.annualEntitlementDays > 0;
  const usedPct = hasEntitlement ? Math.min((row.annualUsedDays / row.annualEntitlementDays) * 100, 100) : 0;
  const remainPct = 100 - usedPct;
  // On the navy board: the figure takes the tone scale's light step, the bar its fill.
  const tone = !hasEntitlement
    ? { bar: "bg-white/40", figure: "text-white" }
    : remainPct >= 60
      ? { bar: "bg-emerald-400", figure: "text-emerald-300" }
      : remainPct >= 30
        ? { bar: "bg-amber-400", figure: "text-amber-300" }
        : { bar: "bg-rose-400", figure: "text-rose-300" };
  const daysUntilEligible = row.eligibilityStatus === "first_six_months" ? (row.daysUntilEligibility ?? 0) : 0;
  const eligibilityTone = eligibilityBadgeVariant(row.eligibilityStatus);

  return (
    <div className="grid gap-2 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-2">
        <LandingNavyBoard label="Annual leave left">
          <div className="px-1 pb-1">
            <LandingFigure onNavy tone={tone.figure} unit={row.annualBalanceDays === 1 ? "day" : "days"}>
              {formatDays(row.annualBalanceDays)}
            </LandingFigure>
            <div className="mt-4">
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-phx-xs font-bold uppercase tracking-[0.08em] tabular-nums text-white/55">
                <span>Used {formatDays(row.annualUsedDays)}</span>
                <span>of {formatDays(row.annualEntitlementDays)} this leave year</span>
              </div>
              <div className="mt-1 h-1 w-full overflow-hidden bg-white/10">
                <div className={cn("h-full", tone.bar)} style={{ width: `${usedPct}%` }} />
              </div>
            </div>
          </div>
        </LandingNavyBoard>
        <div className="grid gap-2 sm:grid-cols-2">
          <LandingCta href={requestHref} variant="solid">
            <CalendarDays aria-hidden="true" className="h-3.5 w-3.5" />
            Request vacation
          </LandingCta>
          <LandingCta href={requestsHref}>
            My requests
            <ArrowRight aria-hidden="true" className="h-3.5 w-3.5" />
          </LandingCta>
        </div>
      </div>

      <LandingPanel
        right={<StateText tone={eligibilityTone}>{eligibilityStatusLabel(row.eligibilityStatus)}</StateText>}
        title="Eligibility"
      >
        {daysUntilEligible > 0 ? (
          <LandingRailLine rail="bg-amber-400">
            <span className="font-bold tabular-nums text-amber-700">
              {daysUntilEligible} {daysUntilEligible === 1 ? "day" : "days"} until you can take paid annual leave
            </span>
          </LandingRailLine>
        ) : null}
        <dl className={cn("grid grid-cols-2 gap-px bg-slate-200", daysUntilEligible > 0 ? "border-t border-slate-200" : null)}>
          <SelfLeaveFact label="Hire date" value={formatDate(row.hireDate)} />
          <SelfLeaveFact label="Six months on" value={formatDate(row.sixMonthAnniversary)} />
          <SelfLeaveFact label="Days since hire" value={row.daysSinceHire != null ? String(row.daysSinceHire) : "-"} />
          <SelfLeaveFact label="Manager" value={row.managerName ?? "Not assigned"} />
        </dl>
        {row.reviewFlags.length > 0 ? (
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 border-t border-slate-200 px-3 py-2.5 sm:px-4">
            {row.reviewFlags.map((flag) => (
              <StateText key={flag} tone="warning">{flag}</StateText>
            ))}
          </div>
        ) : null}
      </LandingPanel>
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
  const statusTone = statusBadgeVariant(row.status);
  // The timeline / documents opener: quiet navy text, a real button with the focus ring.
  const timelineButtonClass = `inline-flex min-h-8 items-center gap-1 text-phx-xs font-bold uppercase tracking-[0.08em] text-slate-600 transition hover:text-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`;
  return (
    <div
      className={cn(
        "flex min-w-0 gap-3 border-b border-slate-200 px-3 py-3 sm:px-4",
        selfView ? "lg:odd:border-r" : null,
      )}
    >
      <span aria-hidden="true" className={cn("w-1 shrink-0 self-stretch", STATE_TONES[statusTone].fill)} />
      <div className="min-w-0 flex-1">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <div className="min-w-0 flex-1">
          {selfView ? (
            <>
              <p className={`break-words text-phx-md font-bold tabular-nums ${LANDING_INK}`}>{dateRange}</p>
              <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">
                {vacationTypeLabel(row.vacationType)} · {vacationDayPartLabel(row.dayPart)} · {row.requestCode}
              </p>
            </>
          ) : (
            <>
              <p className={`break-words text-phx-md font-bold ${LANDING_INK}`} dir="auto">{row.employeeName}</p>
              <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">
                {[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "-"}
              </p>
              <p className="mt-0.5 break-words text-phx-xs font-medium tabular-nums text-slate-400">{row.requestCode}</p>
            </>
          )}
        </div>
        <div className="flex min-w-0 max-w-full flex-col items-start gap-1 sm:items-end">
          <StateText tone={statusTone}>{dynamicStatusLabel(row)}</StateText>
          <StateText tone={paymentBadgeVariant(row.paymentStatus)}>{paymentStatusLabel(row.paymentStatus)}</StateText>
        </div>
      </div>

      {selfView ? (
        <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
          <div className="min-w-0">
            <p className={ROW_LABEL}>Duration</p>
            <p className={`mt-0.5 text-phx-sm font-extrabold tabular-nums ${LANDING_INK}`}>
              {formatDays(row.durationDays)} {row.durationDays === 1 ? "day" : "days"}
            </p>
          </div>
          <div className="min-w-0">
            <p className={ROW_LABEL}>Balance</p>
            <p className="mt-0.5 text-phx-sm font-semibold tabular-nums text-slate-600">
              {formatDays(row.balanceBeforeDays)} <span className="text-slate-400">&rarr;</span>{" "}
              <span className={`font-bold ${LANDING_INK}`}>{formatDays(row.balanceAfterDays)}</span>
            </p>
          </div>
        </div>
      ) : (
        <>
          <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-2">
            <div className="min-w-0">
              <p className={ROW_LABEL}>Type</p>
              <p className={`mt-0.5 break-words text-phx-sm font-semibold ${LANDING_INK}`}>{vacationTypeLabel(row.vacationType)}</p>
              <p className="text-phx-xs font-medium text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
            </div>
            <div className="min-w-0">
              <p className={ROW_LABEL}>Duration</p>
              <p className={`mt-0.5 text-phx-sm font-extrabold tabular-nums ${LANDING_INK}`}>{vacationDaysLabel(row.durationDays)}</p>
            </div>
          </div>

          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-2">
            <div className="min-w-0">
              <p className={ROW_LABEL}>From</p>
              <p className={`mt-0.5 text-phx-sm font-semibold tabular-nums ${LANDING_INK}`}>{formatDate(row.startDate)}</p>
            </div>
            <div className="min-w-0">
              <p className={ROW_LABEL}>To</p>
              <p className={`mt-0.5 text-phx-sm font-semibold tabular-nums ${LANDING_INK}`}>{formatDate(row.endDate)}</p>
            </div>
          </div>
        </>
      )}

      {selfView ? null : (
        <div className="mt-2">
          <p className={ROW_LABEL}>Balance</p>
          <p className="mt-0.5 text-phx-sm font-semibold tabular-nums text-slate-600">
            {formatDays(row.balanceBeforeDays)} <span className="text-slate-400">&rarr;</span>{" "}
            <span className={`font-bold ${LANDING_INK}`}>{formatDays(row.balanceAfterDays)}</span>
          </p>
        </div>
      )}

      {row.paymentStatus === "partial" ? (
        <p className="mt-1.5 text-phx-xs font-bold tabular-nums text-amber-700">
          {formatDays(row.paidDurationDays)} paid / {formatDays(row.unpaidDurationDays)} unpaid
        </p>
      ) : null}
      {row.unpaidReason ? <p className="mt-1 text-phx-xs font-bold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}

      {row.vacationType === "compensatory" ? (
        <div className="mt-2 border-l-2 border-slate-300 pl-2 text-phx-xs font-semibold leading-4 text-slate-700">
          <p className="break-words" dir="auto">{row.compensatoryEventName ?? "Compensatory event"}</p>
          <p className="break-words text-slate-500">{[row.compensatoryEventDate, row.compensatoryEventLocation].filter(Boolean).join(" / ")}</p>
          <RowEvidence canReviewAttachments={canReviewAttachments} row={row} />
        </div>
      ) : null}
      {row.vacationType === "sick" ? <RowEvidence canReviewAttachments={canReviewAttachments} row={row} /> : null}
      {row.vacationType === "other" && row.notes ? (
        <p className="mt-2 break-words border-l-2 border-amber-400 pl-2 text-phx-xs font-semibold leading-4 text-slate-700" dir="auto">
          {row.notes}
        </p>
      ) : null}

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 text-phx-xs font-medium text-slate-500">
        <span className="tabular-nums">Submitted {formatDateTime(row.createdAt)}</span>
        {row.managerName ? (
          <span className="break-words">
            Manager: <span dir="auto">{row.managerName}</span>
          </span>
        ) : null}
      </div>
      {(row.slaStatus.isOverdue || row.overlapWarnings.length > 0) ? (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          {row.slaStatus.isOverdue ? <StateText tone="danger">SLA overdue</StateText> : null}
          {row.overlapWarnings.length > 0 ? <StateText tone="warning">{overlapWarningsLabel(row.overlapWarnings.length)}</StateText> : null}
        </div>
      ) : null}
      {!canAdminManage ? (
        <button
          className={cn("mt-2", timelineButtonClass)}
          onClick={() => onReview(row)}
          type="button"
        >
          {/* For a sick or compensatory request the drawer also holds the dated documents and the
              button that adds more to them, so the label has to say so or the employee never finds it. */}
          <FileText aria-hidden="true" className="h-3 w-3" />{" "}
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
          className={landingActionClassName("outline", "mt-2.5 w-full")}
          href={`${approvalsBase}/${encodeURIComponent(row.id)}`}
        >
          <ArrowRight aria-hidden="true" className="h-3 w-3" /> Decide in Leave Approvals
        </Link>
      ) : (
        <div className="mt-2 text-phx-xs text-slate-500">
          {row.hrDecisionAt ? <p className="tabular-nums">HR: {formatDateTime(row.hrDecisionAt)}</p> : null}
          {row.managerDecisionAt ? <p className="tabular-nums">Manager: {formatDateTime(row.managerDecisionAt)}</p> : null}
          {row.managerDecisionComment ? <p className="break-words text-slate-600" dir="auto">{row.managerDecisionComment}</p> : null}
          {row.hrDecisionComment ? <p className="break-words text-slate-600" dir="auto">{row.hrDecisionComment}</p> : null}
        </div>
      )}

      {canAdminManage ? (
        <div className="mt-2 flex gap-2 border-t border-slate-200 pt-2">
          <button
            className={timelineButtonClass}
            onClick={() => onReview(row)}
            type="button"
          >
            <FileText aria-hidden="true" className="h-3 w-3" />{" "}
            {row.vacationType === "sick" || row.vacationType === "compensatory" ? "Documents & timeline" : "Timeline"}
          </button>
        </div>
      ) : null}
      </div>
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
          nav, header:not(section > header), footer, aside { display: none !important; }
        }
      `}</style>
      {/* The page chrome's header is hidden in print; a panel's own title row (a LandingPanel's
          <header>, directly inside its <section>) prints, or a printed table loses its name. */}
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
        {initialError ? <ReportAlert>{initialError}</ReportAlert> : null}
        {actionError ? <ReportAlert>{actionError}</ReportAlert> : null}
        {adminError ? <ReportAlert>{adminError}</ReportAlert> : null}

        {/* Two equal columns on a phone, never a sideways-scrolling strip: `overflow-x-auto` over
            nowrap tabs is the pattern the fits-the-screen rule names. A label that outgrows its half
            wraps inside the tab. From `sm` the strip is the content-width row it always was. The
            active tab is a navy underline, the count beside it plain tabular figures. */}
        <div
          className="grid w-full grid-cols-2 border-b border-slate-200 sm:flex sm:gap-6"
          role="tablist"
          aria-label="Vacation report tabs"
        >
          {tabItems.map((tab) => {
            const active = activeTab === tab.value;
            return (
              <button
                aria-selected={active}
                className={cn(
                  "-mb-px flex min-h-10 items-center justify-center gap-2 border-b-2 px-3 py-1 text-center text-phx-xs font-bold uppercase leading-tight tracking-[0.1em] transition motion-reduce:transition-none sm:min-h-9 sm:shrink-0 sm:justify-start sm:whitespace-nowrap sm:px-0",
                  LANDING_FOCUS,
                  active ? "border-[#08111f] text-[#08111f]" : "border-transparent text-slate-500 hover:text-[#08111f]",
                )}
                key={tab.value}
                role="tab"
                type="button"
                onClick={() => switchTab(tab.value)}
              >
                {tab.label}
                {tab.count !== null ? (
                  <span className={cn("tabular-nums", active ? "text-[#08111f]" : "text-slate-400")}>
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
                      className={landingActionClassName("outline")}
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
            {/* Metric cards — the view's ONE navy board */}
            {!initialData ? (
              <LandingNavyBoardLoading label="Leave Entitlements" />
            ) : (
              <LandingNavyBoard label="Leave Entitlements">
                <div className="@container">
                  <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-5">
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
                </div>
              </LandingNavyBoard>
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

            {/* The register */}
            <LandingPanel
              right={
                <>
                  <LandingMeta items={[canAdminManage ? "All entitlements" : "Visible scope review", `${employeeEligibility.length} records`]} />
                  <button
                    className={landingActionClassName("outline", "print:hidden")}
                    onClick={() => exportEntitlementsCSV(sortedEntitlements)}
                    title="Export to CSV"
                    type="button"
                  >
                    <Download aria-hidden="true" className="h-3 w-3" /> CSV
                  </button>
                  <button
                    className={landingActionClassName("outline", "print:hidden")}
                    onClick={() => window.print()}
                    title="Print report"
                    type="button"
                  >
                    <Printer aria-hidden="true" className="h-3 w-3" /> Print
                  </button>
                </>
              }
              title="Employee leave entitlements"
            >
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
                  <thead className="bg-white text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                    <tr>
                      <SortableHeader active={entitlementSort === "fullName"} direction={entitlementSortDir} sortKey="fullName" onSort={toggleEntitlementSort}>Employee</SortableHeader>
                      <SortableHeader active={entitlementSort === "daysSinceHire"} direction={entitlementSortDir} sortKey="daysSinceHire" onSort={toggleEntitlementSort}>Hire &amp; tenure</SortableHeader>
                      <th className="border-b border-slate-200 px-3 py-2.5">Eligibility</th>
                      <SortableHeader active={entitlementSort === "annualBalanceDays"} direction={entitlementSortDir} sortKey="annualBalanceDays" onSort={toggleEntitlementSort}>Balance</SortableHeader>
                      <th className="border-b border-slate-200 px-3 py-2.5">Manager</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">Review</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {paginatedEntitlements.map((row) => (
                      <tr key={row.hrId} className="bg-white align-top transition hover:bg-slate-50 motion-reduce:transition-none">
                        <td className="px-3 py-2.5">
                          <p className={`break-words font-bold ${LANDING_INK}`} dir="auto">{row.displayName}</p>
                          <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "—"}</p>
                          <p className="text-phx-xs text-slate-400">{employmentStatusLabel(row.employmentStatus) || "—"}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className={`font-semibold tabular-nums ${LANDING_INK}`}>{formatDate(row.hireDate)}</p>
                          <p className="mt-0.5 text-phx-xs font-medium tabular-nums text-slate-500">{row.daysSinceHire == null ? "—" : vacationDaysLabel(row.daysSinceHire)} since hire</p>
                          <p className="text-phx-xs tabular-nums text-slate-400">6-mo: {formatDate(row.sixMonthAnniversary)}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <StateText tone={eligibilityBadgeVariant(row.eligibilityStatus)}>
                            {eligibilityStatusLabel(row.eligibilityStatus)}
                          </StateText>
                          {row.eligibilityStatus === "first_six_months" && (row.daysUntilEligibility ?? 0) > 0 ? (
                            <p className="mt-1 text-phx-xs font-bold tabular-nums text-amber-700">{vacationDaysLabel(row.daysUntilEligibility ?? 0)} left</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className={`font-bold tabular-nums ${LANDING_INK}`}>{formatDays(row.annualBalanceDays)} left</p>
                          <p className="mt-0.5 text-phx-xs font-medium tabular-nums text-slate-500">
                            {formatDays(row.annualEntitlementDays)} total / {formatDays(row.annualUsedDays)} used
                          </p>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="break-words font-semibold text-slate-700" dir="auto">{row.managerName ?? "—"}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          {row.reviewFlags.length > 0 ? (
                            <div className="flex flex-wrap gap-x-3 gap-y-1">
                              {row.reviewFlags.map((flag) => (
                                <StateText key={flag} tone="warning">{flag}</StateText>
                              ))}
                            </div>
                          ) : (
                            <span className="text-phx-xs font-bold text-emerald-700">No issue</span>
                          )}
                        </td>
                      </tr>
                    ))}
                    {paginatedEntitlements.length === 0 ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-phx-md font-medium text-slate-500" colSpan={6}>
                          No active employees matched the current filters.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <PaginationControls page={entitlementPage} pageSize={PAGE_SIZE} total={sortedEntitlements.length} onPageChange={setEntitlementPage} />
              </div>

              {/* Card view (< xl) — one ruled row per person, the eligibility on its left rail */}
              <div className="block xl:hidden">
                {paginatedEntitlements.length === 0 ? (
                  <p className="px-3 py-6 text-center text-phx-md font-medium text-slate-500">
                    No active employees matched the current filters.
                  </p>
                ) : (
                  paginatedEntitlements.map((row) => (
                    <EntitlementCard key={row.hrId} row={row} />
                  ))
                )}
                <PaginationControls page={entitlementPage} pageSize={PAGE_SIZE} total={sortedEntitlements.length} onPageChange={setEntitlementPage} />
              </div>
            </LandingPanel>
          </div>
        ) : null}

        {/* ══════════════════════════════════════════════════════════ */}
        {/* ── REQUESTS TAB ─────────────────────────────────────── */}
        {/* ══════════════════════════════════════════════════════════ */}

        {showRequestsTab ? (
          <div className="space-y-3">
            {/* Metric cards — the view's ONE navy board */}
            {!initialData ? (
              <LandingNavyBoardLoading label={isSelfView ? "My Requests" : "All Requests"} />
            ) : isSelfView ? (
              <LandingNavyBoard label="My Requests">
                <div className="@container">
                  <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2 @3xl:grid-cols-4">
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
                </div>
              </LandingNavyBoard>
            ) : (
              <LandingNavyBoard label="All Requests">
                <div className="@container">
                  <div className="grid grid-cols-1 gap-2 @xs:grid-cols-2 @2xl:grid-cols-3 @5xl:grid-cols-5">
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
                </div>
              </LandingNavyBoard>
            )}

            {/* HR's operating view (queue by stage, SLA breaches, evidence backlog, the daily SLA
                run). None of it is about the viewer's own requests, so an own-leave viewer skips it.
                One white sheet, the tiles on hairlines, counted off the sheet's own width. */}
            {dashboard && !isSelfView ? (
              <div className={`@container min-w-0 border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
                <div className={cn("grid grid-cols-1 gap-px bg-slate-200", showsDailySlaRunCard({ canAdminManage, isSelfView }) ? "@md:grid-cols-2 @3xl:grid-cols-4" : "@md:grid-cols-3")}>
                  <div className="min-w-0 bg-white p-3 sm:px-4">
                    <p className={ROW_LABEL}>Pending by stage</p>
                    <div className="mt-1.5">
                      <LandingFigure size="md">{dashboard.pendingByStage.total}</LandingFigure>
                    </div>
                    <p className="mt-1 text-phx-xs font-semibold tabular-nums text-slate-500">Manager {dashboard.pendingByStage.manager} / HR {dashboard.pendingByStage.hr}</p>
                  </div>
                  <div className="min-w-0 bg-white p-3 sm:px-4">
                    <p className={ROW_LABEL}>Overdue SLA</p>
                    <div className="mt-1.5">
                      <LandingFigure size="md" tone="text-rose-700">{dashboard.overdueBySla.total}</LandingFigure>
                    </div>
                    <p className="mt-1 text-phx-xs font-semibold tabular-nums text-slate-500">Manager {dashboard.overdueBySla.manager} / HR {dashboard.overdueBySla.hr}</p>
                  </div>
                  <div className="min-w-0 bg-white p-3 sm:px-4">
                    <p className={ROW_LABEL}>Evidence review</p>
                    <div className="mt-1.5">
                      <LandingFigure size="md">{dashboard.evidence.pending + dashboard.evidence.needsFollowUp + dashboard.evidence.rejected}</LandingFigure>
                    </div>
                    <p className="mt-1 text-phx-xs font-semibold tabular-nums text-slate-500">Pending {dashboard.evidence.pending} / rejected {dashboard.evidence.rejected}</p>
                  </div>
                  {/* The background job's last run is an HR operations fact — Super Admin and HR only. */}
                  {showsDailySlaRunCard({ canAdminManage, isSelfView }) ? (
                    <div className="min-w-0 bg-white p-3 sm:px-4">
                      <p className={ROW_LABEL}>Daily SLA run</p>
                      <div className="mt-1.5">
                        <LandingFigure size="md">{dashboard.dailyEscalationRunStatus.status}</LandingFigure>
                      </div>
                      <p className="mt-1 text-phx-xs font-semibold tabular-nums text-slate-500">{dashboard.dailyEscalationRunStatus.runDate ? formatDate(dashboard.dailyEscalationRunStatus.runDate) : "No run recorded"}</p>
                    </div>
                  ) : null}
                </div>
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
              <LandingPanel
                right={
                  <>
                    <LandingMeta items={["Admin controls"]} />
                    <button className={landingActionClassName("solid")} onClick={startAdminAdd} type="button">
                      <Plus aria-hidden="true" className="h-3.5 w-3.5" />
                      Add Vacation
                    </button>
                  </>
                }
                title="Employee master requests"
              >
                {adminMode ? (
                  <div className="grid gap-3 bg-slate-50 px-3 py-3 xs:grid-cols-2 sm:px-4 xl:grid-cols-4">
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
                      <button
                        className={cn(phxButtonAccentClassName, "flex-1 justify-center", LANDING_FOCUS)}
                        disabled={Boolean(actingId)}
                        onClick={submitAdminForm}
                        type="button"
                      >
                        Create Vacation
                      </button>
                      <button
                        className={cn(phxButtonGhostClassName, "justify-center", LANDING_FOCUS)}
                        disabled={Boolean(actingId)}
                        onClick={() => setAdminMode(null)}
                        type="button"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : null}
              </LandingPanel>
            ) : null}

            {/* Requests table */}
            <LandingPanel
              right={
                <>
                  <LandingMeta items={[canAdminManage ? "All requests" : "Request history", `${rows.length} requests`]} />
                  <button
                    className={landingActionClassName("outline", "print:hidden")}
                    onClick={() => exportRequestsCSV(sortedRequests)}
                    title="Export to CSV"
                    type="button"
                  >
                    <Download aria-hidden="true" className="h-3 w-3" /> CSV
                  </button>
                  {canExport ? (
                    <a
                      className={landingActionClassName("outline", "print:hidden")}
                      href={auditExportHref}
                      title="Audit-grade XLSX export"
                    >
                      <Download aria-hidden="true" className="h-3 w-3" /> Audit XLSX
                    </a>
                  ) : null}
                  <button
                    className={landingActionClassName("outline", "print:hidden")}
                    onClick={() => window.print()}
                    title="Print report"
                    type="button"
                  >
                    <Printer aria-hidden="true" className="h-3 w-3" /> Print
                  </button>
                </>
              }
              title={isSelfView ? "My vacation requests" : "Vacation requests"}
            >
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
                  <thead className="bg-white text-phx-xs font-bold uppercase tracking-[0.1em] text-slate-500">
                    <tr>
                      <SortableHeader active={requestSort === "employeeName"} direction={requestSortDir} sortKey="employeeName" onSort={toggleRequestSort}>Employee</SortableHeader>
                      <SortableHeader active={requestSort === "createdAt"} direction={requestSortDir} sortKey="createdAt" onSort={toggleRequestSort}>Submitted</SortableHeader>
                      <th className="border-b border-slate-200 px-3 py-2.5">Type</th>
                      <SortableHeader active={requestSort === "startDate"} direction={requestSortDir} sortKey="startDate" onSort={toggleRequestSort}>Dates</SortableHeader>
                      <th className="border-b border-slate-200 px-3 py-2.5">Balance &amp; pay</th>
                      <SortableHeader active={requestSort === "status"} direction={requestSortDir} sortKey="status" onSort={toggleRequestSort}>Status</SortableHeader>
                      <th className="border-b border-slate-200 px-3 py-2.5">Manager</th>
                      <th className="border-b border-slate-200 px-3 py-2.5">{canAdminManage ? "Decision / Admin" : "Decision"}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200">
                    {paginatedRequests.map((row) => (
                      <tr key={row.id} className="bg-white align-top transition hover:bg-slate-50 motion-reduce:transition-none">
                        <td className="px-3 py-2.5">
                          <p className={`break-words font-bold ${LANDING_INK}`} dir="auto">{row.employeeName}</p>
                          <p className="mt-0.5 break-words text-phx-xs font-medium text-slate-500">{[row.departmentName, row.lineName].filter(Boolean).join(" / ") || "—"}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="break-words text-phx-xs font-semibold tabular-nums text-slate-700">{formatDateTime(row.createdAt)}</p>
                          <p className="mt-0.5 break-words text-phx-xs font-medium tabular-nums text-slate-400" title={row.id}>{row.requestCode}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className={`break-words font-semibold ${LANDING_INK}`}>{vacationTypeLabel(row.vacationType)}</p>
                          <p className="text-phx-xs text-slate-500">{vacationDayPartLabel(row.dayPart)}</p>
                          {row.vacationType === "compensatory" ? (
                            <div className="mt-1.5 border-l-2 border-slate-300 pl-2 text-phx-xs font-semibold leading-4 text-slate-700">
                              <p className="break-words" dir="auto">{row.compensatoryEventName ?? "Event"}</p>
                              <p className="break-words text-slate-500">{[row.compensatoryEventDate, row.compensatoryEventLocation].filter(Boolean).join(" / ")}</p>
                              <RowEvidence canReviewAttachments={canReviewAttachments} row={row} />
                            </div>
                          ) : null}
                          {row.vacationType === "sick" ? <RowEvidence canReviewAttachments={canReviewAttachments} row={row} /> : null}
                          {row.vacationType === "other" && row.notes ? (
                            <p className="mt-1.5 break-words border-l-2 border-amber-400 pl-2 text-phx-xs font-semibold leading-4 text-slate-700" dir="auto">{row.notes}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className={`font-semibold tabular-nums ${LANDING_INK}`}>{formatDate(row.startDate)}</p>
                          <p className="text-phx-xs tabular-nums text-slate-400">to {formatDate(row.endDate)}</p>
                          <p className={`mt-0.5 text-phx-sm font-bold tabular-nums ${LANDING_INK}`}>{vacationDaysLabel(row.durationDays)}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="break-words tabular-nums text-slate-600">
                            <span className="font-semibold">{formatDays(row.balanceBeforeDays)}</span>
                            <span className="mx-1 text-slate-400">&rarr;</span>
                            <span className={`font-bold ${LANDING_INK}`}>{formatDays(row.balanceAfterDays)}</span>
                          </p>
                          <div className="mt-1">
                            <StateText tone={paymentBadgeVariant(row.paymentStatus)}>
                              {paymentStatusLabel(row.paymentStatus)}
                            </StateText>
                          </div>
                          {row.paymentStatus === "partial" ? (
                            <p className="mt-1 text-phx-xs font-bold tabular-nums text-amber-700">
                              {formatDays(row.paidDurationDays)} paid / {formatDays(row.unpaidDurationDays)} unpaid
                            </p>
                          ) : null}
                          {row.unpaidReason ? <p className="mt-1 text-phx-xs font-bold text-amber-700">{vacationUnpaidReasonLabel(row.unpaidReason)}</p> : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <StateText tone={statusBadgeVariant(row.status)}>{dynamicStatusLabel(row)}</StateText>
                          {row.slaStatus.isOverdue ? (
                            <p className="mt-1 text-phx-xs font-bold text-rose-700">SLA overdue</p>
                          ) : null}
                          {row.overlapWarnings.length > 0 ? (
                            <p className="mt-1 text-phx-xs font-bold text-amber-700">{overlapWarningsLabel(row.overlapWarnings.length)}</p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <p className="break-words font-semibold text-slate-700" dir="auto">{row.managerName ?? "—"}</p>
                          {row.managerOfManagerName ? (
                            <p className="mt-0.5 break-words text-phx-xs text-slate-400">
                              MoM: <span dir="auto">{row.managerOfManagerName}</span>
                            </p>
                          ) : null}
                        </td>
                        <td className="px-3 py-2.5">
                          <button
                            className={landingActionClassName("outline", "mb-2")}
                            onClick={() => openRequestReview(row)}
                            type="button"
                          >
                            <FileText aria-hidden="true" className="h-3 w-3" /> Timeline
                            {row.timelineEventCount > 0 ? <span className="tabular-nums">({row.timelineEventCount})</span> : null}
                          </button>
                          {row.canDecide ? (
                            <Link
                              className={landingActionClassName("solid")}
                              href={`${approvalsBase}/${encodeURIComponent(row.id)}`}
                            >
                              <ArrowRight aria-hidden="true" className="h-3 w-3" /> Decide in Leave Approvals
                            </Link>
                          ) : (
                            <div className="text-phx-xs">
                              <p className="font-medium tabular-nums text-slate-600">{row.hrDecisionAt ? formatDateTime(row.hrDecisionAt) : row.managerDecisionAt ? formatDateTime(row.managerDecisionAt) : "—"}</p>
                              {row.managerDecisionComment ? <p className="mt-0.5 break-words leading-4 text-slate-500" dir="auto">{row.managerDecisionComment}</p> : null}
                              {row.hrDecisionComment ? <p className="mt-0.5 break-words leading-4 text-slate-500" dir="auto">{row.hrDecisionComment}</p> : null}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                    {paginatedRequests.length === 0 ? (
                      <tr>
                        <td className="px-4 py-8 text-center text-phx-md font-medium text-slate-500" colSpan={8}>
                          No vacation requests found.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
                <PaginationControls page={requestPage} pageSize={PAGE_SIZE} total={sortedRequests.length} onPageChange={setRequestPage} />
              </div>
              )}

              {/* Card view (< xl) — and every width for an own-leave viewer, two rows side by side
                  from `lg` so a laptop is not one long column. Each card is a ruled row whose left
                  rail is the request's state. */}
              <div className={isSelfView ? "grid lg:grid-cols-2" : "block xl:hidden"}>
                {paginatedRequests.length === 0 ? (
                  <p className="px-3 py-6 text-center text-phx-md font-medium text-slate-500 lg:col-span-2">
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
            </LandingPanel>
          </div>
        ) : null}
      </div>

      {selectedRequest ? (
        <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/40 p-3 print:hidden" role="dialog" aria-modal="true" aria-label="Request review">
          <div className={`flex h-full w-full max-w-xl flex-col overflow-hidden border border-slate-200 bg-white ${adminSoftDepthClassName}`}>
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 p-4">
              <div className="min-w-0">
                <p className="flex items-center gap-2 text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">
                  <LandingTick />
                  Request review
                </p>
                <h3 className={`mt-1 break-words font-mono text-lg font-black ${LANDING_INK}`}>{selectedRequest.requestCode}</h3>
                <p className="break-words text-phx-sm font-semibold text-slate-500">
                  <span dir="auto">{selectedRequest.employeeName}</span> / {dynamicStatusLabel(selectedRequest)}
                </p>
              </div>
              <button
                aria-label="Close request review"
                className={`inline-flex min-h-10 min-w-10 shrink-0 items-center justify-center text-slate-500 transition hover:bg-slate-100 hover:text-[#08111f] motion-reduce:transition-none ${LANDING_FOCUS}`}
                onClick={() => setSelectedRequest(null)}
                type="button"
              >
                <XCircle aria-hidden="true" className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 space-y-4 overflow-y-auto p-4">
              {selectedRequest.overlapWarnings.length > 0 ? (
                <div className="border-l-2 border-amber-400 py-1 pl-3">
                  <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-amber-700">Overlap intelligence</p>
                  <div className="mt-2 space-y-1.5">
                    {selectedRequest.overlapWarnings.map((warning) => (
                      <p className="break-words text-phx-sm font-semibold text-slate-700" key={`${warning.code}-${warning.relatedRequestIds.join("-")}`}>{warning.message}</p>
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
                <div className="border border-slate-200 p-3">
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
                <div className="border border-slate-200 p-3">
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
                    <Button className="h-8 bg-amber-500 text-phx-xs font-bold text-white hover:bg-amber-600" disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("needs_follow_up")} type="button">Needs follow-up</Button>
                    <Button className={cn(phxButtonDangerDenseClassName, "h-8 text-phx-xs font-bold")} disabled={actingId === selectedRequest.id} onClick={() => submitEvidenceReview("rejected")} type="button">Reject</Button>
                  </div>
                </div>
              ) : null}

              <div className="border border-slate-200 p-3">
                <p className="text-phx-xs font-bold uppercase tracking-[0.12em] text-slate-500">Approval timeline</p>
                {timelineLoading ? (
                  <p className="mt-3 text-phx-sm font-semibold text-slate-500">Loading timeline...</p>
                ) : (
                  <div className="mt-3 space-y-3">
                    {timeline.map((event) => (
                      <div className="border-l-2 border-slate-300 pl-3" key={event.id}>
                        <p className={`break-words text-phx-sm font-black ${LANDING_INK}`}>{event.message}</p>
                        <p className="mt-0.5 text-phx-xs font-semibold tabular-nums text-slate-500">{formatDateTime(event.createdAt)} · {timelineEventLabel(event.eventType)}</p>
                      </div>
                    ))}
                    {timeline.length === 0 ? <p className="text-phx-sm font-semibold text-slate-500">No timeline events recorded yet.</p> : null}
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
