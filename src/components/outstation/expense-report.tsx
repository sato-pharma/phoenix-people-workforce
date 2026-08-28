import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Columns3,
  Download,
  FileCheck2,
  FileSpreadsheet,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import type { RefObject } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  formatCurrencyValue,
  formatDateValue,
  formatNumberValue,
} from "@/lib/i18n/format";
import type {
  ExpenseAnalysisResult,
  ExpenseAnalysisValidation,
  ExpenseTripRecord,
  PayrollExpenseReport,
} from "@/lib/payroll/types";
import { cn } from "@/lib/utils";

import { panelClassName, payrollMonths } from "@/components/payroll/dashboard/shared";
import { TableHeaderMenu } from "@/components/payroll/dashboard/table-header-menu";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";


function formatEGP(value: number) {
  return formatCurrencyValue(value);
}

function formatNumber(value: number) {
  return formatNumberValue(value);
}

function formatPayrollDate(value: string | null | undefined) {
  return formatDateValue(value);
}

const expenseTemplateHeaders = [
  "TripID",
  "Employee",
  "HR ID",
  "Role",
  "Start Date",
  "End Date",
  "Expense Type",
  "Transported By",
  "Travel Stay Type",
  "To",
  "Destination",
  "KM",
  "Travel Cost (auto)",
  "Meeting Amount",
  "Allowance",
  "Total",
  "AM Workload",
  "PM Workload",
  "Status",
  "Comments",
] as const;

type ExpenseTemplateHeader = (typeof expenseTemplateHeaders)[number];
type ExpenseTemplateRow = Record<ExpenseTemplateHeader, Date | string | number>;

function expenseTemplateComment(record: ExpenseTripRecord, hrApprovalState: { hrComment: string; hrApproved: boolean }) {
  return [record.hrNotes, hrApprovalState.hrComment]
    .filter(Boolean)
    .join(" | ");
}

function escapeForExcel(value: unknown) {
  const textValue = String(value ?? "");
  return /^[=+\-@]/.test(textValue) ? `'${textValue}` : textValue;
}

// Geography fields are excluded: this grid is a flat spreadsheet-style review of
// Excel-imported/Phoenix trip rows, and capturedLocation is an object (brick/area/region),
// not a renderable cell value — same reason "specialist" is filtered out below for its own
// (pinned-column) reason. Neither raw coordinate is a review-worthy standalone column either.
type ExpenseReviewColumnKey =
  | Exclude<keyof ExpenseTripRecord, "capturedLocation" | "capturedLatitude" | "capturedLongitude">
  | "validation";

const expenseCurrencyKeys = new Set<ExpenseReviewColumnKey>([
  "allowance",
  "meetingAmount",
  "other",
  "total",
  "travelCost",
]);

const expenseNumericKeys = new Set<ExpenseReviewColumnKey>([
  "amWorkload",
  "km",
  "pmWorkload",
  "row",
]);

const expenseDateKeys = new Set<ExpenseReviewColumnKey>(["date", "toDate"]);

const expenseReviewColumns: Array<{
  className?: string;
  key: ExpenseReviewColumnKey;
  label: string;
}> = [
  { className: "min-w-[130px]", key: "validation", label: "Validation" },
  { className: "min-w-[90px]", key: "row", label: "Source Row" },
  { className: "min-w-[130px]", key: "tripId", label: "Trip ID" },
  { className: "min-w-[180px]", key: "specialist", label: "Employee" },
  { className: "min-w-[120px]", key: "hrId", label: "HR ID" },
  { className: "min-w-[140px]", key: "requestType", label: "Expense Type" },
  { className: "min-w-[150px]", key: "tripType", label: "Travel Stay Type" },
  { className: "min-w-[150px]", key: "date", label: "Start Date" },
  { className: "min-w-[150px]", key: "toDate", label: "End Date" },
  { className: "min-w-[240px]", key: "from", label: "From" },
  { className: "min-w-[180px]", key: "to", label: "To" },
  { className: "min-w-[280px]", key: "location", label: "Destination" },
  { className: "min-w-[150px]", key: "transportationType", label: "Transported By" },
  { className: "min-w-[100px]", key: "km", label: "KM" },
  { className: "min-w-[130px]", key: "travelCost", label: "Travel Cost" },
  { className: "min-w-[140px]", key: "meetingAmount", label: "Meeting Amount" },
  { className: "min-w-[120px]", key: "allowance", label: "Allowance" },
  { className: "min-w-[120px]", key: "total", label: "Total" },
  { className: "min-w-[120px]", key: "amWorkload", label: "AM Workload" },
  { className: "min-w-[120px]", key: "pmWorkload", label: "PM Workload" },
  { className: "min-w-[300px]", key: "description", label: "Description" },
  { className: "min-w-[160px]", key: "status", label: "Status" },
  { className: "min-w-[160px]", key: "hr", label: "HR Status" },
  { className: "min-w-[300px]", key: "hrNotes", label: "HR Notes" },
  { className: "min-w-[120px]", key: "open", label: "Open" },
];

// The Employee column is pinned to the left (identity anchor) and the HR-decision
// controls are pinned to the right, so only these "detail" columns live in the
// scrollable middle and can be shown/hidden.
const expenseDetailColumns = expenseReviewColumns.filter((column) => column.key !== "specialist");

// Default-hidden to minimise horizontal scrolling; every column stays one click
// away in the Columns menu. Kept visible by default: Validation, HR ID, Expense
// Type, Start/End Date, Destination, Total, Status.
const expenseDefaultHiddenColumns = new Set<ExpenseReviewColumnKey>([
  "row",
  "tripId",
  "tripType",
  "from",
  "to",
  "transportationType",
  "km",
  "travelCost",
  "meetingAmount",
  "allowance",
  "amWorkload",
  "pmWorkload",
  "description",
  "hr",
  "hrNotes",
  "open",
]);

const expenseColumnPrefsKey = "phoenix.outstation.expense-review.hidden-columns.v1";

// Verified workload evidence (actual iReports360 double-visit mirror) for a trip,
// used to check the sheet's declared AM/PM against reality, day by day.
type WorkloadEvidenceDay = {
  am: number;
  campaign: number;
  date: string;
  other: number;
  pm: number;
  regular: number;
  total: number;
};
type WorkloadEvidence = {
  amWorkload: number;
  campaignVisits: number;
  dateBreakdown: WorkloadEvidenceDay[];
  /** Kind split of the regular visits (see classifyVisitContactKind) — display-only context. */
  doctorVisits: number;
  idleDates: string[];
  institutionVisits: number;
  matchStatus: string;
  matchedDates: string[];
  otherVisits: number;
  pharmacyVisits: number;
  pmWorkload: number;
  regularVisits: number;
  sourceLabel: string;
};
type TripEvidenceState = { status: "loading" | "done" | "error"; data?: WorkloadEvidence; error?: string };

// Tones for RepVisitWorkload.matchStatus — the only statuses `/api/outstation/visit-workload`
// can return (matched | partial | no_activity | unmapped). "unmapped" means the rep has no CRM
// identity mapping, so there is no visit evidence either way — that must read as a warning,
// never a neutral badge.
const workloadStatusTone: Record<string, "success" | "warning" | "danger" | "neutral"> = {
  matched: "success",
  no_activity: "danger",
  partial: "warning",
  unmapped: "warning",
};

// Trip dates arrive as ISO datetimes (e.g. 2026-06-14T00:00:00.000Z); the evidence
// API wants a plain YYYY-MM-DD.
function toIsoDate(value: string | null | undefined) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toISOString().slice(0, 10);
}

