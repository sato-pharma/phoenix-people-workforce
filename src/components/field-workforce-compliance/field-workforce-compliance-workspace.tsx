"use client";

import {
  AlertTriangle,
  Archive,
  BadgeCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Download,
  FileSpreadsheet,
  FolderOpen,
  ListFilter,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  UploadCloud,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  FieldWorkforceArchiveDetail,
  FieldWorkforceArchiveDuplicate,
  FieldWorkforceArchiveListItem,
  FieldWorkforceCellStatus,
  FieldWorkforceComparisonReport,
  FieldWorkforceComparisonRow,
  FieldWorkforceDecisionReason,
  FieldWorkforceDayCell,
  FieldWorkforceDecisionStatus,
  FieldWorkforceEmployeeSummary,
  FieldWorkforceFinalAction,
  FieldWorkforcePreviewResult,
  FieldWorkforceRecommendation,
  FieldWorkforceRecommendationsReport,
  FieldWorkforceReviewCandidate,
  FieldWorkforceSeverity,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";
import type { FieldWorkforceLiveSnapshotDetail, FieldWorkforceLiveSnapshotListItem, FieldWorkforceMirrorFreshness } from "@/lib/field-workforce-compliance/live-snapshots";
import { cn } from "@/lib/utils";
import { SearchableSelect } from "@/components/ui/searchable-select";


type PreviewResponse = {
  data?: FieldWorkforcePreviewResult;
  errors?: FieldWorkforceValidationIssue[];
  error?: string;
  message?: string;
  success: boolean;
  warnings?: FieldWorkforceValidationIssue[];
};

type LiveSnapshotListResponse = {
  data?: FieldWorkforceLiveSnapshotListItem[];
  error?: string;
  message?: string;
  success: boolean;
};

type LiveSnapshotDetailResponse = {
  data?: FieldWorkforceLiveSnapshotDetail;
  error?: string;
  message?: string;
  mirrorFreshness?: FieldWorkforceMirrorFreshness;
  success: boolean;
};

/** Which path produced the currently-shown `result`: an ad-hoc Excel upload preview (not
 * yet archived), an opened/saved Excel archive (handled entirely by ArchivedMonthsPanel's
 * own state), or a live view computed from the visits-report mirror for a chosen month. */
type SourceMode = "excel-preview" | "live-mirror";

type ArchiveListResponse = {
  data?: FieldWorkforceArchiveListItem[];
  error?: string;
  message?: string;
  success: boolean;
};

type ArchiveDetailResponse = {
  data?: FieldWorkforceArchiveDetail;
  error?: string;
  message?: string;
  success: boolean;
};

type ArchiveSaveResponse = {
  data?: FieldWorkforceArchiveDetail;
  duplicate?: FieldWorkforceArchiveDuplicate;
  error?: string;
  message?: string;
  success: boolean;
};

type RecommendationsResponse = {
  data?: FieldWorkforceRecommendationsReport;
  error?: string;
  message?: string;
  success: boolean;
};

type ComparisonResponse = {
  data?: FieldWorkforceComparisonReport;
  error?: string;
  message?: string;
  success: boolean;
};

type WorkspaceTab = "overview" | "timeline" | "team-calendar" | "queue" | "summary" | "diagnostics" | "archives" | "comparison" | "recommendations";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Employee Timeline" },
  { id: "team-calendar", label: "Team Calendar" },
  { id: "queue", label: "Review Queue" },
  { id: "summary", label: "Monthly Summary" },
  { id: "diagnostics", label: "Diagnostics" },
  { id: "archives", label: "Excel Archives" },
  { id: "comparison", label: "Comparison" },
];

const reviewWorkspaceTabs: Array<{ id: WorkspaceTab; label: string }> = workspaceTabs.filter((tab) => tab.id !== "archives" && tab.id !== "comparison");
const archiveWorkspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  ...reviewWorkspaceTabs,
  { id: "recommendations", label: "Recommendations" },
];
// Main (non-archive) tab bar: same as workspaceTabs but with Recommendations inserted
// before the Excel-specific tabs, so recommendations for a live-mirror month are reachable
// without archiving first. Built from reviewWorkspaceTabs (not workspaceTabs directly) to
// avoid double-counting "recommendations" in archiveWorkspaceTabs above.
const mainWorkspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  ...reviewWorkspaceTabs,
  { id: "recommendations", label: "Recommendations" },
  { id: "archives", label: "Excel Archives" },
  { id: "comparison", label: "Comparison" },
];

const severityOptions: Array<"All" | FieldWorkforceSeverity> = ["All", "High", "Review", "Medium", "Low"];
const statusOptions: Array<"All" | FieldWorkforceCellStatus> = ["All", "N", "AV", "CP", "VISITS", "F", "UNKNOWN"];
const pageSizeOptions = [25, 50, 100];
const decisionStatusOptions: FieldWorkforceDecisionStatus[] = [
  "Pending",
  "Approved for Leave Adjustment Report",
  "Approved for Payroll Deduction Report",
  "Do Not Take Action",
  "Needs Follow-up",
  "Disputed",
  "Resolved",
  "Cancelled",
];

const decisionReasonOptions: FieldWorkforceDecisionReason[] = [
  "System issue",
  "Manager approved field exception",
  "Official training",
  "Meeting / cycle meeting",
  "Medical excuse pending",
  "Doctor conference",
  "Area assignment issue",
  "Public holiday conflict",
  "Late CRM sync",
  "Duplicate / data issue",
  "Already covered",
  "No action needed",
  "Other",
];

function decisionStatusOptionsForRecommendation(
  recommendation: FieldWorkforceRecommendation,
): FieldWorkforceDecisionStatus[] {
  const common: FieldWorkforceDecisionStatus[] = [
    "Pending",
    "Do Not Take Action",
    "Needs Follow-up",
    "Disputed",
    "Resolved",
    "Cancelled",
  ];
  if (recommendation.recommendationType === "leave_reconciliation") {
    return [
      "Pending",
      "Approved for Leave Adjustment Report",
      ...common.slice(1),
    ];
  }
  return [
    "Pending",
    "Approved for Payroll Deduction Report",
    ...common.slice(1),
  ];
}

async function readJsonResponse<T extends { message?: string; success: boolean }>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return { message: response.statusText, success: response.ok } as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return { message: text, success: false } as T;
  }
}

function formatNumber(value: number) {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatRawValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "-";
  return String(value);
}

function displayDate(value: string | null) {
  if (!value) return "-";
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(date);
}

