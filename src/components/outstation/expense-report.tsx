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
import type { ReactNode, RefObject } from "react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";

import { AdminCallout } from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  formatPharmacyFigure,
  pharmacyFigureText,
  pharmacyRecordingOf,
  pharmacyTileFigure,
  type VisitCountSplit,
} from "@/lib/crm/visit-count-buckets";
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
import { historicalUploadReports } from "@/lib/outstation/workflow-expense-report-guard";
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
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { rowDetailToggleProps, TableRowDetail } from "@/components/ui/table-row-detail";
import { humanizeCode } from "@/lib/format/code-label";


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
  // AM · PM · Pharmacies. Blank = not counted separately, never 0; the importer reads it back.
  "Pharmacy Workload",
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
  key: ExpenseReviewColumnKey;
  label: string;
}> = [
  { key: "validation", label: "Validation" },
  { key: "row", label: "Source Row" },
  { key: "tripId", label: "Trip ID" },
  { key: "specialist", label: "Employee" },
  { key: "requestType", label: "Expense Type" },
  { key: "tripType", label: "Travel Stay Type" },
  { key: "date", label: "Start Date" },
  { key: "toDate", label: "End Date" },
  { key: "from", label: "From" },
  { key: "to", label: "To" },
  { key: "location", label: "Destination" },
  { key: "transportationType", label: "Transported By" },
  { key: "km", label: "KM" },
  { key: "travelCost", label: "Travel Cost" },
  { key: "meetingAmount", label: "Meeting Amount" },
  { key: "allowance", label: "Allowance" },
  { key: "total", label: "Total" },
  { key: "amWorkload", label: "AM Workload" },
  { key: "pmWorkload", label: "PM Workload" },
  { key: "description", label: "Description" },
  { key: "status", label: "Status" },
  { key: "hr", label: "HR Status" },
  { key: "hrNotes", label: "HR Notes" },
];

function expenseColumnLabel(key: ExpenseReviewColumnKey) {
  return expenseReviewColumns.find((column) => column.key === key)?.label ?? key;
}

// The review table never scrolls sideways: related facts are MERGED into one cell, and the
// table is `w-full table-fixed` with a percentage <colgroup>. The Employee cell (left) and the
// HR-decision cell (right) are always there; these groups sit between them and are what the
// Columns menu shows and hides. The HR ID is deliberately in none of them — a person is told
// apart by name, never by id; a row with no HR id still says so in its Employee cell and in the
// Validation line. `weight` is the group's share before the table is normalised to 100%.
type ExpenseReviewGroupKey =
  | "amounts"
  | "dates"
  | "description"
  | "hrNotes"
  | "ref"
  | "route"
  | "status"
  | "transport"
  | "type"
  | "workload";

type ExpenseReviewGroup = {
  key: ExpenseReviewGroupKey;
  label: string;
  members: ExpenseReviewColumnKey[];
  weight: number;
};

const expenseReviewGroups: ExpenseReviewGroup[] = [
  { key: "ref", label: "Check, source row & trip", members: ["validation", "row", "tripId"], weight: 8 },
  { key: "type", label: "Expense & trip type", members: ["requestType", "tripType"], weight: 8 },
  { key: "dates", label: "Start & end date", members: ["date", "toDate"], weight: 8 },
  { key: "route", label: "From, to & destination", members: ["from", "to", "location"], weight: 14 },
  { key: "transport", label: "Transport & KM", members: ["transportationType", "km"], weight: 7 },
  { key: "amounts", label: "Amounts", members: ["travelCost", "meetingAmount", "allowance", "total"], weight: 11 },
  { key: "workload", label: "Declared workload", members: ["amWorkload", "pmWorkload"], weight: 8 },
  { key: "description", label: "Description", members: ["description"], weight: 12 },
  { key: "status", label: "Status & HR status", members: ["status", "hr"], weight: 9 },
  { key: "hrNotes", label: "HR notes", members: ["hrNotes"], weight: 12 },
];

const expenseEmployeeWeight = 12;
const expenseDecisionWeight = 22;