function expenseRecordIssues(record: ExpenseTripRecord) {
  const issues: string[] = [];
  const calculatedTotal = record.travelCost + record.meetingAmount + record.allowance;

  if (!record.hrId) issues.push("Missing HR ID");
  if (!record.date) issues.push("Missing date");
  if (!record.to && !record.location) issues.push("Missing destination");
  if (record.total <= 0) issues.push("Zero total");
  if (record.total > 0 && Math.abs(record.total - calculatedTotal) > 1) issues.push("Total mismatch");

  return issues;
}

function expenseColumnRawValue(record: ExpenseTripRecord, key: ExpenseReviewColumnKey) {
  if (key === "validation") {
    const issues = expenseRecordIssues(record);
    return issues.length > 0 ? issues.join(", ") : "Ready";
  }

  return record[key] ?? "";
}

function expenseColumnDisplayValue(record: ExpenseTripRecord, key: ExpenseReviewColumnKey) {
  if (key === "validation") return expenseColumnRawValue(record, key);
  if (expenseDateKeys.has(key)) return formatPayrollDate(String(record[key] ?? ""));
  if (expenseCurrencyKeys.has(key)) return formatEGP(Number(record[key] ?? 0));
  if (expenseNumericKeys.has(key)) return formatNumber(Number(record[key] ?? 0));

  return String(record[key] ?? "") || "-";
}

function buildExpenseValidation(records: ExpenseTripRecord[], warnings: string[] = []): ExpenseAnalysisValidation {
  const missingHrIdRows = records.filter((record) => !record.hrId).length;
  const missingTripDateRows = records.filter((record) => !record.date).length;
  const missingDestinationRows = records.filter((record) => !record.to && !record.location).length;
  const zeroTotalRows = records.filter((record) => record.total <= 0).length;
  const totalMismatchRows = records.filter((record) =>
    record.total > 0 && Math.abs(record.total - (record.travelCost + record.meetingAmount + record.allowance)) > 1,
  ).length;
  const payrollReadyRows = records.filter((record) =>
    record.hrId && record.date && (record.to || record.location) && record.total > 0,
  ).length;
  const errors = records.length === 0 ? ["No expense rows were detected."] : [];

  return {
    errors,
    invalidRows: records.length - payrollReadyRows,
    missingDestinationRows,
    missingHrIdRows,
    missingRequiredColumns: [],
    missingTripDateRows,
    payrollReadyRows,
    recognizedColumns: 0,
    requiredColumns: 0,
    status: errors.length > 0 ? "failed" : warnings.length > 0 || payrollReadyRows < records.length ? "warning" : "passed",
    totalMismatchRows,
    totalRows: records.length,
    warnings,
    zeroTotalRows,
  };
}

type HrApprovalDraft = { hrApproved: boolean; hrComment: string; approvedAmount: number };

/**
 * The HR decision controls, rendered by BOTH the desktop row and the mobile card.
 *
 * Deliberately one component rather than two copies: these inputs write the amount an employee is
 * actually reimbursed, so a phone-only copy that drifted from the desktop one — a missing reason
 * field, a different rounding, a stale disabled rule — would be a payroll defect, not a styling
 * one. Whatever changes here changes in both places or in neither.
 */
function HrDecisionControls({
  amountChanged,
  approval,
  onUpdate,
  originalTotal,
  reasonMissing,
}: {
  amountChanged: boolean;
  approval: HrApprovalDraft;
  onUpdate: (patch: Partial<HrApprovalDraft>) => void;
  originalTotal: number;
  reasonMissing: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Switch
        checked={approval.hrApproved}
        label={approval.hrApproved ? "Approved" : "Approve"}
        onChange={(checked) => onUpdate({ hrApproved: checked })}
      />
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-[10px] font-bold uppercase tracking-[0.1em] text-text-secondary">
          Amount
        </span>
        <input
          className="h-8 w-28 rounded-lg border border-border bg-white px-2 text-right font-mono text-xs text-text focus:border-phx-accent focus:outline-none"
          inputMode="decimal"
          min={0}
          onChange={(event) => onUpdate({ approvedAmount: Number(event.target.value) || 0 })}
          type="number"
          value={String(approval.approvedAmount)}
        />
        {amountChanged ? <Badge variant="warning">was {formatEGP(originalTotal)}</Badge> : null}
      </div>
      <Input
        className={cn("h-8 text-xs", reasonMissing && "border-rose-400")}
        onChange={(event) => onUpdate({ hrComment: event.target.value })}
        placeholder={amountChanged ? "Reason for adjusted amount (required)" : "Reason / comment"}
        value={approval.hrComment}
      />
      {reasonMissing ? (
        <p className="text-[10px] font-semibold text-rose-600">Add a reason for the changed amount.</p>
      ) : null}
    </div>
  );
}

function ExpenseErrorBanner({
  message,
}: {
  message: string;
}) {
  return (
    <AdminCallout tone="danger">
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div>
        <p className="font-semibold">Outstation expenses analysis error</p>
        <p className="mt-1 leading-6">{message}</p>
      </div>
    </AdminCallout>
  );
}

export function buildExpenseAnalysis(fileName: string, records: ExpenseTripRecord[]): ExpenseAnalysisResult {
  const specialists = Array.from(
    records.reduce((map, record) => {
      const current =
        map.get(record.specialist) ??
        {
          allowance: 0,
          meetingAmount: 0,
          other: 0,
          specialist: record.specialist || "Unassigned",
          total: 0,
          travelCost: 0,
          trips: 0,
        };

      current.allowance += record.allowance;
      current.meetingAmount += record.meetingAmount;
      current.total += record.total;
      current.travelCost += record.travelCost;
      current.trips += 1;
      map.set(current.specialist, current);
      return map;
    }, new Map<string, ExpenseAnalysisResult["specialists"][number]>()),
  )
    .map(([, value]) => value)
    .sort((left, right) => right.total - left.total);

  return {
    columns: [],
    fileName,
    records,
    specialists,
    summary: {
      confirmedByFinance: records.filter((record) =>
        record.status.toLowerCase().includes("confirmed by finance"),
      ).length,
      refusedByHr: records.filter((record) => record.hr.toLowerCase().includes("refused")).length,
      specialists: specialists.length,
      systemApproved: records.filter((record) =>
        record.status.toLowerCase().includes("system approval"),
      ).length,
      totalAllowance: records.reduce((sum, record) => sum + record.allowance, 0),
      totalExpenses: records.reduce((sum, record) => sum + record.total, 0),
      totalKm: records.reduce((sum, record) => sum + record.km, 0),
      totalMeetingAmount: records.reduce((sum, record) => sum + record.meetingAmount, 0),
      totalOther: records.reduce((sum, record) => sum + (record.other ?? 0), 0),
      totalTravelCost: records.reduce((sum, record) => sum + record.travelCost, 0),
      trips: records.length,
    },
    validation: buildExpenseValidation(records),
    warnings: [],
  };
}