function displayDateTime(value: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Human "N ago" for a mirror-sync age in hours (e.g. 0.5 -> "just now", 3 -> "3h ago"). */
function formatSyncAge(ageHours: number) {
  if (ageHours < 1) return "under an hour ago";
  if (ageHours < 24) return `${Math.round(ageHours)}h ago`;
  const days = Math.round(ageHours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function weekday(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
  }).format(new Date(`${value}T00:00:00Z`));
}

function severityBadge(severity: FieldWorkforceSeverity | undefined) {
  if (!severity) return <Badge variant="neutral">Clear</Badge>;
  if (severity === "High") return <Badge variant="danger">{severity}</Badge>;
  if (severity === "Review" || severity === "Medium") return <Badge variant="warning">{severity}</Badge>;
  return <Badge variant="neutral">{severity}</Badge>;
}

function statusLabel(status: FieldWorkforceCellStatus, visitCount?: number) {
  if (status === "VISITS") return String(visitCount ?? 0);
  if (status === "BLANK") return "-";
  return status;
}

function statusMeaning(status: FieldWorkforceCellStatus) {
  const labels: Record<FieldWorkforceCellStatus, string> = {
    AV: "Vacation signal",
    BLANK: "Blank",
    CP: "Campaign",
    F: "Friday",
    N: "No activity",
    UNKNOWN: "Unknown",
    VISITS: "Visits",
  };
  return labels[status];
}

function coverageLabel(value: FieldWorkforceRecommendation["existingCoverageStatus"]) {
  const labels: Record<FieldWorkforceRecommendation["existingCoverageStatus"], string> = {
    already_covered: "Already covered",
    leave_source_not_connected: "Leave source not connected yet",
    needs_reconciliation: "Needs reconciliation",
    not_applicable: "Not applicable",
    payroll_calculation_required: "Amount requires payroll calculation",
  };
  return labels[value];
}

function decisionBadge(status: FieldWorkforceDecisionStatus) {
  if (status.includes("Approved")) return <Badge variant="success">{status}</Badge>;
  if (status === "Resolved") return <Badge variant="success">{status}</Badge>;
  if (status === "Do Not Take Action" || status === "Cancelled") return <Badge variant="neutral">{status}</Badge>;
  if (status === "Needs Follow-up" || status === "Disputed") return <Badge variant="warning">{status}</Badge>;
  return <Badge variant="neutral">{status}</Badge>;
}

function formatDates(dates: string[]) {
  if (dates.length === 0) return "-";
  if (dates.length <= 3) return dates.map((date) => displayDate(date)).join(", ");
  return `${dates.slice(0, 3).map((date) => displayDate(date)).join(", ")} +${dates.length - 3}`;
}

function candidateMatchesStatus(candidate: FieldWorkforceReviewCandidate, status: FieldWorkforceCellStatus) {
  const meaning = candidate.normalizedMeaning.toLowerCase();
  if (status === "N") return meaning.includes("no activity");
  if (status === "AV") return meaning.includes("vacation");
  if (status === "CP") return meaning.includes("campaign");
  if (status === "VISITS") return meaning.includes("numeric visits");
  if (status === "F") return meaning.includes("friday");
  if (status === "UNKNOWN") return meaning.includes("unknown");
  return meaning.includes("blank");
}

type HierarchyFilterState = {
  areaName: string;
  employmentStatus: string;
  lineName: string;
  managerName: string;
  roleName: string;
  teamName: string;
};

type HierarchyItem = {
  areaName?: string | null;
  employmentStatus?: string | null;
  lineName?: string | null;
  managerName?: string | null;
  roleName?: string | null;
  teamName?: string | null;
};

const emptyHierarchyFilters: HierarchyFilterState = {
  areaName: "All",
  employmentStatus: "All",
  lineName: "All",
  managerName: "All",
  roleName: "All",
  teamName: "All",
};

const hierarchyFilterConfig = [
  ["managerName", "Manager"],
  ["lineName", "Line"],
  ["areaName", "Area"],
  ["teamName", "Team"],
  ["roleName", "Role"],
  ["employmentStatus", "Status"],
] as const;

function uniqueHierarchyOptions<T extends HierarchyItem>(items: T[], key: keyof HierarchyFilterState) {
  return [...new Set(items.map((item) => item[key as keyof HierarchyItem]).filter((value): value is string => Boolean(value)))].sort((left, right) => left.localeCompare(right));
}

function hasHierarchyData<T extends HierarchyItem>(items: T[]) {
  return hierarchyFilterConfig.some(([key]) => uniqueHierarchyOptions(items, key).length > 0);
}

function matchesHierarchyFilters<T extends HierarchyItem>(item: T, filters: HierarchyFilterState) {
  return hierarchyFilterConfig.every(([key]) => {
    const selected = filters[key];
    return selected === "All" || item[key as keyof HierarchyItem] === selected;
  });
}

function HierarchyFilters<T extends HierarchyItem>({
  filters,
  items,
  onChange,
}: {
  filters: HierarchyFilterState;
  items: T[];
  onChange: (filters: HierarchyFilterState) => void;
}) {
  if (!hasHierarchyData(items)) {
    return (
      <AdminCallout tone="neutral">
        <ListFilter className="mt-0.5 h-4 w-4" />
        <p>Employee hierarchy filters unavailable for this archive.</p>
      </AdminCallout>
    );
  }

  return (
    <div className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 md:grid-cols-3 xl:grid-cols-6">
      {hierarchyFilterConfig.map(([key, label]) => {
        const options = uniqueHierarchyOptions(items, key);
        if (options.length === 0) return null;
        return (
          <SearchableSelect
            className="h-9 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            key={key}
            value={filters[key]}
            onChange={(event) => onChange({
              ...filters,
              [key]: event.target.value,
            })}
          >
            <option value="All">All {label}</option>
            {options.map((option) => <option key={option} value={option}>{option}</option>)}
          </SearchableSelect>
        );
      })}
    </div>
  );
}

function statusCellClass(cell: FieldWorkforceDayCell) {
  const base = {
    AV: "border-sky-300 bg-sky-50 text-sky-800 hover:bg-sky-100",
    BLANK: "border-slate-200 bg-white text-slate-400 hover:bg-slate-50",
    CP: "border-violet-300 bg-violet-50 text-violet-800 hover:bg-violet-100",
    F: "border-slate-200 bg-slate-100 text-slate-500 hover:bg-slate-200",
    N: "border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100",
    UNKNOWN: "border-red-400 bg-red-50 text-red-800 hover:bg-red-100",
    VISITS: "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100",
  }[cell.status];
  return cn(
    base,
    cell.isPublicHoliday ? "ring-2 ring-amber-300 ring-offset-1" : "",
    cell.isPreHire ? "opacity-45 grayscale" : "",
  );
}

function LegendChip({
  children,
  className,
  label,
}: {
  children: string;
  className: string;
  label: string;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
      <span className={cn("inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-[11px] font-black", className)}>
        {children}
      </span>
      {label}
    </div>
  );
}

function MetricCard({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: "danger" | "neutral" | "success" | "warning";
  value: string;
}) {
  const tones = {
    danger: "border-rose-200 bg-rose-50 text-rose-900",
    neutral: "border-slate-200 bg-white text-slate-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-orange-200 bg-orange-50 text-orange-900",
  };
  return (
    <Card className={cn("rounded-xl border p-4 shadow-[0_12px_28px_rgba(15,23,42,0.06)]", tones[tone])}>
      <p className="text-[10px] font-black uppercase tracking-[0.16em] opacity-70">{label}</p>
      <p className="mt-2 break-words text-xl font-black tracking-tight sm:text-2xl">{value}</p>
    </Card>
  );
}

function TimelineDayCell({ cell }: { cell: FieldWorkforceDayCell }) {
  const baseClass = cn(
    "relative flex h-10 w-full items-center justify-center rounded-lg border text-xs font-black",
    statusCellClass(cell),
  );
  const content = (
    <>
      {statusLabel(cell.status, cell.visitCount)}
      {cell.isPublicHoliday ? (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-amber-400" />
      ) : null}
    </>
  );
  // Numeric-visit days deep-link to the day drill-down in a NEW tab; other days are static.
  if (cell.status === "VISITS") {
    return (
      <Link
        aria-label={`${cell.employeeName} ${cell.dateIso}: ${cell.explanation} (open visits)`}
        className={cn(baseClass, "transition hover:ring-2 hover:ring-orange-300 focus:outline-none focus:ring-2 focus:ring-orange-300")}
        href={`/admin/field-workforce-compliance/visits/${encodeURIComponent(cell.hrId)}/${cell.dateIso}`}
        rel="noopener noreferrer"
        target="_blank"
        title={`${cell.explanation} — click to open the day's visits`}
      >
        {content}
      </Link>
    );
  }
  return (
    <div aria-label={`${cell.employeeName} ${cell.dateIso}: ${cell.explanation}`} className={baseClass} title={cell.explanation}>
      {content}
    </div>
  );
}

function TimelineLegend() {
  return (
    <div className="flex flex-wrap gap-2">
      <LegendChip className="border-rose-300 bg-rose-50 text-rose-800" label="No activity">N</LegendChip>
      <LegendChip className="border-sky-300 bg-sky-50 text-sky-800" label="Vacation">AV</LegendChip>
      <LegendChip className="border-violet-300 bg-violet-50 text-violet-800" label="Campaign">CP</LegendChip>
      <LegendChip className="border-emerald-300 bg-emerald-50 text-emerald-800" label="Visits">5</LegendChip>
      <LegendChip className="border-slate-200 bg-slate-100 text-slate-500" label="Friday">F</LegendChip>
      <LegendChip className="border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-300" label="Holiday">H</LegendChip>
    </div>
  );
}

function WorkspaceTabs({
  activeTab,
  onChange,
  tabs = workspaceTabs,
}: {
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
  tabs?: Array<{ id: WorkspaceTab; label: string }>;
}) {
  return (
    <div className="phoenix-horizontal-scroll overflow-x-auto rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-sm">
      <div className="flex min-w-max gap-1.5">
        {tabs.map((tab) => (
          <button
            aria-pressed={activeTab === tab.id}
            className={cn(
              "rounded-xl px-4 py-2 text-sm font-black transition",
              activeTab === tab.id
                ? "bg-slate-950 text-white shadow-[0_12px_24px_rgba(15,23,42,0.18)]"
                : "text-slate-600 hover:bg-orange-50 hover:text-orange-700",
            )}
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function ValidationIssues({
  title,
  issues,
  tone,
}: {
  issues: FieldWorkforceValidationIssue[];
  title: string;
  tone: "danger" | "warning";
}) {
  if (issues.length === 0) return null;
  return (
    <AdminCallout tone={tone}>
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <p className="font-semibold">{title}</p>
        <div className="mt-2 space-y-1 text-sm leading-6">
          {issues.slice(0, 4).map((issue, index) => (
            <p key={`${issue.code}:${issue.rowNumber ?? "file"}:${index}`}>
              {issue.rowNumber ? `Row ${issue.rowNumber}: ` : ""}{issue.message}
            </p>
          ))}
          {issues.length > 4 ? <p>{issues.length - 4} more issue(s) in Diagnostics.</p> : null}
        </div>
      </div>
    </AdminCallout>
  );
}

function OverviewPanel({
  highCount,
  holidayWarnings,
  result,
  totalCandidates,
}: {
  highCount: number;
  holidayWarnings: number;
  result: FieldWorkforcePreviewResult;
  totalCandidates: number;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard label="Employees" value={formatNumber(result.metadata.employeeCount)} />
        <MetricCard label="Review Candidates" tone={totalCandidates ? "warning" : "success"} value={formatNumber(totalCandidates)} />
        <MetricCard label="High Severity" tone={highCount ? "danger" : "success"} value={formatNumber(highCount)} />
        <MetricCard label="Holiday Warnings" tone={holidayWarnings ? "warning" : "neutral"} value={formatNumber(holidayWarnings)} />
        <MetricCard label="Matched HR IDs" tone={result.metadata.unmatchedEmployees ? "warning" : "success"} value={`${formatNumber(result.metadata.matchedEmployees)} / ${formatNumber(result.metadata.employeeCount)}`} />
        <MetricCard label="Parsed Month" value={`${result.metadata.monthLabel} ${result.metadata.year}`} />
        <MetricCard label="Safety Status" tone="success" value="Review only" />
        <MetricCard label="Public Holidays" tone={result.metadata.holidayConnected ? "success" : "warning"} value={`${formatNumber(result.metadata.holidaysDetected)} detected`} />
      </div>
      <AdminCallout tone="neutral">
        <ShieldAlert className="mt-0.5 h-4 w-4" />
        <p>This workspace is archive/review only. Saving an archived month stores the historical snapshot; it does not approve, deduct payroll, or mutate leave balances.</p>
      </AdminCallout>
    </div>
  );
}

function EmployeePicker({
  employees,
  employeeSearch,
  onEmployeeSearchChange,
  onSelectEmployee,
  selectedEmployee,
}: {
  employees: FieldWorkforceEmployeeSummary[];
  employeeSearch: string;
  onEmployeeSearchChange: (value: string) => void;
  onSelectEmployee: (hrId: string) => void;
  selectedEmployee: FieldWorkforceEmployeeSummary | null;
}) {
  const selectedIndex = selectedEmployee
    ? employees.findIndex((employee) => employee.hrId === selectedEmployee.hrId)
    : -1;
  const hasPrevious = selectedIndex > 0;
  const hasNext = selectedIndex >= 0 && selectedIndex < employees.length - 1;

  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px_220px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            placeholder="Search employee or HR ID"
            value={employeeSearch}
            onChange={(event) => onEmployeeSearchChange(event.target.value)}
          />
        </div>
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={selectedEmployee?.hrId ?? ""}
          onChange={(event) => onSelectEmployee(event.target.value)}
        >
          {employees.map((employee) => (
            <option key={employee.hrId} value={employee.hrId}>{employee.employeeName} / {employee.hrId}</option>
          ))}
        </SearchableSelect>
        <div className="grid grid-cols-2 gap-2">
          <Button
            className="gap-2"
            disabled={!hasPrevious}
            type="button"
            variant="secondary"
            onClick={() => {
              if (hasPrevious) onSelectEmployee(employees[selectedIndex - 1].hrId);
            }}
          >
            <ChevronLeft className="h-4 w-4" />
            Previous
          </Button>
          <Button
            className="gap-2"
            disabled={!hasNext}
            type="button"
            variant="secondary"
            onClick={() => {
              if (hasNext) onSelectEmployee(employees[selectedIndex + 1].hrId);
            }}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="mt-2 text-xs font-semibold text-slate-500">
        Showing {selectedIndex >= 0 ? selectedIndex + 1 : 0} of {formatNumber(employees.length)} matching employees.
      </p>
    </Card>
  );
}

function employeeRiskLabel(employee: FieldWorkforceEmployeeSummary) {
  if (employee.severityCounts.High > 0) return "High";
  if (employee.noActivityPattern.hasThreeDayStreak) return "High";
  if (employee.severityCounts.Review > 0 || employee.noActivityPattern.hasTwoDayStreak) return "Review";
  if (employee.severityCounts.Medium > 0) return "Medium";
  return "Low";
}

function EmployeeComplianceCard({ employee }: { employee: FieldWorkforceEmployeeSummary }) {
  const risk = employeeRiskLabel(employee);
  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Employee Monthly Compliance</p>
          <h3 className="mt-1 text-lg font-black text-slate-950">{employee.employeeName}</h3>
          <p className="mt-1 font-mono text-xs font-bold text-slate-500">{employee.hrId} / Hire date {employee.hiringDateIso ?? "-"}</p>
          <p className="mt-2 text-xs font-semibold text-slate-500">
            {[employee.managerName, employee.lineName, employee.areaName, employee.teamName, employee.roleName, employee.employmentStatus].filter(Boolean).join(" / ") || "Employee hierarchy unavailable"}
          </p>
        </div>
        {severityBadge(risk)}
      </div>
      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Eligible Days" value={formatNumber(employee.eligibleWorkingDays)} />
        <MetricCard label="Worked Days" tone="success" value={formatNumber(employee.workedDays)} />
        <MetricCard label="No Activity" tone={employee.noActivityCandidates ? "warning" : "success"} value={formatNumber(employee.noActivityCandidates)} />
        <MetricCard label="Vacation Days" tone={employee.vacationSignalDays ? "warning" : "neutral"} value={formatNumber(employee.vacationSignalDays)} />
        <MetricCard label="Campaign Days" value={formatNumber(employee.campaignDays)} />
        <MetricCard label="Total Visits" tone="success" value={formatNumber(employee.totalVisits)} />
        <MetricCard label="Compliance %" tone={employee.compliancePercent >= 75 ? "success" : employee.compliancePercent >= 50 ? "warning" : "danger"} value={`${formatNumber(employee.compliancePercent)}%`} />
        <MetricCard label="Longest N Streak" tone={employee.noActivityPattern.longestStreak >= 3 ? "danger" : employee.noActivityPattern.longestStreak >= 2 ? "warning" : "neutral"} value={formatNumber(employee.noActivityPattern.longestStreak)} />
        <MetricCard label="Holiday Warnings" tone={employee.holidayWarnings ? "warning" : "neutral"} value={formatNumber(employee.holidayWarnings)} />
        <MetricCard label="Pre-hire Context" tone={employee.preHireIgnoredValues ? "warning" : "neutral"} value={formatNumber(employee.preHireIgnoredValues)} />
      </div>
      <div className="mt-3 rounded-lg border border-orange-100 bg-orange-50 px-3 py-2 text-sm font-semibold text-orange-900">
        Consecutive no-activity signal: {employee.noActivityPattern.summary}
      </div>
    </Card>
  );
}

function SingleEmployeeTimeline({ employee }: { employee: FieldWorkforceEmployeeSummary }) {
  const monthColumns = { gridTemplateColumns: `repeat(${employee.timeline.length}, minmax(0, 1fr))` };
  return (
    <Card className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
      <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
        <p className="text-sm font-black text-slate-950">{employee.employeeName}</p>
        <p className="mt-1 font-mono text-xs font-bold text-slate-500">{employee.hrId} / Hire date {employee.hiringDateIso ?? "-"}</p>
      </div>
      {/* Full month fits the width — no horizontal scroll. */}
      <div className="p-3">
        <div className="grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <div
              className={cn(
                "rounded-md py-1 text-center text-[9px] font-black uppercase tracking-tight text-slate-500",
                cell.isFriday ? "bg-slate-100" : "",
                cell.isPublicHoliday ? "bg-amber-50 text-amber-700" : "",
              )}
              key={`${cell.dateIso}-header`}
            >
              <span className="block text-[11px] leading-tight text-slate-900">{cell.dayNumber}</span>
              <span>{weekday(cell.dateIso)}</span>
            </div>
          ))}
        </div>
        <div className="mt-1 grid gap-1" style={monthColumns}>
          {employee.timeline.map((cell) => (
            <TimelineDayCell cell={cell} key={cell.dateIso} />
          ))}
        </div>
      </div>
    </Card>
  );
}

function TimelinePanel({
  employees,
  employeeSearch,
  hierarchyFilters,
  hierarchyItems,
  onHierarchyFiltersChange,
  onEmployeeSearchChange,
  onSelectEmployee,
  selectedEmployee,
}: {
  employees: FieldWorkforceEmployeeSummary[];
  employeeSearch: string;
  hierarchyFilters: HierarchyFilterState;
  hierarchyItems: FieldWorkforceEmployeeSummary[];
  onEmployeeSearchChange: (value: string) => void;
  onHierarchyFiltersChange: (filters: HierarchyFilterState) => void;
  onSelectEmployee: (hrId: string) => void;
  selectedEmployee: FieldWorkforceEmployeeSummary | null;
}) {
  if (!selectedEmployee) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">
        No employee matches the current filter.
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <HierarchyFilters
        filters={hierarchyFilters}
        items={hierarchyItems}
        onChange={onHierarchyFiltersChange}
      />
      <EmployeePicker
        employeeSearch={employeeSearch}
        employees={employees}
        selectedEmployee={selectedEmployee}
        onEmployeeSearchChange={onEmployeeSearchChange}
        onSelectEmployee={onSelectEmployee}
      />
      <TimelineLegend />
      <EmployeeComplianceCard employee={selectedEmployee} />
      <SingleEmployeeTimeline employee={selectedEmployee} />
    </div>
  );
}