// Hidden by default: the long free-text columns and the transport detail. Every group stays one
// click away in the Columns menu, and showing them all still fits — the colgroup re-divides 100%.
const expenseDefaultHiddenGroups = new Set<ExpenseReviewGroupKey>(["description", "hrNotes", "transport"]);

/**
 * Whole-number percentages for the Employee column, the visible groups and the HR-decision column,
 * always adding up to exactly 100 (the last column takes the rounding remainder).
 */
function expenseColumnPercentages(groups: ExpenseReviewGroup[]) {
  const weights = [expenseEmployeeWeight, ...groups.map((group) => group.weight), expenseDecisionWeight];
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const percentages = weights.map((weight) => Math.floor((weight / total) * 100));
  percentages[percentages.length - 1] += 100 - percentages.reduce((sum, value) => sum + value, 0);
  return percentages;
}

const expenseColumnPrefsKey = "phoenix.outstation.expense-review.hidden-groups.v2";

// Verified workload evidence (actual iReports360 double-visit mirror) for a trip,
// used to check the sheet's declared AM/PM against reality, day by day.
type WorkloadEvidenceDay = {
  am: number;
  campaign: number;
  date: string;
  other: number;
  /** THE AM · PM · PHARMACIES GOLDEN RULE: never inside `am`/`pm`. Optional so a payload from a
   * server built before the split still renders. */
  pharmacies?: number;
  /** Of the day's visits, how many are Phoenix CRM's own — it logs no pharmacy visit. */
  phoenix?: number;
  pm: number;
  regular: number;
  total: number;
};

/**
 * Live evidence as the golden-rule split (src/lib/crm/visit-count-buckets.ts): a trip or day logged in
 * Phoenix CRM, which records no pharmacy visit, reads "not recorded in Phoenix" — never 0. The declared
 * sheet figure keeps its own wording ("not counted separately"); this is the live read only.
 */
function evidenceSplit(am: number, pm: number, pharmacies: number | undefined, phoenix: number | undefined): VisitCountSplit {
  return { am, pm, pharmacies: pharmacies ?? 0, ...(phoenix ? { phoenix } : {}) };
}

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
  pharmacyWorkload?: number;
  /** Of the trip's visits, how many are Phoenix CRM's own — display only, see evidenceSplit. */
  phoenixWorkload?: number;
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

  return String(record[key] ?? "") || "—";
}

type ExpenseFact = { label: string; strong?: boolean; value: ReactNode };

const expenseFactLabels: Partial<Record<ExpenseReviewColumnKey, string>> = {
  allowance: "Allowance",
  amWorkload: "AM",
  date: "Start",
  from: "From",
  hr: "HR",
  km: "KM",
  location: "Destination",
  meetingAmount: "Meeting",
  pmWorkload: "PM",
  requestType: "Expense",
  row: "Row",
  status: "Status",
  to: "To",
  total: "Total",
  toDate: "End",
  transportationType: "By",
  travelCost: "Travel",
  tripId: "Trip",
  tripType: "Trip type",
  validation: "Check",
};

/** The facts one merged cell says, in order. A text fact the record leaves empty is left out (not a filler). */
function expenseGroupFacts(record: ExpenseTripRecord, group: ExpenseReviewGroup, issues: string[]): ExpenseFact[] {
  const facts: ExpenseFact[] = [];
  for (const key of group.members) {
    const label = expenseFactLabels[key] ?? "";
    if (key === "validation") {
      facts.push({
        label,
        value: <Badge variant={issues.length > 0 ? "warning" : "success"}>{issues.length > 0 ? issues.join(", ") : "Ready"}</Badge>,
      });
      continue;
    }
    const isAmount = expenseCurrencyKeys.has(key) || expenseNumericKeys.has(key);
    if (!isAmount && !String(record[key] ?? "").trim()) continue;
    facts.push({ label, strong: key === "total", value: expenseColumnDisplayValue(record, key) });
    if (key === "pmWorkload" && record.pharmacyWorkload !== null && record.pharmacyWorkload !== undefined) {
      facts.push({ label: "Pharmacies", value: formatNumber(record.pharmacyWorkload) });
    }
  }
  return facts;
}