export function ExpenseReport({
  analysis,
  analyzing,
  error,
  inputRef,
  onImportToPayroll,
  onDeleteReport,
  onReplaceReport,
  onSaveApprovals,
  onSelectReport,
  onUpload,
  payrollMonthsForImport,
  payrollYearsForImport,
  reports,
  selectedReportId,
  deletingReportId,
  importingToPayroll,
  replacingReportId,
  savingApprovals,
}: {
  analysis: ExpenseAnalysisResult | null;
  analyzing: boolean;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onImportToPayroll: (month: number, year: number) => void;
  onDeleteReport: (reportId: string) => void;
  onReplaceReport: (reportId: string, file: File | null) => void;
  onSaveApprovals: (
    records: Array<
      // approvedAmount must be declared here, not just passed: the server stores null when a
      // record arrives without it, so a save that dropped the field would silently reset every
      // amount HR had adjusted back to the full claim.
      ExpenseTripRecord & { approvedAmount: number; hrApproved: boolean; hrComment: string }
    >,
  ) => void;
  onSelectReport: (reportId: string) => void;
  onUpload: (file: File | null) => void;
  payrollMonthsForImport: typeof payrollMonths;
  payrollYearsForImport: string[];
  reports: PayrollExpenseReport[];
  selectedReportId: string | null;
  deletingReportId: string | null;
  importingToPayroll: boolean;
  replacingReportId: string | null;
  savingApprovals: boolean;
}) {
  const [search, setSearch] = useState("");
  const [columnFilters, setColumnFilters] = useState<Record<string, string>>({});
  const [approvals, setApprovals] = useState<Record<string, { hrApproved: boolean; hrComment: string; approvedAmount: number }>>({});
  const [tripDateFrom, setTripDateFrom] = useState("");
  const [tripDateTo, setTripDateTo] = useState("");
  const [importMonth, setImportMonth] = useState(String(new Date().getMonth() + 1));
  const [importYear, setImportYear] = useState(String(new Date().getFullYear()));
  const [replaceReportId, setReplaceReportId] = useState<string | null>(null);
  const [sort, setSort] = useState("total-desc");
  const [hiddenColumns, setHiddenColumns] = useState<Set<ExpenseReviewColumnKey>>(() => {
    // The review table only renders after a client-side data load, so reading the
    // saved preference here (rather than in an effect) is hydration-safe and keeps
    // the initial paint correct.
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(expenseColumnPrefsKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return new Set(parsed as ExpenseReviewColumnKey[]);
        }
      } catch {
        // Ignore unreadable/blocked localStorage — defaults still apply.
      }
    }
    return new Set(expenseDefaultHiddenColumns);
  });
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [tableScrollWidth, setTableScrollWidth] = useState(0);
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const bodyScrollRef = useRef<HTMLDivElement | null>(null);
  const reviewTableRef = useRef<HTMLTableElement | null>(null);
  const scrollSyncing = useRef(false);
  const [expandedTrips, setExpandedTrips] = useState<Set<string>>(() => new Set());
  const [evidenceByTrip, setEvidenceByTrip] = useState<Record<string, TripEvidenceState>>({});
  const replaceReportInputRef = useRef<HTMLInputElement | null>(null);
  const approvalFor = (record: ExpenseTripRecord) => {
    const saved = record as ExpenseTripRecord & {
      hrApproved?: boolean;
      hrComment?: string;
      approvedAmount?: number | null;
    };

    return (
      approvals[record.tripId] ?? {
        hrApproved: Boolean(saved.hrApproved),
        hrComment: saved.hrComment ?? "",
        approvedAmount:
          typeof saved.approvedAmount === "number" ? saved.approvedAmount : record.total,
      }
    );
  };

  function updateApproval(
    record: ExpenseTripRecord,
    patch: Partial<{ hrApproved: boolean; hrComment: string; approvedAmount: number }>,
  ) {
    setApprovals((current) => {
      const saved = record as ExpenseTripRecord & {
        hrApproved?: boolean;
        hrComment?: string;
        approvedAmount?: number | null;
      };
      const base =
        current[record.tripId] ?? {
          hrApproved: Boolean(saved.hrApproved),
          hrComment: saved.hrComment ?? "",
          approvedAmount:
            typeof saved.approvedAmount === "number" ? saved.approvedAmount : record.total,
        };

      return { ...current, [record.tripId]: { ...base, ...patch } };
    });
  }

  function toggleColumnVisibility(key: ExpenseReviewColumnKey) {
    setHiddenColumns((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function loadTripEvidence(record: ExpenseTripRecord) {
    const key = record.tripId;
    if (!record.hrId) return;
    const existing = evidenceByTrip[key];
    if (existing && (existing.status === "loading" || existing.status === "done")) return;

    setEvidenceByTrip((current) => ({ ...current, [key]: { status: "loading" } }));
    try {
      const params = new URLSearchParams({
        employeeHrId: record.hrId,
        tripEndDate: toIsoDate(record.toDate || record.date),
        tripStartDate: toIsoDate(record.date),
      });
      const response = await fetch(`/api/outstation/visit-workload?${params.toString()}`, {
        headers: { accept: "application/json" },
      });
      const payload = await response.json();
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.message || `Request failed (${response.status})`);
      }
      setEvidenceByTrip((current) => ({
        ...current,
        [key]: { data: payload.data as WorkloadEvidence, status: "done" },
      }));
    } catch (error) {
      setEvidenceByTrip((current) => ({
        ...current,
        [key]: { error: error instanceof Error ? error.message : "Workload lookup failed.", status: "error" },
      }));
    }
  }

  function toggleTripExpand(record: ExpenseTripRecord) {
    const willExpand = !expandedTrips.has(record.tripId);
    setExpandedTrips((current) => {
      const next = new Set(current);
      if (next.has(record.tripId)) next.delete(record.tripId);
      else next.add(record.tripId);
      return next;
    });
    if (willExpand) void loadTripEvidence(record);
  }

  function renderTripEvidence(record: ExpenseTripRecord) {
    if (!record.hrId) {
      return (
        <p className="text-xs font-medium text-rose-600">
          This trip has no HR ID, so its actual visits can&apos;t be verified against iReports360.
        </p>
      );
    }

    const entry = evidenceByTrip[record.tripId];
    if (!entry || entry.status === "loading") {
      return (
        <p className="flex items-center gap-2 text-xs text-text-secondary">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading verified workload…
        </p>
      );
    }
    if (entry.status === "error" || !entry.data) {
      return <p className="text-xs font-medium text-rose-600">Couldn&apos;t load workload evidence: {entry.error}</p>;
    }

    const data = entry.data;
    const declaredTotal = record.amWorkload + record.pmWorkload;
    const actualTotal = data.amWorkload + data.pmWorkload;
    const mismatch = declaredTotal !== actualTotal;
    const tone = workloadStatusTone[data.matchStatus] ?? "neutral";

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-text-secondary">Verified workload</span>
          <Badge variant={tone}>{data.matchStatus.replace(/_/g, " ")}</Badge>
          <span className="text-[11px] text-text-secondary">{data.sourceLabel}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary">Declared (sheet)</p>
            <p className="mt-1 font-mono text-sm font-semibold text-text">
              AM {formatNumber(record.amWorkload)} · PM {formatNumber(record.pmWorkload)}
            </p>
          </div>
          <div className={cn("rounded-xl border p-3", mismatch ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-emerald-50")}>
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary">Actual (evidence)</p>
            <p className="mt-1 font-mono text-sm font-semibold text-text">
              AM {formatNumber(data.amWorkload)} · PM {formatNumber(data.pmWorkload)}
            </p>
            {mismatch ? (
              <p className="mt-0.5 text-[10px] font-semibold text-rose-600">
                ≠ declared ({formatNumber(actualTotal)} actual vs {formatNumber(declaredTotal)} declared)
              </p>
            ) : null}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-text-secondary">Visit type</p>
            <p className="mt-1 font-mono text-sm font-semibold text-text">
              Regular {formatNumber(data.regularVisits)} · Campaign {formatNumber(data.campaignVisits)}
            </p>
            {/* Doctor/pharmacy/institution mix of the regular visits — display-only context so the
                approver can see WHAT kind of fieldwork justified the trip; no rule consumes it. */}
            <p className="mt-0.5 text-[10px] text-text-secondary">
              Doctor {formatNumber(data.doctorVisits)} · Pharmacy {formatNumber(data.pharmacyVisits)} · Institution{" "}
              {formatNumber(data.institutionVisits)}
              {data.regularVisits > data.doctorVisits + data.pharmacyVisits + data.institutionVisits
                ? ` · Unclassified ${formatNumber(data.regularVisits - data.doctorVisits - data.pharmacyVisits - data.institutionVisits)}`
                : ""}
            </p>
          </div>
        </div>
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <PortalResponsiveDataList
            empty={<p className="px-3 py-6 text-center text-xs font-semibold text-slate-400">No days in range.</p>}
            getKey={(day) => day.date}
            items={data.dateBreakdown}
            renderCard={(day) => (
              <PortalRecordCard
                accent={day.total === 0 ? "rose" : "sky"}
                status={
                  day.total === 0 ? (
                    <span className="text-xs font-semibold text-rose-600">No activity</span>
                  ) : (
                    <span className="text-xs text-emerald-700">{formatNumber(day.total)} field visits</span>
                  )
                }
                title={formatPayrollDate(day.date)}
              >
                <PortalRecordFields
                  fields={[
                    { label: "AM", value: formatNumber(day.am) },
                    { label: "PM", value: formatNumber(day.pm) },
                    { label: "Regular", value: formatNumber(day.regular) },
                    { label: "Campaign", value: formatNumber(day.campaign) },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable className="text-xs" minWidth="0px">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-[0.1em] text-text-secondary">
              <tr>
                <th className="px-3 py-2 font-semibold">Day</th>
                <th className="px-3 py-2 text-right font-semibold">AM</th>
                <th className="px-3 py-2 text-right font-semibold">PM</th>
                <th className="px-3 py-2 text-right font-semibold">Regular</th>
                <th className="px-3 py-2 text-right font-semibold">Campaign</th>
                <th className="px-3 py-2 text-right font-semibold">Total</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.dateBreakdown.map((day) => (
                <tr className={day.total === 0 ? "bg-rose-50/60" : undefined} key={day.date}>
                  <td className="whitespace-nowrap px-3 py-2 font-medium text-text">{formatPayrollDate(day.date)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text">{formatNumber(day.am)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text">{formatNumber(day.pm)}</td>
                  <td className="px-3 py-2 text-right font-mono text-sky-700">{formatNumber(day.regular)}</td>
                  <td className="px-3 py-2 text-right font-mono text-violet-700">{formatNumber(day.campaign)}</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold text-text">{formatNumber(day.total)}</td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {day.total === 0 ? (
                      <span className="font-semibold text-rose-600">No activity</span>
                    ) : (
                      <span className="text-emerald-700">{formatNumber(day.total)} field visits</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
              </PortalDesktopTable>
            )}
          />
        </div>
      </div>
    );
  }
  const records = useMemo(() => {
    const query = search.trim().toLowerCase();
    const fromDate = tripDateFrom ? new Date(`${tripDateFrom}T00:00:00`) : null;
    const toDate = tripDateTo ? new Date(`${tripDateTo}T23:59:59`) : null;
    const source = analysis?.records ?? [];
    const filtered = source.filter((record) => {
      const tripDate = record.date ? new Date(record.date) : null;
      const matchesTripDate =
        (!fromDate || (tripDate && tripDate >= fromDate)) &&
        (!toDate || (tripDate && tripDate <= toDate));
      const haystack = [
        record.specialist,
        record.hrId ?? "",
        record.tripId,
        record.from,
        record.to,
        record.transportationType,
        record.status,
        record.description,
      ]
        .join(" ")
        .toLowerCase();
      const matchesSearch = !query || haystack.includes(query);
      const matchesColumns = Object.entries(columnFilters).every(([key, value]) => {
        const filter = value.trim().toLowerCase();
        const columnValue = String(expenseColumnRawValue(record, key as ExpenseReviewColumnKey));

        return !filter || columnValue.toLowerCase().includes(filter);
      });

      return matchesTripDate && matchesSearch && matchesColumns;
    });

    return filtered.slice().sort((left, right) => {
      const [key, direction] = sort.split("-");
      const columnKey = key as ExpenseReviewColumnKey;
      const leftValue = expenseColumnRawValue(left, columnKey);
      const rightValue = expenseColumnRawValue(right, columnKey);

      if (expenseCurrencyKeys.has(columnKey) || expenseNumericKeys.has(columnKey)) {
        const leftNumber = Number(leftValue ?? 0);
        const rightNumber = Number(rightValue ?? 0);
        return direction === "desc" ? rightNumber - leftNumber : leftNumber - rightNumber;
      }

      if (expenseDateKeys.has(columnKey)) {
        const leftTime = leftValue ? new Date(String(leftValue)).getTime() : 0;
        const rightTime = rightValue ? new Date(String(rightValue)).getTime() : 0;
        return direction === "desc" ? rightTime - leftTime : leftTime - rightTime;
      }

      return direction === "desc"
        ? String(rightValue).localeCompare(String(leftValue))
        : String(leftValue).localeCompare(String(rightValue));
    });
  }, [analysis?.records, columnFilters, search, sort, tripDateFrom, tripDateTo]);

  const visibleDetailColumns = useMemo(
    () => expenseDetailColumns.filter((column) => !hiddenColumns.has(column.key)),
    [hiddenColumns],
  );

  // Persist the reviewer's column choices (the initial value is read in useState above).
  useEffect(() => {
    try {
      window.localStorage.setItem(expenseColumnPrefsKey, JSON.stringify([...hiddenColumns]));
    } catch {
      // Ignore quota/blocked storage.
    }
  }, [hiddenColumns]);

  // Mirror the table's real scroll width onto the top proxy scrollbar so it stays
  // grabbable, and re-measure whenever visible columns or row count change.
  useEffect(() => {
    const table = reviewTableRef.current;
    if (!table) return;

    const measure = () => setTableScrollWidth(table.scrollWidth);
    measure();

    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    return () => observer.disconnect();
  }, [visibleDetailColumns.length, records.length]);

  function handleTopScroll() {
    const top = topScrollRef.current;
    const body = bodyScrollRef.current;
    if (!top || !body || top.scrollLeft === body.scrollLeft) return;
    if (scrollSyncing.current) {
      scrollSyncing.current = false;
      return;
    }
    scrollSyncing.current = true;
    body.scrollLeft = top.scrollLeft;
  }

  function handleBodyScroll() {
    const top = topScrollRef.current;
    const body = bodyScrollRef.current;
    if (!top || !body || top.scrollLeft === body.scrollLeft) return;
    if (scrollSyncing.current) {
      scrollSyncing.current = false;
      return;
    }
    scrollSyncing.current = true;
    top.scrollLeft = body.scrollLeft;
  }

  const approvedRecords = (analysis?.records ?? []).filter((record) => approvalFor(record).hrApproved);
  const approvedTotal = approvedRecords.reduce((sum, record) => sum + approvalFor(record).approvedAmount, 0);
  const unmappedRecords = (analysis?.records ?? []).filter((record) => !record.hrId);
  const missingTripDateRecords = (analysis?.records ?? []).filter((record) => !record.date);
  const filteredTotal = records.reduce((sum, record) => sum + record.total, 0);
  const unjustifiedAmountRows = (analysis?.records ?? []).filter((record) => {
    const approval = approvalFor(record);
    return Math.abs(approval.approvedAmount - record.total) > 0.5 && !approval.hrComment.trim();
  }).length;
  const validation = analysis?.validation ?? buildExpenseValidation(analysis?.records ?? []);
  const expenseFilterCount =
    (search.trim() ? 1 : 0) +
    (tripDateFrom ? 1 : 0) +
    (tripDateTo ? 1 : 0) +
    Object.values(columnFilters).filter((value) => value.trim()).length;

  function saveApprovals() {
    if (!analysis) return;

    onSaveApprovals(
      analysis.records.map((record) => {
        const approval = approvalFor(record);
        return {
          ...record,
          approvedAmount: approval.approvedAmount,
          hrApproved: approval.hrApproved,
          hrComment: approval.hrComment,
        };
      }),
    );
  }

  function importToPayroll() {
    if (!analysis) return;

    onImportToPayroll(Number(importMonth), Number(importYear));
  }

  function downloadFilteredExpenses() {
    void (async () => {
      const ExcelJS = (await import("exceljs")).default;
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Outstation expenses");

      workbook.creator = "Phoenix Workforce";
      workbook.created = new Date();
      sheet.properties.defaultRowHeight = 22;
      sheet.views = [{ state: "frozen", ySplit: 2 }];
      const title = `Outstation expenses - ${records.length} trip(s)`;

      sheet.mergeCells(1, 1, 1, expenseTemplateHeaders.length);
      sheet.getCell("A1").value = title;
      sheet.getCell("A1").alignment = {
        horizontal: "left",
        vertical: "middle",
      };
      sheet.getCell("A1").font = { bold: true, color: { argb: "FFFFFFFF" } };
      sheet.getCell("A1").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF0F172A" },
      };

      sheet.columns = expenseTemplateHeaders.map((header, index) => ({
        header,
        key: header,
        width: [12, 30, 12, 18, 12, 12, 15, 16, 16, 16, 34, 14, 16, 14, 14, 13, 13, 14, 24, 30][index],
      }));

      const headerRow = sheet.getRow(2);
      headerRow.values = [...expenseTemplateHeaders];
      headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
      headerRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF1F2937" },
      };
      headerRow.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      headerRow.height = 28;
      sheet.autoFilter = {
        from: { column: 1, row: 2 },
        to: { column: expenseTemplateHeaders.length, row: 2 },
      };

      const rows: ExpenseTemplateRow[] = records.map((record): ExpenseTemplateRow => {
        const approvalState = approvalFor(record);
        return {
          "TripID": record.tripId,
          "Employee": escapeForExcel(record.specialist),
          "HR ID": record.hrId ?? "",
          "Role": escapeForExcel(record.requestType),
          "Start Date": record.date ? new Date(record.date) : "",
          "End Date": record.toDate ? new Date(record.toDate) : "",
          "Expense Type": escapeForExcel(record.requestType),
          "Transported By": escapeForExcel(record.transportationType),
          "Travel Stay Type": escapeForExcel(record.tripType),
          "To": escapeForExcel(record.to),
          "Destination": escapeForExcel(record.location || record.to),
          "KM": record.km,
          "Travel Cost (auto)": record.travelCost,
          "Meeting Amount": record.meetingAmount,
          "Allowance": record.allowance,
          "Total": record.total,
          "AM Workload": record.amWorkload,
          "PM Workload": record.pmWorkload,
          "Status": escapeForExcel(record.status),
          "Comments": escapeForExcel(expenseTemplateComment(record, approvalState)),
        };
      });

      const rowValues = rows.map((row) => [
        row.TripID,
        row.Employee,
        row["HR ID"],
        row.Role,
        row["Start Date"],
        row["End Date"],
        row["Expense Type"],
        row["Transported By"],
        row["Travel Stay Type"],
        row.To,
        row.Destination,
        row.KM,
        row["Travel Cost (auto)"],
        row["Meeting Amount"],
        row.Allowance,
        row.Total,
        row["AM Workload"],
        row["PM Workload"],
        row.Status,
        row.Comments,
      ]);
      sheet.addRows(rowValues);
      [5, 6].forEach((columnNumber) => {
        sheet.getColumn(columnNumber).numFmt = "yyyy-mm-dd";
      });
      [12, 13, 14, 15, 16, 17, 18].forEach((columnNumber) => {
        sheet.getColumn(columnNumber).numFmt = "#,##0.00";
      });
      sheet.eachRow((row, rowNumber) => {
        row.height = rowNumber === 1 ? 30 : rowNumber === 2 ? 28 : 22;
        row.eachCell({ includeEmpty: true }, (cell) => {
          cell.alignment = {
            horizontal: rowNumber <= 2 ? "center" : "left",
            vertical: "middle",
            wrapText: rowNumber > 1,
          };
          cell.border = {
            bottom: { color: { argb: "FFE5E7EB" }, style: "thin" },
            left: { color: { argb: "FFE5E7EB" }, style: "thin" },
            right: { color: { argb: "FFE5E7EB" }, style: "thin" },
            top: { color: { argb: "FFE5E7EB" }, style: "thin" },
          };
        });
      });
      const output = await workbook.xlsx.writeBuffer();
      const blob = new Blob([output], {
        type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `phoenix-outstation-expenses-${new Date().toISOString().slice(0, 10)}.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    })();
  }

  return (
    <Card className={`${panelClassName} overflow-hidden p-0`}>
      <div className="relative overflow-hidden border-b border-[#1F2937] bg-[radial-gradient(circle_at_top_right,rgba(249,115,22,0.24),transparent_34%),linear-gradient(135deg,#080B10_0%,#111827_58%,#24150D_100%)] px-5 py-6 text-white">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-16 -top-20 h-48 w-48 rounded-full bg-phx-accent/20 blur-3xl"
        />
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="relative z-10">
            <p className="inline-flex rounded-full border border-phx-accent/35 bg-phx-accent/12 px-3 py-1 text-[11px] font-black uppercase tracking-[0.22em] text-phx-accent">
              Outstation Expense Operations
            </p>
            <h2 className="mt-3 text-2xl font-black tracking-tight text-white">Outstation Expenses Report</h2>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-phx-line-strong">
              {analysis
                ? `${analysis.fileName} - ${formatNumber(analysis.summary.trips)} trips saved for review`
                : "Upload a historical outstation expenses sheet, approve rows from HR, then import approved expenses into payroll."}
            </p>
            {analysis?.template ? (
              <p className="mt-2 text-xs leading-6 text-[#FDE68A]">
                {analysis.template.recognized
                  ? `Template recognized: ${analysis.template.name}`
                  : `Template detected: ${analysis.template.name}`}
              </p>
            ) : null}
          </div>
          <div className="relative z-10 flex flex-wrap items-center gap-2">
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => onUpload(event.target.files?.[0] ?? null)}
            ref={inputRef}
            type="file"
          />
          <Button
            className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(0,0,0,0.18)] hover:bg-white/16"
            disabled={analyzing}
            onClick={() => inputRef.current?.click()}
            variant="secondary"
          >
            {analyzing ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            Upload Historical Expenses
          </Button>
          <Button
            className="rounded-2xl border border-white/15 bg-white/10 px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(0,0,0,0.18)] hover:bg-white/16"
            disabled={!analysis || records.length === 0}
            onClick={downloadFilteredExpenses}
            variant="secondary"
          >
            <Download className="mr-2 h-4 w-4" />
            Download Outstation Expenses
          </Button>
          <Button
            className="rounded-2xl border border-phx-accent-line/40 bg-phx-accent px-3 py-2 text-xs text-white shadow-[0_14px_30px_rgba(249,115,22,0.22)] hover:bg-phx-accent-hover"
            disabled={!analysis || savingApprovals}
            onClick={saveApprovals}
            variant="secondary"
          >
            {savingApprovals ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <FileCheck2 className="mr-2 h-4 w-4" />
            )}
            Save HR/Admin Approvals
          </Button>
          </div>
        </div>
      </div>

      <div className="space-y-4 p-5">
      {error && <ExpenseErrorBanner message={error} />}

      {reports.length > 0 && (
        <div className="overflow-hidden rounded-[28px] border border-phx-line bg-white/94 shadow-[0_16px_38px_rgba(15,23,42,0.07)]">
          <input
            accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="hidden"
            onChange={(event) => {
              onReplaceReport(replaceReportId ?? "", event.target.files?.[0] ?? null);
              event.target.value = "";
            }}
            ref={replaceReportInputRef}
            type="file"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-phx-line bg-[linear-gradient(135deg,#F8FAFC_0%,#FFF7ED_100%)] px-4 py-3">
            <div>
              <h3 className="text-sm font-semibold text-phx-ink">Historical Outstation Uploads</h3>
              <p className="mt-0.5 text-xs text-phx-ink-soft">
                Preview, replace, or delete historical uploaded expense reports from the system database.
              </p>
            </div>
            <Badge variant="neutral">{formatNumber(reports.length)} reports</Badge>
          </div>
          <div className="divide-y divide-slate-100">
            {reports.slice(0, 12).map((report) => (
              <div
                className={cn(
                  "flex flex-wrap items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-phx-accent-soft/70",
                  selectedReportId === report.id && "bg-emerald-50/80 ring-1 ring-inset ring-emerald-200",
                )}
                key={report.id}
              >
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-text">{report.fileName}</p>
                  <p className="text-xs text-text-secondary">
                    {formatNumber(report.rowCount)} rows - {formatPayrollDate(report.tripDateFrom)} to {formatPayrollDate(report.tripDateTo)} - uploaded {formatPayrollDate(report.createdAt)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <div className="mr-2 text-right">
                    <p className="font-mono text-sm font-semibold text-text">{formatEGP(report.totalExpenses)}</p>
                    <p className="text-xs text-text-secondary">{formatNumber(report.approvedRows)} approved</p>
                  </div>
                  <Button className="px-3 py-1.5 text-xs" onClick={() => onSelectReport(report.id)} variant="secondary">
                    <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
                    Preview
                  </Button>
                  <Button
                    className="px-3 py-1.5 text-xs"
                    disabled={replacingReportId === report.id}
                    onClick={() => {
                      setReplaceReportId(report.id);
                      replaceReportInputRef.current?.click();
                    }}
                    variant="secondary"
                  >
                    {replacingReportId === report.id ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Upload className="mr-2 h-3.5 w-3.5" />
                    )}
                    Replace
                  </Button>
                  <Button
                    className="px-3 py-1.5 text-xs"
                    disabled={deletingReportId === report.id}
                    onClick={() => onDeleteReport(report.id)}
                    variant="secondary"
                  >
                    {deletingReportId === report.id ? (
                      <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Trash2 className="mr-2 h-3.5 w-3.5" />
                    )}
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {analysis ? (
        <div className="space-y-5">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
            {[
              { label: "Trips", tone: "bg-phx-paper text-phx-ink", value: formatNumber(analysis.summary.trips) },
              { label: "Specialists", tone: "bg-phx-paper text-phx-ink", value: formatNumber(analysis.summary.specialists) },
              { label: "Filtered Total", tone: "bg-orange-50 text-orange-800", value: formatEGP(filteredTotal) },
              { label: "Travel Cost", tone: "bg-amber-50 text-amber-800", value: formatEGP(analysis.summary.totalTravelCost) },
              { label: "HR/Admin Approved", tone: "bg-emerald-50 text-emerald-800", value: formatEGP(approvedTotal) },
              { label: "Unmapped", tone: "bg-rose-50 text-rose-800", value: formatNumber(unmappedRecords.length) },
            ].map((metric) => (
              <div className={cn("rounded-2xl border border-phx-line p-4", metric.tone)} key={metric.label}>
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] opacity-70">{metric.label}</p>
                <p className="mt-2 truncate font-mono text-lg font-bold">{metric.value}</p>
              </div>
            ))}
          </div>

          <AdminCallout
            tone={validation.status === "failed" ? "danger" : validation.status === "warning" ? "warning" : "success"}
          >
            {validation.status === "passed" ? (
              <FileCheck2 className="mt-0.5 h-5 w-5 shrink-0" />
            ) : (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-semibold">
                  Validation {validation.status === "passed" ? "passed" : validation.status === "failed" ? "failed" : "has warnings"}
                </p>
                <Badge variant={validation.status === "passed" ? "success" : validation.status === "failed" ? "danger" : "warning"}>
                  {formatNumber(validation.payrollReadyRows)} payroll-ready / {formatNumber(validation.totalRows)} rows
                </Badge>
              </div>
              <div className="mt-3 grid gap-2 text-xs md:grid-cols-3 xl:grid-cols-6">
                {[
                  ["Template columns", `${formatNumber(validation.recognizedColumns)} / ${formatNumber(validation.requiredColumns)}`],
                  ["Missing HR ID", formatNumber(validation.missingHrIdRows)],
                  ["Missing dates", formatNumber(validation.missingTripDateRows)],
                  ["Missing destination", formatNumber(validation.missingDestinationRows)],
                  ["Zero totals", formatNumber(validation.zeroTotalRows)],
                  ["Total mismatches", formatNumber(validation.totalMismatchRows)],
                ].map(([label, value]) => (
                  <div className="rounded-lg border border-current/10 bg-white/65 px-3 py-2" key={label}>
                    <p className="font-bold uppercase tracking-[0.12em] opacity-70">{label}</p>
                    <p className="mt-1 font-mono text-sm font-semibold">{value}</p>
                  </div>
                ))}
              </div>
              {validation.missingRequiredColumns.length > 0 ? (
                <p className="mt-3 text-xs leading-5">
                  Missing template columns: {validation.missingRequiredColumns.join(", ")}
                </p>
              ) : null}
              {(validation.errors.length > 0 || validation.warnings.length > 0) ? (
                <p className="mt-2 text-xs leading-5">
                  {[...validation.errors, ...validation.warnings].slice(0, 4).join(" ")}
                </p>
              ) : null}
            </div>
          </AdminCallout>

          <div className="flex flex-wrap items-center gap-2 rounded-[28px] border border-phx-line bg-white/90 p-4 shadow-[0_16px_38px_rgba(15,23,42,0.06)]">
            <div className="mr-2">
              <p className="text-sm font-semibold text-phx-ink">Import to Payroll</p>
              <p className="text-xs text-phx-ink-soft">Saved HR/admin approved rows with HR ID only.</p>
            </div>
            <SearchableSelect
              className="h-10 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-sm text-phx-ink focus:outline-none"
              onChange={(event) => setImportMonth(event.target.value)}
              value={importMonth}
            >
              {payrollMonthsForImport.map((month) => (
                <option key={month.value} value={month.value}>
                  {month.label}
                </option>
              ))}
            </SearchableSelect>
            <SearchableSelect
              className="h-10 rounded-2xl border border-[#D7E0EA] bg-white px-3 text-sm text-phx-ink focus:outline-none"
              onChange={(event) => setImportYear(event.target.value)}
              value={importYear}
            >
              {payrollYearsForImport.map((year) => (
                <option key={year} value={year}>
                  {year}
                </option>
              ))}
            </SearchableSelect>
            <Button disabled={!analysis || importingToPayroll || validation.invalidRows > 0} onClick={importToPayroll}>
              {importingToPayroll ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <FileCheck2 className="mr-2 h-4 w-4" />
              )}
              Import to Payroll
            </Button>
            <p className="text-xs text-text-secondary">
              Import requires all rows to pass validation and uses only approvals already saved by HR/admin.
            </p>
          </div>

          <div className="grid gap-3 rounded-[28px] border border-phx-line bg-phx-paper/80 p-3 md:grid-cols-[1fr_180px_180px_auto]">
            <Input
              className="bg-white"
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search specialist, HR ID, route, trip, status..."
              value={search}
            />
            <input
              className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text focus:outline-none"
              onChange={(event) => setTripDateFrom(event.target.value)}
              type="date"
              value={tripDateFrom}
            />
            <input
              className="h-10 rounded-lg border border-border bg-white px-3 text-sm text-text focus:outline-none"
              onChange={(event) => setTripDateTo(event.target.value)}
              type="date"
              value={tripDateTo}
            />
            <Button
              onClick={() => {
                setSearch("");
                setTripDateFrom("");
                setTripDateTo("");
                setColumnFilters({});
              }}
              variant="secondary"
            >
              Reset {expenseFilterCount > 0 ? `(${expenseFilterCount})` : ""}
            </Button>
          </div>

          <div className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-phx-ink-soft">
                <span>Review &amp; approve</span>
                <Badge variant="neutral">{formatNumber(records.length)} rows</Badge>
                <span className="hidden font-normal normal-case tracking-normal text-text-secondary sm:inline">
                  Employee and HR Decision stay pinned.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden text-xs text-text-secondary sm:inline">
                  {formatNumber(visibleDetailColumns.length)} of {formatNumber(expenseDetailColumns.length)} detail columns
                </span>
                <div className="relative">
                  <Button
                    className="h-9 px-3 text-xs"
                    onClick={() => setColumnsMenuOpen((open) => !open)}
                    variant="secondary"
                  >
                    <Columns3 className="mr-2 h-3.5 w-3.5" />
                    Columns
                  </Button>
                  {columnsMenuOpen ? (
                    <>
                      <div className="fixed inset-0 z-30" onClick={() => setColumnsMenuOpen(false)} />
                      <div className="absolute right-0 z-40 mt-1 max-h-[340px] w-64 overflow-y-auto rounded-2xl border border-border bg-card p-2 shadow-xl">
                        <div className="flex items-center justify-between px-2 pb-2 pt-1">
                          <span className="text-[11px] font-bold uppercase tracking-[0.14em] text-text-secondary">
                            Detail columns
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              className="text-[11px] font-semibold text-phx-accent-hover hover:underline"
                              onClick={() => setHiddenColumns(new Set())}
                              type="button"
                            >
                              Show all
                            </button>
                            <button
                              className="text-[11px] font-semibold text-text-secondary hover:underline"
                              onClick={() => setHiddenColumns(new Set(expenseDefaultHiddenColumns))}
                              type="button"
                            >
                              Reset
                            </button>
                          </div>
                        </div>
                        {expenseDetailColumns.map((column) => (
                          <label
                            className="flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-text hover:bg-bg-muted"
                            key={column.key}
                          >
                            <input
                              checked={!hiddenColumns.has(column.key)}
                              className="accent-phx-accent"
                              onChange={() => toggleColumnVisibility(column.key)}
                              type="checkbox"
                            />
                            {column.label}
                          </label>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </div>
            </div>

            {unjustifiedAmountRows > 0 ? (
              <div className="flex items-center gap-2 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-2.5 text-xs font-medium text-rose-700">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {formatNumber(unjustifiedAmountRows)} row(s) have an adjusted amount without a reason — add a reason so the change is auditable.
              </div>
            ) : null}

            <div className="overflow-hidden rounded-[28px] border border-phx-line bg-white shadow-[0_16px_38px_rgba(15,23,42,0.06)]">
              {/* Below `md` the review is a card list. This table is 1,240px+ with a sticky
                  employee column and a sticky HR-decision column, so on a phone it was a sideways
                  scroll whose *decision controls* — the whole point of the screen — sat off the
                  right edge. The cards carry the same <HrDecisionControls>, so nothing is
                  read-only on mobile that is editable on desktop. */}
              <div className="divide-y divide-slate-100 md:hidden">
                {records.length === 0 ? (
                  <p className="px-4 py-8 text-center text-sm text-text-secondary">
                    No expenses match the current filters.
                  </p>
                ) : (
                  records.slice(0, 250).map((record) => {
                    const issues = expenseRecordIssues(record);
                    const approval = approvalFor(record);
                    const amountChanged = Math.abs(approval.approvedAmount - record.total) > 0.5;
                    const reasonMissing = amountChanged && !approval.hrComment.trim();
                    const isExpanded = expandedTrips.has(record.tripId);

                    return (
                      <PortalRecordCard
                        accent={reasonMissing ? "rose" : issues.length > 0 ? "amber" : "orange"}
                        key={`card-${record.tripId}-${record.row}`}
                        meta={record.hrId ? record.hrId : "HR ID not mapped"}
                        status={
                          <Badge variant={issues.length > 0 ? "warning" : "success"}>
                            {issues.length > 0 ? issues.join(", ") : "Ready"}
                          </Badge>
                        }
                        title={record.specialist || "Unassigned"}
                      >
                        <PortalRecordFields
                          fields={visibleDetailColumns
                            .filter((column) => column.key !== "validation" && column.key !== "hrId")
                            .map((column) => ({
                              label: column.label,
                              value: expenseColumnDisplayValue(record, column.key),
                            }))}
                        />
                        <div className="mt-3 border-t border-slate-100 pt-3">
                          <HrDecisionControls
                            amountChanged={amountChanged}
                            approval={approval}
                            onUpdate={(patch) => updateApproval(record, patch)}
                            originalTotal={record.total}
                            reasonMissing={reasonMissing}
                          />
                        </div>
                        <button
                          className="mt-3 inline-flex items-center gap-1 rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600"
                          onClick={() => toggleTripExpand(record)}
                          type="button"
                        >
                          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          {isExpanded ? "Hide" : "Verify"} workload
                        </button>
                        {isExpanded ? <div className="mt-3">{renderTripEvidence(record)}</div> : null}
                      </PortalRecordCard>
                    );
                  })
                )}
              </div>

              <div
                aria-hidden="true"
                className="hidden overflow-x-auto overflow-y-hidden border-b border-[#EEF2F6] bg-phx-paper md:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300 hover:[&::-webkit-scrollbar-thumb]:bg-slate-400 [&::-webkit-scrollbar]:h-3"
                onScroll={handleTopScroll}
                ref={topScrollRef}
              >
                <div style={{ height: 1, width: tableScrollWidth }} />
              </div>
              <div
                className="hidden max-h-[70vh] overflow-auto md:block [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-slate-300 hover:[&::-webkit-scrollbar-thumb]:bg-slate-400 [&::-webkit-scrollbar]:h-3 [&::-webkit-scrollbar]:w-3"
                onScroll={handleBodyScroll}
                ref={bodyScrollRef}
              >
                <table className="w-max min-w-full border-separate border-spacing-0 text-left text-sm" ref={reviewTableRef}>
                  <thead>
                    <tr className="text-xs uppercase tracking-[0.12em] text-phx-ink-soft">
                      <th className="sticky left-0 top-0 z-30 min-w-[210px] border-b border-r border-phx-line bg-phx-paper px-3 py-3 align-top font-semibold shadow-[8px_0_12px_-12px_rgba(15,23,42,0.45)]">
                        <TableHeaderMenu
                          filterValue={columnFilters.specialist ?? ""}
                          label="Employee"
                          onFilterChange={(value) =>
                            setColumnFilters((filters) => ({ ...filters, specialist: value }))
                          }
                          onSortAsc={() => setSort("specialist-asc")}
                          onSortDesc={() => setSort("specialist-desc")}
                        />
                      </th>
                      {visibleDetailColumns.map((column) => (
                        <th className={cn("sticky top-0 z-20 whitespace-nowrap border-b border-phx-line bg-phx-paper px-3 py-3 align-top font-semibold", column.className)} key={column.key}>
                          <TableHeaderMenu
                            filterValue={columnFilters[column.key] ?? ""}
                            label={column.label}
                            onFilterChange={(value) =>
                              setColumnFilters((filters) => ({
                                ...filters,
                                [column.key]: value,
                              }))
                            }
                            onSortAsc={() => setSort(`${column.key}-asc`)}
                            onSortDesc={() => setSort(`${column.key}-desc`)}
                          />
                        </th>
                      ))}
                      <th className="sticky right-0 top-0 z-30 min-w-[320px] border-b border-l border-phx-line bg-phx-paper px-3 py-3 text-left align-top font-semibold shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.45)]">
                        HR Decision
                        <span className="mt-1 block text-[10px] font-medium normal-case tracking-normal text-text-secondary">
                          Approve · adjust amount · add reason
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.length === 0 ? (
                      <tr>
                        <td className="px-3 py-8 text-center text-sm text-text-secondary" colSpan={visibleDetailColumns.length + 2}>
                          No expenses match the current filters.
                        </td>
                      </tr>
                    ) : (
                      records.slice(0, 250).map((record) => {
                        const issues = expenseRecordIssues(record);
                        const approval = approvalFor(record);
                        const amountChanged = Math.abs(approval.approvedAmount - record.total) > 0.5;
                        const reasonMissing = amountChanged && !approval.hrComment.trim();
                        const isExpanded = expandedTrips.has(record.tripId);

                        return (
                        <Fragment key={`${record.tripId}-${record.row}`}>
                        <tr className="group">
                          <td className="sticky left-0 z-10 min-w-[210px] border-b border-r border-slate-100 bg-white px-3 py-3 align-top shadow-[8px_0_12px_-12px_rgba(15,23,42,0.35)] group-hover:bg-phx-accent-soft">
                            <p className="whitespace-nowrap font-semibold text-text">{record.specialist || "Unassigned"}</p>
                            <p className="mt-0.5 whitespace-nowrap font-mono text-[11px] text-text-secondary">
                              {record.hrId ? record.hrId : "HR ID not mapped"}
                            </p>
                            <div className="mt-1.5 flex flex-wrap items-center gap-1">
                              <span className="whitespace-nowrap rounded-md bg-sky-50 px-1.5 py-0.5 text-[10px] font-bold text-sky-700">
                                AM {formatNumber(record.amWorkload)}
                              </span>
                              <span className="whitespace-nowrap rounded-md bg-violet-50 px-1.5 py-0.5 text-[10px] font-bold text-violet-700">
                                PM {formatNumber(record.pmWorkload)}
                              </span>
                              <span className="text-[9px] font-semibold uppercase tracking-wide text-text-secondary">declared</span>
                            </div>
                            <button
                              className="mt-1.5 inline-flex items-center gap-1 whitespace-nowrap rounded-md border border-slate-200 px-1.5 py-0.5 text-[10px] font-semibold text-slate-600 hover:bg-slate-50"
                              onClick={() => toggleTripExpand(record)}
                              type="button"
                            >
                              {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                              {isExpanded ? "Hide" : "Verify"} workload
                            </button>
                          </td>
                          {visibleDetailColumns.map((column) => {
                            const rawValue = expenseColumnRawValue(record, column.key);
                            const displayValue = expenseColumnDisplayValue(record, column.key);
                            const isMoney = expenseCurrencyKeys.has(column.key);
                            const isNumeric = expenseNumericKeys.has(column.key);

                            if (column.key === "validation") {
                              return (
                                <td className={cn("whitespace-nowrap border-b border-slate-100 px-3 py-3 align-top group-hover:bg-phx-accent-soft", column.className)} key={column.key}>
                                  <Badge variant={issues.length > 0 ? "warning" : "success"}>
                                    {issues.length > 0 ? issues.join(", ") : "Ready"}
                                  </Badge>
                                </td>
                              );
                            }

                            if (column.key === "hrId") {
                              return (
                                <td className={cn("whitespace-nowrap border-b border-slate-100 px-3 py-3 align-top font-mono text-xs text-text-secondary group-hover:bg-phx-accent-soft", column.className)} key={column.key}>
                                  {record.hrId ? record.hrId : (
                                    <Badge variant="warning">Not mapped</Badge>
                                  )}
                                </td>
                              );
                            }

                            return (
                              <td
                                className={cn(
                                  "whitespace-nowrap border-b border-slate-100 px-3 py-3 align-top text-text-secondary group-hover:bg-phx-accent-soft",
                                  column.className,
                                  (isMoney || isNumeric) && "text-right font-mono text-xs",
                                  column.key === "total" && "font-semibold text-text",
                                )}
                                key={column.key}
                                title={String(rawValue ?? "")}
                              >
                                {displayValue}
                              </td>
                            );
                          })}
                          <td
                            className={cn(
                              "sticky right-0 z-10 min-w-[320px] border-b border-l border-slate-100 bg-white px-3 py-3 align-top shadow-[-8px_0_12px_-12px_rgba(15,23,42,0.35)] group-hover:bg-phx-accent-soft",
                              reasonMissing && "bg-rose-50/80 group-hover:bg-rose-50",
                            )}
                          >
                            <HrDecisionControls
                              amountChanged={amountChanged}
                              approval={approval}
                              onUpdate={(patch) => updateApproval(record, patch)}
                              originalTotal={record.total}
                              reasonMissing={reasonMissing}
                            />
                          </td>
                        </tr>
                        {isExpanded ? (
                          <tr className="bg-slate-50/70">
                            <td className="border-b border-slate-200 p-0" colSpan={visibleDetailColumns.length + 2}>
                              <div className="sticky left-0 w-[min(920px,100%)] p-4">
                                {renderTripEvidence(record)}
                              </div>
                            </td>
                          </tr>
                        ) : null}
                        </Fragment>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
            {records.length > 250 ? (
              <p className="text-xs text-text-secondary">
                Showing first 250 rows. Use filters or hide columns to narrow the review.
              </p>
            ) : null}
          </div>

          {analysis.warnings.length > 0 ? (
            <div className="rounded-[20px] border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
              {analysis.warnings.slice(0, 3).join(" ")}
            </div>
          ) : null}
          {(unmappedRecords.length > 0 || missingTripDateRecords.length > 0) && (
            <div className="rounded-[20px] border border-[#FDE68A] bg-[#FFFBEB] px-4 py-3 text-sm text-[#92400E]">
              {unmappedRecords.length > 0
                ? `${formatNumber(unmappedRecords.length)} expenses are not mapped to HR ID. `
                : ""}
              {missingTripDateRecords.length > 0
                ? `${formatNumber(missingTripDateRecords.length)} expenses are missing trip date.`
                : ""}
            </div>
          )}
        </div>
      ) : (
        <div className="rounded-[28px] border border-dashed border-phx-line-strong bg-white/70 px-4 py-10 text-center text-sm text-phx-ink-soft shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]">
          No expenses sheet analyzed yet.
        </div>
      )}
      </div>
    </Card>
  );
}