/** Whole line / whole team / all employees on one page — each rep's full month, green days deep-link.
 * Uses the same shared HierarchyFilters (all 6 dimensions) as Employee Timeline / Monthly Summary,
 * plus a name/HR-ID search — replaces the old bespoke Line+Team-only filter, whose Team dropdown
 * didn't cascade off the selected Line (picking a Team from a different Line silently produced
 * zero results, reading as "the filter is broken"). */
function TeamCalendarPanel({ employees }: { employees: FieldWorkforceEmployeeSummary[] }) {
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return employees.filter((employee) =>
      (!needle || `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle)) &&
      matchesHierarchyFilters(employee, hierarchyFilters),
    );
  }, [employees, hierarchyFilters, query]);

  return (
    <div className="space-y-4">
      <Card className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm font-black text-slate-950">Team Calendar</p>
        <p className="mt-1 text-xs font-semibold text-slate-500">A whole line, a whole team, or everyone — each rep&apos;s full month on one page. Click a green numeric day to open that day&apos;s visits.</p>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            placeholder="Search employee or HR ID"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <div className="mt-3">
          <HierarchyFilters
            filters={hierarchyFilters}
            items={employees}
            onChange={setHierarchyFilters}
          />
        </div>
      </Card>
      <TimelineLegend />
      <p className="text-xs font-bold text-slate-500">Showing {filtered.length} of {employees.length} reps</p>
      {filtered.length === 0 ? (
        <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500">No employee matches the current filters.</Card>
      ) : (
        <div className="space-y-3">
          {filtered.map((employee) => (
            <SingleEmployeeTimeline employee={employee} key={employee.hrId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ReviewQueue({
  candidates,
}: {
  candidates: FieldWorkforceReviewCandidate[];
}) {
  const [severity, setSeverity] = useState<"All" | FieldWorkforceSeverity>("All");
  const [status, setStatus] = useState<"All" | FieldWorkforceCellStatus>("All");
  const [employeeQuery, setEmployeeQuery] = useState("");
  const [holidayOnly, setHolidayOnly] = useState(false);
  const [preHireOnly, setPreHireOnly] = useState(false);
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const filtered = useMemo(() => candidates.filter((candidate) => {
    if (severity !== "All" && candidate.severity !== severity) return false;
    if (status !== "All" && !candidateMatchesStatus(candidate, status)) return false;
    if (holidayOnly && !candidate.context.some((item) => item.toLowerCase().includes("public holiday"))) return false;
    if (preHireOnly && candidate.type !== "pre_hire_activity") return false;
    if (employeeQuery.trim()) {
      const needle = employeeQuery.trim().toLowerCase();
      const haystack = `${candidate.employeeName} ${candidate.hrId}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }), [candidates, employeeQuery, holidayOnly, preHireOnly, severity, status]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function resetPage() {
    setPage(1);
  }

  return (
    <AdminTableShell
      description="Review candidates are labels only. They do not approve, deduct, save, or mutate payroll/leave."
      title="Review Candidate Queue"
    >
      <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[180px_180px_minmax(0,1fr)_180px]">
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value as typeof severity);
            resetPage();
          }}
        >
          {severityOptions.map((option) => <option key={option} value={option}>{option} severity</option>)}
        </SearchableSelect>
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as typeof status);
            resetPage();
          }}
        >
          {statusOptions.map((option) => <option key={option} value={option}>{option === "All" ? "All statuses" : statusMeaning(option)}</option>)}
        </SearchableSelect>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            placeholder="Filter employee or HR ID"
            value={employeeQuery}
            onChange={(event) => {
              setEmployeeQuery(event.target.value);
              resetPage();
            }}
          />
        </div>
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            resetPage();
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </SearchableSelect>
        <label className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 lg:col-span-2">
          <input
            checked={holidayOnly}
            className="h-4 w-4 accent-orange-600"
            type="checkbox"
            onChange={(event) => {
              setHolidayOnly(event.target.checked);
              resetPage();
            }}
          />
          Public holiday warnings only
        </label>
        <label className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 lg:col-span-2">
          <input
            checked={preHireOnly}
            className="h-4 w-4 accent-orange-600"
            type="checkbox"
            onChange={(event) => {
              setPreHireOnly(event.target.checked);
              resetPage();
            }}
          />
          Pre-hire anomalies only
        </label>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
        <span>Showing {visibleRows.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, filtered.length)} of {formatNumber(filtered.length)} candidates</span>
        <div className="flex items-center gap-2">
          <Button disabled={safePage <= 1} type="button" variant="secondary" onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
          <span>Page {safePage} / {totalPages}</span>
          <Button disabled={safePage >= totalPages} type="button" variant="secondary" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
        </div>
      </div>
      <div className="phoenix-horizontal-scroll max-h-[52vh] overflow-auto">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Raw</th>
              <th className="px-4 py-3">Meaning</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Explanation</th>
              <th className="px-4 py-3">Context</th>
              <th className="px-4 py-3">Session Note</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((candidate) => (
              <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={candidate.id}>
                <td className="px-4 py-3">
                  <p className="font-black text-slate-950">{candidate.employeeName}</p>
                  <p className="mt-1 font-mono text-xs font-semibold text-slate-500">{candidate.hrId}</p>
                </td>
                <td className="whitespace-nowrap px-4 py-3">{displayDate(candidate.dateIso)}</td>
                <td className="px-4 py-3 font-mono text-xs font-bold">{formatRawValue(candidate.rawValue)}</td>
                <td className="px-4 py-3">{candidate.normalizedMeaning}</td>
                <td className="px-4 py-3">{severityBadge(candidate.severity)}</td>
                <td className="max-w-[360px] px-4 py-3 leading-6">{candidate.explanation}</td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {candidate.context.length ? candidate.context.map((item) => (
                      <Badge key={item} variant={item.includes("Public holiday") ? "warning" : "neutral"}>{item}</Badge>
                    )) : <span className="text-slate-400">-</span>}
                  </div>
                </td>
                <td className="px-4 py-3">
                  <input
                    className="h-9 w-64 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                    placeholder="Temporary note, not saved"
                    value={notes[candidate.id] ?? ""}
                    onChange={(event) => setNotes((current) => ({
                      ...current,
                      [candidate.id]: event.target.value,
                    }))}
                  />
                </td>
              </tr>
            ))}
            {visibleRows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={8}>
                  No review candidates match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}