function ExpenseFactLines({ facts }: { facts: ExpenseFact[] }) {
  if (facts.length === 0) return <span className="text-text-secondary">—</span>;
  return (
    <div className="min-w-0 space-y-0.5 break-words text-text-secondary">
      {facts.map((fact, index) => (
        <p className={cn("min-w-0 break-words", fact.strong && "font-semibold text-text")} key={index}>
          {fact.label ? (
            <span className="mr-1 text-phx-3xs font-semibold uppercase tracking-wide text-text-secondary">{fact.label}</span>
          ) : null}
          {fact.value}
        </p>
      ))}
    </div>
  );
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
  locked,
  onUpdate,
  originalTotal,
  reasonMissing,
}: {
  amountChanged: boolean;
  approval: HrApprovalDraft;
  /** A refused upload: its rows are read-only, so no decision made on them can carry into a save. */
  locked: boolean;
  onUpdate: (patch: Partial<HrApprovalDraft>) => void;
  originalTotal: number;
  reasonMissing: boolean;
}) {
  return (
    // A disabled fieldset disables every control inside it natively — the switch, the amount and the
    // reason — without widening the shared Switch primitive.
    //
    // `gap-1.5`, not `gap-2`. That is WHITESPACE BETWEEN the two control rows — it is not one of the
    // controls, so shrinking it does not touch the rule stated below. Measured live on 2026-09-29 as
    // Super Admin against 489 real trips: with the cell padding at `py-2` it takes the review row
    // from 78px to 70px.
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0 disabled:opacity-60" disabled={locked}>
      {/*
        The Approve switch and the amount share ONE wrapping line. They were two stacked rows, and
        this cell is what set the review row's height: measured at 1440px on 2026-09-26 it needed
        104px — switch 24 + amount 32 + reason 32 + two 8px gaps — against 76px for the widest other
        cell, so every row was 100px tall because of this column alone.

        🔴 MEASURED AGAIN on 2026-09-29, live as Super Admin against 489 real trips at 1440px, and it
        is STILL this column that sets the height — which is worth knowing because the obvious place
        to look is the person column, and looking there is wasted effort. Hiding the person cell's
        (duplicated) HR id line moved the row 78px -> 78px, exactly nothing; hiding this cell's reason
        input moved it 78px -> 58px. So any future attempt to shorten this row has to come from here,
        and the rule below is what says how far that may go.

        🔴 NOTHING about the decision itself changes. Same Switch, same number input, same handlers,
        same values, same `was …` badge, same disabled fieldset, same required-reason rule and its
        rose border. This is where a person approves money, so the controls are moved, never
        reshaped: no size reduction, no merged fields, no shortened labels. `flex-wrap` keeps the
        amount on its own line when the column is narrow, so nothing is ever clipped or overlapped.
      */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Switch
          checked={approval.hrApproved}
          label={approval.hrApproved ? "Approved" : "Approve"}
          onChange={(checked) => onUpdate({ hrApproved: checked })}
        />
        <div className="flex items-center gap-2">
          <span className="w-12 shrink-0 text-phx-2xs font-bold uppercase tracking-[0.1em] text-text-secondary">
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
      </div>
      <Input
        className={cn("h-8 text-xs", reasonMissing && "border-rose-400")}
        onChange={(event) => onUpdate({ hrComment: event.target.value })}
        placeholder={amountChanged ? "Reason for adjusted amount (required)" : "Reason / comment"}
        value={approval.hrComment}
      />
      {reasonMissing ? (
        <p className="text-phx-2xs font-semibold text-rose-600">Add a reason for the changed amount.</p>
      ) : null}
    </fieldset>
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
  const [hiddenColumns, setHiddenColumns] = useState<Set<ExpenseReviewGroupKey>>(() => {
    // The review table only renders after a client-side data load, so reading the
    // saved preference here (rather than in an effect) is hydration-safe and keeps
    // the initial paint correct.
    if (typeof window !== "undefined") {
      try {
        const raw = window.localStorage.getItem(expenseColumnPrefsKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return new Set(parsed as ExpenseReviewGroupKey[]);
        }
      } catch {
        // Ignore unreadable/blocked localStorage — defaults still apply.
      }
    }
    return new Set(expenseDefaultHiddenGroups);
  });
  const [columnsMenuOpen, setColumnsMenuOpen] = useState(false);
  const [expandedTrips, setExpandedTrips] = useState<Set<string>>(() => new Set());
  const [evidenceByTrip, setEvidenceByTrip] = useState<Record<string, TripEvidenceState>>({});
  const replaceReportInputRef = useRef<HTMLInputElement | null>(null);
  // Real uploads only. An app trip's own payroll report is not an upload, and Replace or Delete on it
  // would take the trip out of payroll; the server refuses both (workflow-expense-report-guard.ts).
  const uploadReports = useMemo(() => historicalUploadReports(reports), [reports]);
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
    // Drafts are kept by trip id and outlive the screen they were made on, so a tick recorded on a
    // refused upload would reappear — and save — on the saved report holding the same trip.
    if (analysis?.validation?.status === "failed") return;
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

  function toggleColumnVisibility(key: ExpenseReviewGroupKey) {
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
    const actualPharmacies = data.pharmacyWorkload ?? 0;
    // A Phoenix CRM day logs no pharmacy visit: "Not recorded", never 0, and a day with both systems
    // names its figure "(iReports360 only)" — the summary line above says why (visit-count-buckets.ts).
    const pharmacyCellText = (day: WorkloadEvidenceDay) => {
      const split = evidenceSplit(day.am, day.pm, day.pharmacies, day.phoenix);
      return pharmacyRecordingOf(split) === "not-recorded"
        ? pharmacyTileFigure(split).value
        : pharmacyFigureText(split, { formatNumber });
    };
    // AM · PM · Pharmacies, all three field work (owner, 2026-09-21). A pre-split trip, or a sheet row
    // whose Pharmacy Workload cell is blank, has no third figure, its pharmacies inside AM/PM, so its
    // total still compares like for like.
    const declaredTotal = record.amWorkload + record.pmWorkload + (record.pharmacyWorkload ?? 0);
    const actualTotal = data.amWorkload + data.pmWorkload + actualPharmacies;
    const mismatch = declaredTotal !== actualTotal;
    const tone = workloadStatusTone[data.matchStatus] ?? "neutral";

    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-phx-xs font-bold uppercase tracking-[0.14em] text-text-secondary">Verified workload</span>
          <Badge variant={tone}>{humanizeCode(data.matchStatus)}</Badge>
          <span className="text-phx-xs text-text-secondary">{data.sourceLabel}</span>
        </div>
        <div className="grid gap-2 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-text-secondary">Declared (sheet)</p>
            <p className="mt-1 font-mono text-sm font-semibold text-text">
              AM {formatNumber(record.amWorkload)} · PM {formatNumber(record.pmWorkload)} · Pharmacies{" "}
              {record.pharmacyWorkload === null || record.pharmacyWorkload === undefined
                ? "not counted separately"
                : formatNumber(record.pharmacyWorkload)}
            </p>
          </div>
          <div className={cn("rounded-xl border p-3", mismatch ? "border-rose-300 bg-rose-50" : "border-emerald-200 bg-emerald-50")}>
            <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-text-secondary">Actual (evidence)</p>
            <p className="mt-1 font-mono text-sm font-semibold text-text">
              AM {formatNumber(data.amWorkload)} · PM {formatNumber(data.pmWorkload)} ·{" "}
              {formatPharmacyFigure(evidenceSplit(data.amWorkload, data.pmWorkload, actualPharmacies, data.phoenixWorkload), { formatNumber })}
            </p>
            {mismatch ? (
              <p className="mt-0.5 text-phx-2xs font-semibold text-rose-600">
                ≠ declared ({formatNumber(actualTotal)} actual vs {formatNumber(declaredTotal)} declared)
              </p>
            ) : null}
          </div>
          <div className="rounded-xl border border-slate-200 bg-white p-3">
            <p className="text-phx-2xs font-bold uppercase tracking-[0.12em] text-text-secondary">Visit type</p>
            <p className="mt-1 font-mono text-sm font-semibold text-text">
              Planned {formatNumber(data.regularVisits)} · Unplanned {formatNumber(data.campaignVisits)}
            </p>
            {/* Doctor/pharmacy/institution mix of the regular visits — display-only context so the
                approver can see WHAT kind of fieldwork justified the trip; no rule consumes it. */}
            <p className="mt-0.5 text-phx-2xs text-text-secondary">
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
                    { label: "Pharmacies", value: pharmacyCellText(day) },
                    { label: "Planned", value: formatNumber(day.regular) },
                    { label: "Unplanned", value: formatNumber(day.campaign) },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable
                className="text-xs"
                cols={
                  <colgroup>
                    <col className="w-[20%]" />
                    <col className="w-[11%]" />
                    <col className="w-[11%]" />
                    <col className="w-[15%]" />
                    <col className="w-[13%]" />
                    <col className="w-[14%]" />
                    <col className="w-[16%]" />
                  </colgroup>
                }
              >
            <thead className="bg-slate-50 text-phx-2xs uppercase tracking-[0.1em] text-text-secondary">
              <tr>
                <th className="px-3 py-2 font-semibold">Day</th>
                <th className="px-3 py-2 text-right font-semibold">AM</th>
                <th className="px-3 py-2 text-right font-semibold">PM</th>
                {/* Pharmacies takes the old Total column's place: Status already prints the day's
                    total ("N field visits"), so the table keeps its seven columns. */}
                <th className="px-3 py-2 text-right font-semibold">Pharmacies</th>
                <th className="px-3 py-2 text-right font-semibold">Planned</th>
                <th className="px-3 py-2 text-right font-semibold">Unplanned</th>
                <th className="px-3 py-2 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.dateBreakdown.map((day) => (
                <tr className={day.total === 0 ? "bg-rose-50/60" : undefined} key={day.date}>
                  <td className="break-words px-3 py-2 font-medium text-text">{formatPayrollDate(day.date)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text">{formatNumber(day.am)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text">{formatNumber(day.pm)}</td>
                  <td className="px-3 py-2 text-right font-mono text-text">{pharmacyCellText(day)}</td>
                  <td className="px-3 py-2 text-right font-mono text-sky-700">{formatNumber(day.regular)}</td>
                  <td className="px-3 py-2 text-right font-mono text-violet-700">{formatNumber(day.campaign)}</td>
                  <td className="break-words px-3 py-2">
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

  const visibleGroups = useMemo(
    () => expenseReviewGroups.filter((group) => !hiddenColumns.has(group.key)),
    [hiddenColumns],
  );
  const columnPercentages = useMemo(() => expenseColumnPercentages(visibleGroups), [visibleGroups]);

  // Persist the reviewer's column choices (the initial value is read in useState above).
  useEffect(() => {
    try {
      window.localStorage.setItem(expenseColumnPrefsKey, JSON.stringify([...hiddenColumns]));
    } catch {
      // Ignore quota/blocked storage.
    }
  }, [hiddenColumns]);

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

  // A refused upload is shown, never saved: Save would import its rows through the approvals route.
  const analysisRefused = validation.status === "failed";

  function saveApprovals() {
    if (!analysis || analysisRefused) return;

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

      // NO `header` here, on purpose: ExcelJS writes a column's `header` into ROW 1, on top of the
      // merged title — row 1 then reads the last header ("Comments") in every cell, and the importer's
      // header-row detector breaks the tie in favour of row 1, so the downloaded file re-imports as an
      // unrecognized template. Row 2 carries the headers explicitly (headerRow below); the title owns
      // row 1. Re-adding `header` re-breaks the round-trip. See detectHeaderRowNumber in expense-import.ts.
      sheet.columns = expenseTemplateHeaders.map((header, index) => ({
        key: header,
        width: [12, 30, 12, 18, 12, 12, 15, 16, 16, 16, 34, 14, 16, 14, 14, 13, 13, 14, 14, 24, 30][index],
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
          "Pharmacy Workload": record.pharmacyWorkload ?? "",
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
        row["Pharmacy Workload"],
        row.Status,
        row.Comments,
      ]);
      sheet.addRows(rowValues);
      [5, 6].forEach((columnNumber) => {
        sheet.getColumn(columnNumber).numFmt = "yyyy-mm-dd";
      });
      [12, 13, 14, 15, 16, 17, 18, 19].forEach((columnNumber) => {
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
            <p className="inline-flex rounded-full border border-phx-accent/35 bg-phx-accent/12 px-3 py-1 text-phx-xs font-black uppercase tracking-[0.22em] text-phx-accent">
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
            disabled={!analysis || savingApprovals || analysisRefused}
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

      {uploadReports.length > 0 && (
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
            <Badge variant="neutral">{formatNumber(uploadReports.length)} reports</Badge>
          </div>
          <div className="divide-y divide-slate-100">
            {uploadReports.slice(0, 12).map((report) => (
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
                <p className="text-phx-2xs font-bold uppercase tracking-[0.16em] opacity-70">{metric.label}</p>
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
              className="px-3"
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
              className="px-3"
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
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search specialist, HR ID, route, trip, status..."
              value={search}
            />
            <input
              className={phxFieldClassName}
              onChange={(event) => setTripDateFrom(event.target.value)}
              type="date"
              value={tripDateFrom}
            />
            <input
              className={phxFieldClassName}
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
                  Employee and HR Decision are always shown.
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="hidden text-xs text-text-secondary sm:inline">
                  {formatNumber(visibleGroups.length)} of {formatNumber(expenseReviewGroups.length)} detail columns
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
                          <span className="text-phx-xs font-bold uppercase tracking-[0.14em] text-text-secondary">
                            Detail columns
                          </span>
                          <div className="flex items-center gap-2">
                            <button
                              className="text-phx-xs font-semibold text-phx-accent-hover hover:underline"
                              onClick={() => setHiddenColumns(new Set())}
                              type="button"
                            >
                              Show all
                            </button>
                            <button
                              className="text-phx-xs font-semibold text-text-secondary hover:underline"
                              onClick={() => setHiddenColumns(new Set(expenseDefaultHiddenGroups))}
                              type="button"
                            >
                              Reset
                            </button>
                          </div>
                        </div>
                        {expenseReviewGroups.map((column) => (
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

            <div className="border border-phx-line bg-white">
              {/* Below `md` the review is a card list. The table is desktop-only (`w-full
                  table-fixed`, merged cells, never a sideways scroll). The cards carry the same <HrDecisionControls>, so nothing is
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
                        meta={record.hrId ? undefined : "Not mapped to an employee"}
                        status={
                          <Badge variant={issues.length > 0 ? "warning" : "success"}>
                            {issues.length > 0 ? issues.join(", ") : "Ready"}
                          </Badge>
                        }
                        title={record.specialist || "Unassigned"}
                      >
                        <PortalRecordFields
                          fields={[
                            ...expenseReviewColumns
                              .filter((column) => column.key !== "validation" && column.key !== "specialist")
                              .map((column) => ({
                                label: column.label,
                                value: expenseColumnDisplayValue(record, column.key),
                              })),
                            ...(record.pharmacyWorkload === null || record.pharmacyWorkload === undefined
                              ? []
                              : [{ label: "Pharmacy Workload", value: formatNumber(record.pharmacyWorkload) }]),
                          ]}
                        />
                        <div className="mt-3 border-t border-slate-100 pt-3">
                          <HrDecisionControls
                            amountChanged={amountChanged}
                            approval={approval}
                            locked={analysisRefused}
                            onUpdate={(patch) => updateApproval(record, patch)}
                            originalTotal={record.total}
                            reasonMissing={reasonMissing}
                          />
                        </div>
                        <button
                          className="mt-3 inline-flex items-center gap-1 border border-slate-200 px-1.5 py-0.5 text-phx-2xs font-semibold text-slate-600"
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

              <div className="hidden md:block">
                <table className="w-full table-fixed text-left text-sm">
                  <colgroup>
                    {columnPercentages.map((percent, index) => (
                      <col key={index} style={{ width: `${percent}%` }} />
                    ))}
                  </colgroup>
                  <thead>
                    <tr className="text-xs uppercase tracking-[0.12em] text-phx-ink-soft">
                      <th className="border-b border-phx-line bg-phx-paper px-3 py-3 align-top font-semibold">
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
                      {visibleGroups.map((group) => (
                        <th className="border-b border-phx-line bg-phx-paper px-3 py-3 align-top font-semibold" key={group.key}>
                          <div className="space-y-1">
                            {group.members.map((key) => (
                              <TableHeaderMenu
                                filterValue={columnFilters[key] ?? ""}
                                key={key}
                                label={expenseColumnLabel(key)}
                                onFilterChange={(value) =>
                                  setColumnFilters((filters) => ({
                                    ...filters,
                                    [key]: value,
                                  }))
                                }
                                onSortAsc={() => setSort(`${key}-asc`)}
                                onSortDesc={() => setSort(`${key}-desc`)}
                              />
                            ))}
                          </div>
                        </th>
                      ))}
                      <th className="border-b border-phx-line bg-phx-paper px-3 py-3 text-left align-top font-semibold">
                        HR Decision
                        <span className="mt-1 block text-phx-2xs font-medium normal-case tracking-normal text-text-secondary">
                          Approve · adjust amount · add reason
                        </span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {records.length === 0 ? (
                      <tr>
                        <td className="px-3 py-8 text-center text-sm text-text-secondary" colSpan={visibleGroups.length + 2}>
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
                          {/*
                            `py-2` on every cell of a review row, not `py-3`: the row's own vertical
                            padding is the one lever that does not touch the approval controls (see
                            the rule in HrDecisionControls). The header `<th>`s keep `py-3`; a column
                            heading is read once, a row is read 489 times.
                          */}
                          <td className="min-w-0 break-words border-b border-slate-100 px-3 py-2 align-top group-hover:bg-phx-accent-soft">
                            <p className="break-words font-semibold text-text">{record.specialist || "Unassigned"}</p>
                            {record.hrId ? null : (
                              <p className="mt-0.5 break-words text-phx-xs text-text-secondary">Not mapped to an employee</p>
                            )}
                            <button
                              className="mt-1.5 inline-flex items-center gap-1 border border-slate-200 px-1.5 py-0.5 text-left text-phx-2xs font-semibold text-slate-600 hover:bg-slate-50"
                              onClick={() => toggleTripExpand(record)}
                              type="button"
                              {...rowDetailToggleProps(`trip-evidence-${record.tripId}-${record.row}`, isExpanded)}
                            >
                              {isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />}
                              {isExpanded ? "Hide" : "Verify"} workload
                            </button>
                          </td>
                          {visibleGroups.map((group) => (
                            <td
                              className={cn(
                                "min-w-0 break-words border-b border-slate-100 px-3 py-2 align-top text-xs group-hover:bg-phx-accent-soft",
                                group.key === "amounts" && "font-mono",
                              )}
                              key={group.key}
                            >
                              <ExpenseFactLines facts={expenseGroupFacts(record, group, issues)} />
                            </td>
                          ))}
                          <td
                            className={cn(
                              "min-w-0 border-b border-slate-100 px-3 py-2 align-top group-hover:bg-phx-accent-soft",
                              reasonMissing && "bg-rose-50/80 group-hover:bg-rose-50",
                            )}
                          >
                            <HrDecisionControls
                              amountChanged={amountChanged}
                              approval={approval}
                              locked={analysisRefused}
                              onUpdate={(patch) => updateApproval(record, patch)}
                              originalTotal={record.total}
                              reasonMissing={reasonMissing}
                            />
                          </td>
                        </tr>
                        {isExpanded ? (
                          <TableRowDetail className="p-0" colSpan={visibleGroups.length + 2} id={`trip-evidence-${record.tripId}-${record.row}`}>
                            <div className="w-full p-4">
                              {renderTripEvidence(record)}
                            </div>
                          </TableRowDetail>
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