function MonthlySummaryTable({
  employees,
  hierarchyFilters,
  onHierarchyFiltersChange,
}: {
  employees: FieldWorkforceEmployeeSummary[];
  hierarchyFilters: HierarchyFilterState;
  onHierarchyFiltersChange: (filters: HierarchyFilterState) => void;
}) {
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return employees.filter((employee) =>
      (!needle || `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle)) &&
      matchesHierarchyFilters(employee, hierarchyFilters),
    );
  }, [employees, hierarchyFilters, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <AdminTableShell
      description="Compact employee-level totals. Public holidays are warning overlays, not automatic calculation changes."
      title="Monthly Employee Summary"
    >
      <div className="border-b border-slate-100 p-4">
        <HierarchyFilters
          filters={hierarchyFilters}
          items={employees}
          onChange={(filters) => {
            onHierarchyFiltersChange(filters);
            setPage(1);
          }}
        />
      </div>
      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[minmax(0,1fr)_180px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            placeholder="Search employee or HR ID"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </SearchableSelect>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
        <span>Showing {visibleRows.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, filtered.length)} of {formatNumber(filtered.length)} employees</span>
        <div className="flex items-center gap-2">
          <Button disabled={safePage <= 1} type="button" variant="secondary" onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
          <span>Page {safePage} / {totalPages}</span>
          <Button disabled={safePage >= totalPages} type="button" variant="secondary" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
        </div>
      </div>
      <div className="phoenix-horizontal-scroll max-h-[52vh] overflow-auto">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Hiring Date</th>
              <th className="px-4 py-3">Eligible</th>
              <th className="px-4 py-3">Worked</th>
              <th className="px-4 py-3">Compliance</th>
              <th className="px-4 py-3">N</th>
              <th className="px-4 py-3">AV</th>
              <th className="px-4 py-3">CP</th>
              <th className="px-4 py-3">Visits</th>
              <th className="px-4 py-3">Holidays</th>
              <th className="px-4 py-3">Pre-hire</th>
              <th className="px-4 py-3">Unknown</th>
              <th className="px-4 py-3">Hierarchy</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((employee) => (
              <tr className="text-slate-700 hover:bg-slate-50/70" key={employee.hrId}>
                <td className="px-4 py-3">
                  <p className="font-black text-slate-950">{employee.employeeName}</p>
                  <p className="mt-1 font-mono text-xs font-semibold text-slate-500">{employee.hrId}</p>
                </td>
                <td className="whitespace-nowrap px-4 py-3">{employee.hiringDateIso ?? "-"}</td>
                <td className="px-4 py-3">{formatNumber(employee.eligibleWorkingDays)}</td>
                <td className="px-4 py-3">{formatNumber(employee.workedDays)}</td>
                <td className="px-4 py-3 font-black text-slate-950">{formatNumber(employee.compliancePercent)}%</td>
                <td className="px-4 py-3 font-bold text-rose-700">{formatNumber(employee.noActivityCandidates)}</td>
                <td className="px-4 py-3 text-sky-700">{formatNumber(employee.vacationSignalDays)}</td>
                <td className="px-4 py-3 text-violet-700">{formatNumber(employee.campaignDays)}</td>
                <td className="px-4 py-3 text-emerald-700">{formatNumber(employee.totalVisits)}</td>
                <td className="px-4 py-3 text-orange-700">{formatNumber(employee.holidayWarnings)}</td>
                <td className="px-4 py-3 text-rose-700">{formatNumber(employee.preHireIgnoredValues)}</td>
                <td className="px-4 py-3 text-red-700">{formatNumber(employee.unknownValues)}</td>
                <td className="px-4 py-3">{[employee.managerName, employee.lineName, employee.areaName].filter(Boolean).join(" / ") || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}

function DiagnosticsPanel({
  errors,
  result,
  warnings,
}: {
  errors: FieldWorkforceValidationIssue[];
  result: FieldWorkforcePreviewResult;
  warnings: FieldWorkforceValidationIssue[];
}) {
  const preHireContext = result.employees.reduce((sum, employee) => sum + employee.preHireIgnoredValues, 0);
  const unknownValues = result.employees.reduce((sum, employee) => sum + employee.unknownValues, 0);

  return (
    <AdminTableShell
      description="Secondary parsing details. Collapsed by default to keep the review workspace compact."
      title="Import Diagnostics"
    >
      <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="File" value={result.metadata.fileName} />
        <MetricCard label="Sheet" value={result.metadata.sheetName} />
        <MetricCard label="Date Range" value={`${displayDate(result.metadata.dateRange.start)} - ${displayDate(result.metadata.dateRange.end)}`} />
        <MetricCard label="Warnings" tone={warnings.length ? "warning" : "success"} value={formatNumber(warnings.length)} />
        <MetricCard label="Pre-hire Context" tone={preHireContext ? "warning" : "neutral"} value={formatNumber(preHireContext)} />
        <MetricCard label="Unknown Values" tone={unknownValues ? "danger" : "success"} value={formatNumber(unknownValues)} />
        <MetricCard
          label="Public Holidays"
          tone={result.metadata.holidayConnected ? "success" : "warning"}
          value={`${formatNumber(result.metadata.holidaysDetected)} detected`}
        />
      </div>
      <div className="space-y-3 border-t border-slate-100 p-4">
        <details className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-black text-slate-900">Validation warnings and errors</summary>
          <div className="mt-3 max-h-72 space-y-2 overflow-auto text-sm leading-6 text-slate-600">
            {[...errors, ...warnings].length === 0 ? <p>No diagnostics reported.</p> : null}
            {[...errors, ...warnings].map((issue, index) => (
              <p key={`${issue.code}:${issue.rowNumber ?? "file"}:${index}`}>
                <span className="font-black text-slate-900">{issue.code}</span>
                {issue.rowNumber ? ` / Row ${issue.rowNumber}` : ""}: {issue.message}
              </p>
            ))}
          </div>
        </details>
        <details className="rounded-xl border border-slate-200 bg-white p-4">
          <summary className="cursor-pointer text-sm font-black text-slate-900">Archive safety boundaries</summary>
          <div className="mt-3 grid gap-2 text-sm leading-6 text-slate-600 sm:grid-cols-2">
            <p>Archive snapshot only.</p>
            <p>No duplicate month replacement.</p>
            <p>No approval workflow.</p>
            <p>No payroll action.</p>
            <p>No leave mutation.</p>
            <p>No notifications.</p>
          </div>
        </details>
      </div>
    </AdminTableShell>
  );
}

function ReviewWorkspacePanels({
  activeTab,
  errors,
  result,
  warnings,
}: {
  activeTab: WorkspaceTab;
  errors: FieldWorkforceValidationIssue[];
  result: FieldWorkforcePreviewResult;
  warnings: FieldWorkforceValidationIssue[];
}) {
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedHrId, setSelectedHrId] = useState<string>(result.employees[0]?.hrId ?? "");
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);

  const filteredEmployees = useMemo(() => {
    const needle = employeeSearch.trim().toLowerCase();
    return result.employees.filter((employee) =>
      (!needle || `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle)) &&
      matchesHierarchyFilters(employee, hierarchyFilters),
    );
  }, [employeeSearch, hierarchyFilters, result.employees]);

  const selectedEmployee =
    filteredEmployees.find((employee) => employee.hrId === selectedHrId) ??
    filteredEmployees[0] ??
    null;

  function selectEmployee(hrId: string) {
    setSelectedHrId(hrId);
  }

  const totalCandidates = result.reviewCandidates.length;
  const highCount = result.severityCounts.High;
  const holidayWarnings = result.employees.reduce((sum, employee) => sum + employee.holidayWarnings, 0);

  if (activeTab === "overview") {
    return (
      <OverviewPanel
        highCount={highCount}
        holidayWarnings={holidayWarnings}
        result={result}
        totalCandidates={totalCandidates}
      />
    );
  }

  if (activeTab === "timeline") {
    return (
      <TimelinePanel
        employeeSearch={employeeSearch}
        employees={filteredEmployees}
        hierarchyFilters={hierarchyFilters}
        hierarchyItems={result.employees}
        selectedEmployee={selectedEmployee}
        onEmployeeSearchChange={setEmployeeSearch}
        onHierarchyFiltersChange={(filters) => {
          setHierarchyFilters(filters);
          setSelectedHrId("");
        }}
        onSelectEmployee={selectEmployee}
      />
    );
  }

  if (activeTab === "team-calendar") {
    return <TeamCalendarPanel employees={result.employees} />;
  }

  if (activeTab === "queue") return <ReviewQueue candidates={result.reviewCandidates} />;
  if (activeTab === "summary") return <MonthlySummaryTable employees={result.employees} hierarchyFilters={hierarchyFilters} onHierarchyFiltersChange={setHierarchyFilters} />;
  if (activeTab === "diagnostics") return <DiagnosticsPanel errors={errors} result={result} warnings={warnings} />;

  return null;
}

function RecommendationRows({
  isSavingDecisionKey,
  onSaveDecision,
  recommendations,
}: {
  isSavingDecisionKey: string | null;
  onSaveDecision: (recommendation: FieldWorkforceRecommendation, status: FieldWorkforceDecisionStatus, note: string, reason: FieldWorkforceDecisionReason | "") => void;
  recommendations: FieldWorkforceRecommendation[];
}) {
  const [query, setQuery] = useState("");
  const [severity, setSeverity] = useState<"All" | FieldWorkforceSeverity>("All");
  const [decisionStatus, setDecisionStatus] = useState<"All" | FieldWorkforceDecisionStatus>("All");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);
  const [draftStatuses, setDraftStatuses] = useState<Record<string, FieldWorkforceDecisionStatus>>({});
  const [draftReasons, setDraftReasons] = useState<Record<string, FieldWorkforceDecisionReason | "">>({});
  const [draftNotes, setDraftNotes] = useState<Record<string, string>>({});
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return recommendations.filter((recommendation) => {
      if (severity !== "All" && recommendation.severity !== severity) return false;
      if (decisionStatus !== "All" && recommendation.decisionStatus !== decisionStatus) return false;
      if (!matchesHierarchyFilters(recommendation, hierarchyFilters)) return false;
      if (!needle) return true;
      return `${recommendation.employeeName} ${recommendation.employeeCode} ${recommendation.sourceLabel}`.toLowerCase().includes(needle);
    });
  }, [decisionStatus, hierarchyFilters, query, recommendations, severity]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  function resetPage() {
    setPage(1);
  }

  return (
    <div className="space-y-3">
      <div className="border-b border-slate-100 p-4">
        <HierarchyFilters
          filters={hierarchyFilters}
          items={recommendations}
          onChange={(filters) => {
            setHierarchyFilters(filters);
            resetPage();
          }}
        />
      </div>
      <div className="grid gap-3 border-b border-slate-100 p-4 lg:grid-cols-[minmax(0,1fr)_170px_230px_160px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            placeholder="Filter employee, code, or source"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              resetPage();
            }}
          />
        </div>
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value as typeof severity);
            resetPage();
          }}
        >
          {severityOptions.map((option) => <option key={option} value={option}>{option} severity</option>)}
        </SearchableSelect>
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={decisionStatus}
          onChange={(event) => {
            setDecisionStatus(event.target.value as typeof decisionStatus);
            resetPage();
          }}
        >
          <option value="All">All decisions</option>
          {decisionStatusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
        </SearchableSelect>
        <SearchableSelect
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            resetPage();
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </SearchableSelect>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
        <span>Showing {visibleRows.length ? (safePage - 1) * pageSize + 1 : 0}-{Math.min(safePage * pageSize, filtered.length)} of {formatNumber(filtered.length)} recommendations</span>
        <div className="flex items-center gap-2">
          <Button disabled={safePage <= 1} type="button" variant="secondary" onClick={() => setPage((current) => Math.max(1, current - 1))}>Previous</Button>
          <span>Page {safePage} / {totalPages}</span>
          <Button disabled={safePage >= totalPages} type="button" variant="secondary" onClick={() => setPage((current) => Math.min(totalPages, current + 1))}>Next</Button>
        </div>
      </div>
      <div className="phoenix-horizontal-scroll max-h-[56vh] overflow-auto">
        <table className="w-full min-w-[1480px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Dates</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Days</th>
              <th className="px-4 py-3">Coverage / Amount</th>
              <th className="px-4 py-3">Recommendation</th>
              <th className="px-4 py-3">Severity</th>
              <th className="px-4 py-3">Decision</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">HR Note</th>
              <th className="px-4 py-3">Save</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {visibleRows.map((recommendation) => {
              const status = draftStatuses[recommendation.recommendationKey] ?? recommendation.decisionStatus;
              const reason = draftReasons[recommendation.recommendationKey] ?? recommendation.decisionReason;
              const note = draftNotes[recommendation.recommendationKey] ?? recommendation.hrNote;
              const requiresReason = status !== "Pending";
              const rowDecisionStatusOptions = decisionStatusOptionsForRecommendation(recommendation);
              return (
                <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={recommendation.recommendationKey}>
                  <td className="px-4 py-3">
                    <p className="font-black text-slate-950">{recommendation.employeeName}</p>
                    <p className="mt-1 font-mono text-xs font-semibold text-slate-500">{recommendation.employeeCode}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-900">{formatDates(recommendation.dates)}</p>
                    <p className="mt-1 text-xs text-slate-500">{recommendation.monthKey}</p>
                  </td>
                  <td className="px-4 py-3">{recommendation.sourceLabel}</td>
                  <td className="px-4 py-3">{formatNumber(recommendation.daysCount)}</td>
                  <td className="px-4 py-3">
                    <p>{coverageLabel(recommendation.existingCoverageStatus)}</p>
                    <p className="mt-1 text-xs text-slate-500">Amount: {recommendation.estimatedAmount === null ? "Requires payroll calculation" : formatNumber(recommendation.estimatedAmount)}</p>
                  </td>
                  <td className="max-w-[360px] px-4 py-3 leading-6">{recommendation.recommendation}</td>
                  <td className="px-4 py-3">{severityBadge(recommendation.severity)}</td>
                  <td className="px-4 py-3">
                    <div className="space-y-2">
                      {decisionBadge(recommendation.decisionStatus)}
                      <SearchableSelect
                        className="h-9 w-64 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                        value={status}
                        onChange={(event) => setDraftStatuses((current) => ({
                          ...current,
                          [recommendation.recommendationKey]: event.target.value as FieldWorkforceDecisionStatus,
                        }))}
                      >
                        {rowDecisionStatusOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                      </SearchableSelect>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <SearchableSelect
                      className="h-9 w-64 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      value={reason}
                      onChange={(event) => setDraftReasons((current) => ({
                        ...current,
                        [recommendation.recommendationKey]: event.target.value as FieldWorkforceDecisionReason | "",
                      }))}
                    >
                      <option value="">{requiresReason ? "Choose reason" : "No reason needed"}</option>
                      {decisionReasonOptions.map((option) => <option key={option} value={option}>{option}</option>)}
                    </SearchableSelect>
                    {requiresReason && !reason ? <p className="mt-1 text-xs font-semibold text-rose-600">Required for this decision.</p> : null}
                    {reason === "Other" && !note.trim() ? <p className="mt-1 text-xs font-semibold text-rose-600">Other requires HR note.</p> : null}
                  </td>
                  <td className="px-4 py-3">
                    <input
                      className="h-9 w-64 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      placeholder="HR decision note"
                      value={note}
                      onChange={(event) => setDraftNotes((current) => ({
                        ...current,
                        [recommendation.recommendationKey]: event.target.value,
                      }))}
                    />
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      className="gap-2"
                      disabled={isSavingDecisionKey === recommendation.recommendationKey || (requiresReason && !reason) || (reason === "Other" && !note.trim())}
                      type="button"
                      variant="secondary"
                      onClick={() => onSaveDecision(recommendation, status, note, reason)}
                    >
                      {isSavingDecisionKey === recommendation.recommendationKey ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Save Decision
                    </Button>
                  </td>
                </tr>
              );
            })}
            {visibleRows.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={11}>
                  No recommendations match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FinalActionsTable({
  actions,
  archiveId,
}: {
  actions: FieldWorkforceFinalAction[];
  archiveId: string;
}) {
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);
  const filteredActions = useMemo(() =>
    actions.filter((action) => matchesHierarchyFilters(action, hierarchyFilters)),
  [actions, hierarchyFilters]);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <HierarchyFilters filters={hierarchyFilters} items={actions} onChange={setHierarchyFilters} />
        <Button
          className="gap-2"
          disabled={actions.length === 0}
          type="button"
          variant="secondary"
          onClick={() => {
            window.location.href = `/api/admin/field-workforce-compliance/archive/${archiveId}/recommendations/export`;
          }}
        >
          <Download className="h-4 w-4" />
          Export Report Only
        </Button>
      </div>
      <AdminCallout tone="neutral">
        <ShieldAlert className="mt-0.5 h-4 w-4" />
        <p>Final approved actions are report-only. Exporting does not execute payroll, mutate leave balances, or push integrations.</p>
      </AdminCallout>
      <div className="phoenix-horizontal-scroll max-h-[52vh] overflow-auto">
        <table className="w-full min-w-[1280px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Action Type</th>
              <th className="px-4 py-3">Approved Dates</th>
              <th className="px-4 py-3">Days</th>
              <th className="px-4 py-3">Amount</th>
              <th className="px-4 py-3">Reason</th>
              <th className="px-4 py-3">Approved By</th>
              <th className="px-4 py-3">Approved At</th>
              <th className="px-4 py-3">HR Note</th>
              <th className="px-4 py-3">Push Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredActions.map((action) => (
              <tr className="align-top text-slate-700 hover:bg-slate-50/70" key={action.recommendationKey}>
                <td className="px-4 py-3">
                  <p className="font-black text-slate-950">{action.employeeName}</p>
                  <p className="mt-1 font-mono text-xs font-semibold text-slate-500">{action.employeeCode}</p>
                </td>
                <td className="px-4 py-3">{action.actionType}</td>
                <td className="px-4 py-3">{formatDates(action.approvedDates)}</td>
                <td className="px-4 py-3">{formatNumber(action.approvedDaysCount)}</td>
                <td className="px-4 py-3">{action.amount === null ? "Amount requires payroll calculation" : formatNumber(action.amount)}</td>
                <td className="px-4 py-3">{action.decisionReason || "-"}</td>
                <td className="px-4 py-3">{action.approvedBy ?? "-"}</td>
                <td className="px-4 py-3">{displayDateTime(action.approvedAt)}</td>
                <td className="max-w-[300px] px-4 py-3 leading-6">{action.hrNote || "-"}</td>
                <td className="px-4 py-3"><Badge variant="neutral">{action.pushStatus}</Badge></td>
              </tr>
            ))}
            {filteredActions.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={10}>
                  No approved report actions match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function RecommendationsPanel({
  isLoading,
  isSavingDecisionKey,
  onRefresh,
  onSaveDecision,
  report,
}: {
  isLoading: boolean;
  isSavingDecisionKey: string | null;
  onRefresh: (auditFinalReportView?: boolean) => void;
  onSaveDecision: (recommendation: FieldWorkforceRecommendation, status: FieldWorkforceDecisionStatus, note: string, reason: FieldWorkforceDecisionReason | "") => void;
  report: FieldWorkforceRecommendationsReport | null;
}) {
  const [recommendationTab, setRecommendationTab] = useState<"final" | "leave" | "payroll">("leave");

  if (!report) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>Load recommendations for this archived month.</p>
          <Button className="gap-2" disabled={isLoading} type="button" variant="secondary" onClick={() => onRefresh(false)}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Load Recommendations
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <AdminTableShell
      description="Decision-support reports only. These decisions do not push to payroll or mutate leave balances."
      title="Recommendations"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
        <div className="flex flex-wrap gap-2">
          {([
            ["leave", "Leave Recommendations"],
            ["payroll", "Payroll Recommendations"],
            ["final", "Final Actions"],
          ] as const).map(([id, label]) => (
            <button
              aria-pressed={recommendationTab === id}
              className={cn(
                "rounded-xl px-3 py-2 text-xs font-black transition",
                recommendationTab === id ? "bg-slate-950 text-white" : "bg-white text-slate-600 hover:bg-orange-50 hover:text-orange-700",
              )}
              key={id}
              type="button"
              onClick={() => {
                setRecommendationTab(id);
                if (id === "final") onRefresh(true);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <Button className="gap-2" disabled={isLoading} type="button" variant="secondary" onClick={() => onRefresh(recommendationTab === "final")}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>
      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-2">
        <AdminCallout tone="warning">
          <CalendarDays className="mt-0.5 h-4 w-4" />
          <p>{report.integrationStatus.leaveSourceMessage}</p>
        </AdminCallout>
        <AdminCallout tone="warning">
          <ShieldAlert className="mt-0.5 h-4 w-4" />
          <p>{report.integrationStatus.payrollAmountMessage}</p>
        </AdminCallout>
      </div>
      {recommendationTab === "leave" ? (
        <RecommendationRows
          isSavingDecisionKey={isSavingDecisionKey}
          recommendations={report.leaveRecommendations}
          onSaveDecision={onSaveDecision}
        />
      ) : null}
      {recommendationTab === "payroll" ? (
        <RecommendationRows
          isSavingDecisionKey={isSavingDecisionKey}
          recommendations={report.payrollRecommendations}
          onSaveDecision={onSaveDecision}
        />
      ) : null}
      {recommendationTab === "final" ? <FinalActionsTable actions={report.finalActions} archiveId={report.archive.id} /> : null}
    </AdminTableShell>
  );
}

function ComparisonPanel({
  isLoading,
  onRefresh,
  report,
}: {
  isLoading: boolean;
  onRefresh: () => void;
  report: FieldWorkforceComparisonReport | null;
}) {
  const [hierarchyFilters, setHierarchyFilters] = useState<HierarchyFilterState>(emptyHierarchyFilters);
  const [query, setQuery] = useState("");
  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (report?.rows ?? []).filter((row) =>
      matchesHierarchyFilters(row, hierarchyFilters) &&
      (!needle || `${row.employeeName} ${row.employeeCode} ${row.monthKey}`.toLowerCase().includes(needle)),
    );
  }, [hierarchyFilters, query, report?.rows]);

  if (!report) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p>Load archived month comparison trends.</p>
          <Button className="gap-2" disabled={isLoading} type="button" variant="secondary" onClick={onRefresh}>
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Load Comparison
          </Button>
        </div>
      </Card>
    );
  }

  if (report.archiveCount < 2) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
        Archive at least two months to compare trends.
      </Card>
    );
  }

  return (
    <AdminTableShell
      description="Simple archived month comparison. Table-first trend view only; no BI dashboard and no execution."
      title="Archived Month Comparison"
    >
      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
            placeholder="Filter employee, code, or month"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button className="gap-2" disabled={isLoading} type="button" variant="secondary" onClick={onRefresh}>
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          Refresh
        </Button>
      </div>
      <div className="border-b border-slate-100 p-4">
        <HierarchyFilters filters={hierarchyFilters} items={report.rows} onChange={setHierarchyFilters} />
      </div>
      <div className="grid gap-3 border-b border-slate-100 p-4 sm:grid-cols-3">
        <MetricCard label="Archived Months" value={formatNumber(report.archiveCount)} />
        <MetricCard label="Comparison Rows" value={formatNumber(rows.length)} />
        <MetricCard label="Hierarchy Filters" tone={report.hierarchyAvailable ? "success" : "neutral"} value={report.hierarchyAvailable ? "Available" : "Unavailable"} />
      </div>
      <div className="phoenix-horizontal-scroll max-h-[56vh] overflow-auto">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
            <tr>
              <th className="px-4 py-3">Employee</th>
              <th className="px-4 py-3">Month</th>
              <th className="px-4 py-3">Compliance %</th>
              <th className="px-4 py-3">Worked</th>
              <th className="px-4 py-3">N Days</th>
              <th className="px-4 py-3">AV</th>
              <th className="px-4 py-3">CP</th>
              <th className="px-4 py-3">Visits</th>
              <th className="px-4 py-3">Line / Area</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row: FieldWorkforceComparisonRow) => (
              <tr className="text-slate-700 hover:bg-slate-50/70" key={`${row.importId}:${row.employeeCode}`}>
                <td className="px-4 py-3">
                  <p className="font-black text-slate-950">{row.employeeName}</p>
                  <p className="mt-1 font-mono text-xs font-semibold text-slate-500">{row.employeeCode}</p>
                </td>
                <td className="px-4 py-3">{row.monthKey}</td>
                <td className="px-4 py-3 font-black text-slate-950">{formatNumber(row.compliancePercent)}%</td>
                <td className="px-4 py-3 text-emerald-700">{formatNumber(row.workedDays)}</td>
                <td className="px-4 py-3 text-rose-700">{formatNumber(row.noActivityDays)}</td>
                <td className="px-4 py-3 text-sky-700">{formatNumber(row.vacationDays)}</td>
                <td className="px-4 py-3 text-violet-700">{formatNumber(row.campaignDays)}</td>
                <td className="px-4 py-3 text-emerald-700">{formatNumber(row.totalVisits)}</td>
                <td className="px-4 py-3">{[row.lineName, row.areaName].filter(Boolean).join(" / ") || "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </AdminTableShell>
  );
}

function ArchivedMonthsPanel({
  archiveActiveTab,
  archiveDetail,
  archives,
  isLoadingArchives,
  isLoadingRecommendations,
  isOpeningArchiveId,
  isSavingDecisionKey,
  onArchiveTabChange,
  onOpenArchive,
  onRefresh,
  onRefreshRecommendations,
  onSaveDecision,
  recommendationsReport,
}: {
  archiveActiveTab: WorkspaceTab;
  archiveDetail: FieldWorkforceArchiveDetail | null;
  archives: FieldWorkforceArchiveListItem[];
  isLoadingArchives: boolean;
  isLoadingRecommendations: boolean;
  isOpeningArchiveId: string | null;
  isSavingDecisionKey: string | null;
  onArchiveTabChange: (tab: WorkspaceTab) => void;
  onOpenArchive: (archive: FieldWorkforceArchiveListItem) => void;
  onRefresh: () => void;
  onRefreshRecommendations: (auditFinalReportView?: boolean) => void;
  onSaveDecision: (recommendation: FieldWorkforceRecommendation, status: FieldWorkforceDecisionStatus, note: string, reason: FieldWorkforceDecisionReason | "") => void;
  recommendationsReport: FieldWorkforceRecommendationsReport | null;
}) {
  return (
    <div className="space-y-4">
      <AdminCallout tone="neutral">
        <Archive className="mt-0.5 h-4 w-4" />
        <p>Archived months are historical review snapshots only. They do not approve recommendations, update leave balances, or create payroll deductions.</p>
      </AdminCallout>

      <AdminTableShell
        description="Saved monthly archives. Phase 2 blocks duplicate active archives for the same month."
        title="Archived Months"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-4">
          <div>
            <p className="text-sm font-black text-slate-950">{formatNumber(archives.length)} archived month(s)</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">Open a saved month to review its timeline, queue, summary, and diagnostics.</p>
          </div>
          <Button
            className="gap-2"
            disabled={isLoadingArchives}
            type="button"
            variant="secondary"
            onClick={onRefresh}
          >
            {isLoadingArchives ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
        <div className="phoenix-horizontal-scroll max-h-80 overflow-auto">
          <table className="w-full min-w-[980px] text-left text-sm">
            <thead className="sticky top-0 z-10 bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
              <tr>
                <th className="px-4 py-3">Month</th>
                <th className="px-4 py-3">Source</th>
                <th className="px-4 py-3">Employees</th>
                <th className="px-4 py-3">Review Candidates</th>
                <th className="px-4 py-3">High</th>
                <th className="px-4 py-3">Uploaded</th>
                <th className="px-4 py-3">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {archives.map((archive) => (
                <tr className="text-slate-700 hover:bg-slate-50/70" key={archive.id}>
                  <td className="whitespace-nowrap px-4 py-3">
                    <p className="font-black text-slate-950">{archive.monthKey}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{archive.status}</p>
                  </td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-900">{archive.sourceFilename}</p>
                    <p className="mt-1 text-xs font-semibold text-slate-500">{archive.sheetName}</p>
                  </td>
                  <td className="px-4 py-3">{formatNumber(archive.employeeCount)}</td>
                  <td className="px-4 py-3 text-orange-700">{formatNumber(archive.reviewCandidateCount)}</td>
                  <td className="px-4 py-3 text-rose-700">{formatNumber(archive.highSeverityCount)}</td>
                  <td className="px-4 py-3">
                    <p className="font-semibold text-slate-900">{displayDateTime(archive.uploadedAt)}</p>
                    <p className="mt-1 font-mono text-xs font-semibold text-slate-500">{archive.uploadedBy}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Button
                      className="gap-2"
                      disabled={isOpeningArchiveId === archive.id}
                      type="button"
                      variant="secondary"
                      onClick={() => onOpenArchive(archive)}
                    >
                      {isOpeningArchiveId === archive.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
                      Open
                    </Button>
                  </td>
                </tr>
              ))}
              {archives.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={7}>
                    No archived Workforce Compliance months yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>

      {archiveDetail ? (
        <div className="space-y-4">
          <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Archived Month</p>
                <h2 className="mt-1 text-xl font-black text-slate-950">{archiveDetail.archive.monthKey}</h2>
                <p className="mt-1 text-sm font-semibold text-slate-500">{archiveDetail.archive.sourceFilename}</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="success">Archived snapshot</Badge>
                <Badge variant="neutral">No payroll action</Badge>
                <Badge variant="neutral">No leave mutation</Badge>
              </div>
            </div>
          </Card>
          <WorkspaceTabs activeTab={archiveActiveTab} tabs={archiveWorkspaceTabs} onChange={onArchiveTabChange} />
          {archiveActiveTab === "recommendations" ? (
            <RecommendationsPanel
              isLoading={isLoadingRecommendations}
              isSavingDecisionKey={isSavingDecisionKey}
              report={recommendationsReport}
              onRefresh={onRefreshRecommendations}
              onSaveDecision={onSaveDecision}
            />
          ) : (
            <ReviewWorkspacePanels
              activeTab={archiveActiveTab}
              errors={archiveDetail.preview.errors}
              key={archiveDetail.archive.id}
              result={archiveDetail.preview}
              warnings={archiveDetail.preview.warnings}
            />
          )}
        </div>
      ) : (
        <Card className="rounded-xl border border-slate-200 bg-white p-6 text-sm text-slate-500 shadow-sm">
          Select an archived month to open the saved review workspace.
        </Card>
      )}
    </div>
  );
}

export function FieldWorkforceComplianceWorkspace() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isSavingArchive, setIsSavingArchive] = useState(false);
  const [isLoadingArchives, setIsLoadingArchives] = useState(false);
  const [isLoadingComparison, setIsLoadingComparison] = useState(false);
  const [isLoadingRecommendations, setIsLoadingRecommendations] = useState(false);
  const [isOpeningArchiveId, setIsOpeningArchiveId] = useState<string | null>(null);
  const [isSavingDecisionKey, setIsSavingDecisionKey] = useState<string | null>(null);
  const [result, setResult] = useState<FieldWorkforcePreviewResult | null>(null);
  const [archives, setArchives] = useState<FieldWorkforceArchiveListItem[]>([]);
  const [archiveDetail, setArchiveDetail] = useState<FieldWorkforceArchiveDetail | null>(null);
  const [recommendationsReport, setRecommendationsReport] = useState<FieldWorkforceRecommendationsReport | null>(null);
  const [comparisonReport, setComparisonReport] = useState<FieldWorkforceComparisonReport | null>(null);
  const [errors, setErrors] = useState<FieldWorkforceValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<FieldWorkforceValidationIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [archiveMessage, setArchiveMessage] = useState<string | null>(null);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [recommendationsMessage, setRecommendationsMessage] = useState<string | null>(null);
  const [recommendationsError, setRecommendationsError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [archiveActiveTab, setArchiveActiveTab] = useState<WorkspaceTab>("timeline");
  const [sourceMode, setSourceMode] = useState<SourceMode | null>(null);
  const [liveMirrorMonthKey, setLiveMirrorMonthKey] = useState<string | null>(null);
  const [mirrorLastSyncedAt, setMirrorLastSyncedAt] = useState<string | null>(null);
  const [mirrorFreshness, setMirrorFreshness] = useState<FieldWorkforceMirrorFreshness | null>(null);
  const [liveSnapshots, setLiveSnapshots] = useState<FieldWorkforceLiveSnapshotListItem[]>([]);
  const [isLoadingLiveSnapshots, setIsLoadingLiveSnapshots] = useState(false);
  const [liveSnapshotsError, setLiveSnapshotsError] = useState<string | null>(null);
  const [selectedMonthKey, setSelectedMonthKey] = useState("");
  const [isLoadingSnapshotDetail, setIsLoadingSnapshotDetail] = useState(false);

  const loadArchives = useCallback(async () => {
    setIsLoadingArchives(true);
    setArchiveError(null);
    try {
      const response = await fetch("/api/admin/field-workforce-compliance/archive", {
        method: "GET",
      });
      const payload = await readJsonResponse<ArchiveListResponse>(response);
      if (payload.success && payload.data) {
        setArchives(payload.data);
      } else {
        setArchiveError(payload.message ?? payload.error ?? "Archived months could not be loaded.");
      }
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Archived months could not be loaded.");
    } finally {
      setIsLoadingArchives(false);
    }
  }, []);

  const loadComparison = useCallback(async () => {
    setIsLoadingComparison(true);
    setArchiveError(null);
    try {
      const response = await fetch("/api/admin/field-workforce-compliance/archive/comparison", {
        method: "GET",
      });
      const payload = await readJsonResponse<ComparisonResponse>(response);
      if (payload.success && payload.data) {
        setComparisonReport(payload.data);
      } else {
        setArchiveError(payload.message ?? payload.error ?? "Comparison could not be loaded.");
      }
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Comparison could not be loaded.");
    } finally {
      setIsLoadingComparison(false);
    }
  }, []);

  function handleWorkspaceTabChange(tab: WorkspaceTab) {
    setActiveTab(tab);
    if (tab === "archives" && archives.length === 0 && !isLoadingArchives) {
      void loadArchives();
    }
    if (tab === "comparison" && !comparisonReport && !isLoadingComparison) {
      void loadComparison();
    }
    if (
      tab === "recommendations" &&
      sourceMode === "live-mirror" &&
      liveMirrorMonthKey &&
      !recommendationsReport &&
      !isLoadingRecommendations
    ) {
      void loadLiveMirrorRecommendations(liveMirrorMonthKey);
    }
  }

  async function loadRecommendations(archiveId: string, auditFinalReportView = false) {
    setIsLoadingRecommendations(true);
    setRecommendationsError(null);
    try {
      const response = await fetch(`/api/admin/field-workforce-compliance/archive/${archiveId}/recommendations${auditFinalReportView ? "?report=final" : ""}`, {
        method: "GET",
      });
      const payload = await readJsonResponse<RecommendationsResponse>(response);
      if (payload.success && payload.data) {
        setRecommendationsReport(payload.data);
      } else {
        setRecommendationsError(payload.message ?? payload.error ?? "Recommendations could not be loaded.");
      }
    } catch (error) {
      setRecommendationsError(error instanceof Error ? error.message : "Recommendations could not be loaded.");
    } finally {
      setIsLoadingRecommendations(false);
    }
  }

  async function loadLiveMirrorRecommendations(monthKey: string) {
    setIsLoadingRecommendations(true);
    setRecommendationsError(null);
    try {
      const response = await fetch(
        `/api/admin/field-workforce-compliance/live-snapshots/${monthKey}/recommendations`,
        { method: "GET" },
      );
      const payload = await readJsonResponse<RecommendationsResponse>(response);
      if (payload.success && payload.data) {
        setRecommendationsReport(payload.data);
      } else {
        setRecommendationsError(payload.message ?? payload.error ?? "Recommendations could not be loaded.");
      }
    } catch (error) {
      setRecommendationsError(error instanceof Error ? error.message : "Recommendations could not be loaded.");
    } finally {
      setIsLoadingRecommendations(false);
    }
  }

  // Only safe to call from an event handler (e.g. the Refresh button) — invoking this
  // directly from a useEffect body trips the "no synchronous setState in effect" lint rule,
  // since its very first statement sets state. The mount-time initial load below has its
  // own inline loader for that reason, matching the pattern used elsewhere in this codebase
  // (e.g. action-center-hub.tsx's loadContext).
  const loadLiveSnapshots = useCallback(async () => {
    setIsLoadingLiveSnapshots(true);
    setLiveSnapshotsError(null);
    try {
      const response = await fetch("/api/admin/field-workforce-compliance/live-snapshots", { method: "GET" });
      const payload = await readJsonResponse<LiveSnapshotListResponse>(response);
      if (payload.success && payload.data) {
        setLiveSnapshots(payload.data);
      } else {
        setLiveSnapshotsError(payload.message ?? payload.error ?? "Saved compliance months could not be loaded.");
      }
    } catch (error) {
      setLiveSnapshotsError(error instanceof Error ? error.message : "Saved compliance months could not be loaded.");
    } finally {
      setIsLoadingLiveSnapshots(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadInitialLiveSnapshots() {
      setIsLoadingLiveSnapshots(true);
      setLiveSnapshotsError(null);
      try {
        const response = await fetch("/api/admin/field-workforce-compliance/live-snapshots", { method: "GET" });
        const payload = await readJsonResponse<LiveSnapshotListResponse>(response);
        if (cancelled) return;
        if (payload.success && payload.data) {
          setLiveSnapshots(payload.data);
          if (payload.data.length > 0) void handleSelectLiveMonth(payload.data[0].monthKey);
        } else {
          setLiveSnapshotsError(payload.message ?? payload.error ?? "Saved compliance months could not be loaded.");
        }
      } catch (error) {
        if (!cancelled) setLiveSnapshotsError(error instanceof Error ? error.message : "Saved compliance months could not be loaded.");
      } finally {
        if (!cancelled) setIsLoadingLiveSnapshots(false);
      }
    }

    void loadInitialLiveSnapshots();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handlePreview() {
    if (!selectedFile || isPreviewing) return;
    setIsPreviewing(true);
    setResult(null);
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    setArchiveMessage(null);
    setArchiveError(null);
    setSourceMode("excel-preview");
    setLiveMirrorMonthKey(null);
    setRecommendationsReport(null);
    setRecommendationsMessage(null);
    setRecommendationsError(null);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const response = await fetch("/api/admin/field-workforce-compliance/preview", {
        body: formData,
        method: "POST",
      });
      const payload = await readJsonResponse<PreviewResponse>(response);
      setErrors(payload.errors ?? []);
      setWarnings(payload.warnings ?? payload.data?.warnings ?? []);
      if (payload.success && payload.data) {
        setResult(payload.data);
        setActiveTab("timeline");
      } else {
        setActiveTab("overview");
        setMessage(payload.message ?? payload.error ?? "Preview failed.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview failed.");
    } finally {
      setIsPreviewing(false);
    }
  }

  /** Shows a saved Field Workforce Compliance snapshot for the chosen month — a fast DB
   * read, not a live recompute. Snapshots are kept current automatically: the visits-report
   * sync (cron + manual backfill) recomputes whichever month(s) it touches, and a one-time
   * historical backfill covers everything before that. `forceRefresh` recomputes the chosen
   * month on the spot (e.g. the user's own "Refresh" action) rather than serving the cached copy. */
  async function handleSelectLiveMonth(monthKey: string, forceRefresh = false) {
    if (!monthKey || isLoadingSnapshotDetail) return;
    setIsLoadingSnapshotDetail(true);
    setResult(null);
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    setArchiveMessage(null);
    setArchiveError(null);
    setSelectedFile(null);
    setRecommendationsReport(null);
    setRecommendationsMessage(null);
    setRecommendationsError(null);

    try {
      const url = `/api/admin/field-workforce-compliance/live-snapshots/${monthKey}${forceRefresh ? "?force=true" : ""}`;
      const response = await fetch(url, { method: "GET" });
      const payload = await readJsonResponse<LiveSnapshotDetailResponse>(response);
      if (payload.success && payload.data) {
        setResult(payload.data.preview);
        setSourceMode("live-mirror");
        setLiveMirrorMonthKey(payload.data.monthKey);
        setMirrorLastSyncedAt(payload.data.computedAt);
        setMirrorFreshness(payload.mirrorFreshness ?? null);
        setSelectedMonthKey(payload.data.monthKey);
        setActiveTab("timeline");
        if (forceRefresh) void loadLiveSnapshots();
      } else {
        setActiveTab("overview");
        setMessage(payload.message ?? payload.error ?? "The saved compliance report could not be loaded.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The saved compliance report could not be loaded.");
    } finally {
      setIsLoadingSnapshotDetail(false);
    }
  }

  async function handleSaveArchive() {
    if (!selectedFile || !result || isSavingArchive) return;
    setIsSavingArchive(true);
    setArchiveMessage(null);
    setArchiveError(null);

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const response = await fetch("/api/admin/field-workforce-compliance/archive", {
        body: formData,
        method: "POST",
      });
      const payload = await readJsonResponse<ArchiveSaveResponse>(response);
      if (payload.success && payload.data) {
        setArchiveDetail(payload.data);
        setRecommendationsReport(null);
        setArchiveActiveTab("timeline");
        setActiveTab("archives");
        setArchiveMessage(`${payload.data.archive.monthKey} was saved as an archived review snapshot. No payroll or leave action was taken.`);
        await loadArchives();
        await loadRecommendations(payload.data.archive.id);
      } else if (payload.duplicate) {
        setArchiveError(payload.message ?? `${payload.duplicate.monthKey} is already archived. Duplicate month archives are blocked in Phase 2.`);
        setActiveTab("archives");
        await loadArchives();
      } else {
        setArchiveError(payload.message ?? payload.error ?? "Archive save failed.");
      }
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Archive save failed.");
    } finally {
      setIsSavingArchive(false);
    }
  }

  async function handleOpenArchive(archive: FieldWorkforceArchiveListItem) {
    setIsOpeningArchiveId(archive.id);
    setArchiveMessage(null);
    setArchiveError(null);
    try {
      const response = await fetch(`/api/admin/field-workforce-compliance/archive/${archive.id}`, {
        method: "GET",
      });
      const payload = await readJsonResponse<ArchiveDetailResponse>(response);
      if (payload.success && payload.data) {
        setArchiveDetail(payload.data);
        setRecommendationsReport(null);
        setArchiveActiveTab("timeline");
        await loadRecommendations(payload.data.archive.id);
      } else {
        setArchiveError(payload.message ?? payload.error ?? "Archived month could not be opened.");
      }
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : "Archived month could not be opened.");
    } finally {
      setIsOpeningArchiveId(null);
    }
  }

  async function handleSaveDecision(
    recommendation: FieldWorkforceRecommendation,
    decisionStatus: FieldWorkforceDecisionStatus,
    hrNote: string,
    decisionReason: FieldWorkforceDecisionReason | "",
  ) {
    if (decisionStatus !== "Pending" && !decisionReason) {
      setRecommendationsError("A decision reason is required for non-Pending HR decisions.");
      return;
    }
    if (decisionReason === "Other" && !hrNote.trim()) {
      setRecommendationsError("HR note is required when decision reason is Other.");
      return;
    }
    setIsSavingDecisionKey(recommendation.recommendationKey);
    setRecommendationsMessage(null);
    setRecommendationsError(null);
    try {
      const isLiveMirror = sourceMode === "live-mirror" && liveMirrorMonthKey !== null;
      const url = isLiveMirror
        ? `/api/admin/field-workforce-compliance/live-snapshots/${liveMirrorMonthKey}/recommendations`
        : `/api/admin/field-workforce-compliance/archive/${recommendation.importId}/recommendations`;
      const response = await fetch(url, {
        body: JSON.stringify({
          decisionReason,
          decisionStatus,
          hrNote,
          recommendationKey: recommendation.recommendationKey,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PATCH",
      });
      const payload = await readJsonResponse<RecommendationsResponse>(response);
      if (payload.success && payload.data) {
        setRecommendationsReport(payload.data);
        setRecommendationsMessage("HR decision saved for the recommendation report only. No payroll or leave action was executed.");
      } else {
        setRecommendationsError(payload.message ?? payload.error ?? "Decision update failed.");
      }
    } catch (error) {
      setRecommendationsError(error instanceof Error ? error.message : "Decision update failed.");
    } finally {
      setIsSavingDecisionKey(null);
    }
  }

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-3xl border border-slate-200 bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-5 xl:p-7">
      <div className="space-y-5">
        <AdminPageHero
          actions={(
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-2 rounded-xl font-black"
                disabled={!selectedFile || isPreviewing}
                onClick={() => void handlePreview()}
              >
                {isPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Preview File
              </Button>
              <Button
                className="gap-2 rounded-xl font-black"
                disabled={!result || !selectedFile || isPreviewing || isSavingArchive}
                type="button"
                variant="secondary"
                onClick={() => void handleSaveArchive()}
              >
                {isSavingArchive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Archive className="h-4 w-4" />}
                Save Archived Month
              </Button>
            </div>
          )}
          description="Understand and review monthly field workforce activity safely before any future HR, leave, or payroll decision."
          eyebrow="Operational HR Governance"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Workforce Compliance"
        />

        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
          <Button
            className="gap-2 rounded-xl font-black"
            type="button"
            variant="secondary"
            onClick={() => fileInputRef.current?.click()}
          >
            <FileSpreadsheet className="h-4 w-4" />
            Choose Workbook
          </Button>
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-slate-600">
            {selectedFile?.name ?? "No file selected — .xlsx only"}
          </span>
          <div className="flex shrink-0 items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
            <CalendarDays className="h-4 w-4 text-slate-400" />
            <span className="text-sm font-black text-slate-700">
              {selectedFile && result ? `${result.metadata.monthLabel} ${result.metadata.year}` : "Date detected after preview"}
            </span>
          </div>
          <input
            accept=".xlsx"
            className="hidden"
            ref={fileInputRef}
            type="file"
            onChange={(event) => {
              setSelectedFile(event.target.files?.[0] ?? null);
              setResult(null);
              setErrors([]);
              setWarnings([]);
              setMessage(null);
              setArchiveMessage(null);
              setArchiveError(null);
              setActiveTab("overview");
            }}
          />
        </div>

        <AdminTableShell
          description="Auto-updated whenever the iReports360 visits mirror syncs — every month self-refreshes in the background, so picking one here is instant. Nothing is archived automatically. Recommendations for a live month can still be reviewed and decided under the Recommendations tab below."
          title="Live View (Visits Mirror)"
        >
          <div className="flex flex-wrap items-end gap-3 p-4">
            {liveSnapshots.length > 0 ? (
              <label className="flex flex-col gap-1 text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">
                Month
                <SearchableSelect
                  className="h-10 min-w-[220px] rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400"
                  value={selectedMonthKey}
                  onChange={(event) => void handleSelectLiveMonth(event.target.value)}
                >
                  {liveSnapshots.map((snapshot) => (
                    <option key={snapshot.monthKey} value={snapshot.monthKey}>
                      {snapshot.monthKey} · {snapshot.employeeCount} employees
                    </option>
                  ))}
                </SearchableSelect>
              </label>
            ) : (
              <p className="text-sm text-slate-500">
                {isLoadingLiveSnapshots
                  ? "Loading saved compliance months..."
                  : "No saved compliance months yet — they appear automatically once the visits mirror syncs."}
              </p>
            )}
            {selectedMonthKey ? (
              <Button
                className="gap-2 rounded-xl font-black"
                disabled={isLoadingSnapshotDetail}
                type="button"
                variant="secondary"
                onClick={() => void handleSelectLiveMonth(selectedMonthKey, true)}
              >
                {isLoadingSnapshotDetail ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                Refresh
              </Button>
            ) : null}
            {sourceMode === "live-mirror" && mirrorLastSyncedAt ? (
              <span className="text-xs font-semibold text-slate-500">
                Report last computed {displayDateTime(mirrorLastSyncedAt)}
                {mirrorFreshness?.ageHours != null
                  ? ` · Visits mirror synced ${formatSyncAge(mirrorFreshness.ageHours)}`
                  : ""}
              </span>
            ) : null}
          </div>
          {liveSnapshotsError ? (
            <div className="border-t border-slate-100 p-4">
              <AdminCallout tone="warning">
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <p>{liveSnapshotsError}</p>
              </AdminCallout>
            </div>
          ) : null}
          {sourceMode === "live-mirror" && mirrorFreshness && (mirrorFreshness.isStale || mirrorFreshness.isOpenMonth) ? (
            <div className="border-t border-slate-100 p-4">
              <AdminCallout tone={mirrorFreshness.isStale ? "danger" : "warning"}>
                <AlertTriangle className="mt-0.5 h-4 w-4" />
                <p>
                  {mirrorFreshness.isStale
                    ? `The visits mirror hasn't synced successfully in ${mirrorFreshness.ageHours != null ? formatSyncAge(mirrorFreshness.ageHours) : "over a day"}${mirrorFreshness.latestStatus === "failed" ? " (last sync failed)" : ""}. This month's latest days may be incomplete — verify before approving any leave or deduction.`
                    : "This month is still in progress. Its most recent days are still filling in, so treat late “N” days as provisional and confirm before approving any leave or deduction."}
                </p>
              </AdminCallout>
            </div>
          ) : null}
        </AdminTableShell>

        {message ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>{message}</p>
          </AdminCallout>
        ) : null}
        {archiveMessage ? (
          <AdminCallout tone="success">
            <Archive className="mt-0.5 h-4 w-4" />
            <p>{archiveMessage}</p>
          </AdminCallout>
        ) : null}
        {archiveError ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>{archiveError}</p>
          </AdminCallout>
        ) : null}
        {recommendationsMessage ? (
          <AdminCallout tone="success">
            <BadgeCheck className="mt-0.5 h-4 w-4" />
            <p>{recommendationsMessage}</p>
          </AdminCallout>
        ) : null}
        {recommendationsError ? (
          <AdminCallout tone="warning">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>{recommendationsError}</p>
          </AdminCallout>
        ) : null}
        <ValidationIssues issues={errors} title="Preview blocked" tone="danger" />
        <ValidationIssues issues={warnings} title="Preview warnings" tone="warning" />

        <WorkspaceTabs activeTab={activeTab} tabs={mainWorkspaceTabs} onChange={handleWorkspaceTabChange} />
        {activeTab === "archives" ? (
          <ArchivedMonthsPanel
            archiveActiveTab={archiveActiveTab}
            archiveDetail={archiveDetail}
            archives={archives}
            isLoadingArchives={isLoadingArchives}
            isLoadingRecommendations={isLoadingRecommendations}
            isOpeningArchiveId={isOpeningArchiveId}
            isSavingDecisionKey={isSavingDecisionKey}
            onArchiveTabChange={setArchiveActiveTab}
            onOpenArchive={(archive) => void handleOpenArchive(archive)}
            onRefresh={() => void loadArchives()}
            onRefreshRecommendations={(auditFinalReportView) => {
              if (archiveDetail) void loadRecommendations(archiveDetail.archive.id, auditFinalReportView);
            }}
            onSaveDecision={(recommendation, decisionStatus, hrNote, decisionReason) => void handleSaveDecision(recommendation, decisionStatus, hrNote, decisionReason)}
            recommendationsReport={recommendationsReport}
          />
        ) : activeTab === "comparison" ? (
          <ComparisonPanel
            isLoading={isLoadingComparison}
            report={comparisonReport}
            onRefresh={() => void loadComparison()}
          />
        ) : activeTab === "recommendations" ? (
          sourceMode === "live-mirror" && liveMirrorMonthKey ? (
            <RecommendationsPanel
              isLoading={isLoadingRecommendations}
              isSavingDecisionKey={isSavingDecisionKey}
              report={recommendationsReport}
              onRefresh={() => void loadLiveMirrorRecommendations(liveMirrorMonthKey)}
              onSaveDecision={(recommendation, decisionStatus, hrNote, decisionReason) => void handleSaveDecision(recommendation, decisionStatus, hrNote, decisionReason)}
            />
          ) : (
            <Card className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
              <p className="mx-auto max-w-xl text-sm leading-6 text-slate-500">
                Load a month with &quot;Load from Visits Mirror&quot; above to review and decide recommendations here, or open a saved month from the Excel Archives tab.
              </p>
            </Card>
          )
        ) : result ? (
          <>
            <ReviewWorkspacePanels
              activeTab={activeTab}
              errors={errors}
              key={`${result.metadata.year}-${result.metadata.month}-${result.metadata.fileName}`}
              result={result}
              warnings={warnings}
            />
            {result.severityCounts.Review > 0 && !result.metadata.holidayConnected ? (
              <AdminCallout tone="warning">
                <CalendarDays className="mt-0.5 h-4 w-4" />
                <p>{result.metadata.holidayMessage ?? "Public holiday overlay could not be loaded for this preview."}</p>
              </AdminCallout>
            ) : null}
          </>
        ) : (
          <Card className="rounded-xl border border-slate-200 bg-white p-8 text-center shadow-sm">
            <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-xl border border-orange-200 bg-orange-50 text-orange-600">
              <BadgeCheck className="h-5 w-5" />
            </div>
            <h2 className="mt-4 text-lg font-black text-slate-950">Preview workspace ready</h2>
            <p className="mx-auto mt-2 max-w-xl text-sm leading-6 text-slate-500">
              Upload a monthly workbook to review normalized activity, severity labels, public holiday overlays, and employee timelines.
            </p>
            <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-black uppercase tracking-[0.14em] text-slate-500">
              <ListFilter className="h-3.5 w-3.5" />
              Compact tabbed workspace
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
