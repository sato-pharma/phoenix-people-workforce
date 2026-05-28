"use client";

import {
  AlertTriangle,
  BadgeCheck,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileSpreadsheet,
  ListFilter,
  Loader2,
  Search,
  ShieldAlert,
  UploadCloud,
} from "lucide-react";
import { useMemo, useRef, useState } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  FieldWorkforceCellStatus,
  FieldWorkforceDayCell,
  FieldWorkforceEmployeeSummary,
  FieldWorkforcePreviewResult,
  FieldWorkforceReviewCandidate,
  FieldWorkforceSeverity,
  FieldWorkforceValidationIssue,
} from "@/lib/field-workforce-compliance/types";
import { cn } from "@/lib/utils";

type PreviewResponse = {
  data?: FieldWorkforcePreviewResult;
  errors?: FieldWorkforceValidationIssue[];
  error?: string;
  message?: string;
  success: boolean;
  warnings?: FieldWorkforceValidationIssue[];
};

type WorkspaceTab = "overview" | "timeline" | "queue" | "summary" | "diagnostics";

const workspaceTabs: Array<{ id: WorkspaceTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "timeline", label: "Employee Timeline" },
  { id: "queue", label: "Review Queue" },
  { id: "summary", label: "Monthly Summary" },
  { id: "diagnostics", label: "Diagnostics" },
];

const severityOptions: Array<"All" | FieldWorkforceSeverity> = ["All", "High", "Review", "Medium", "Low"];
const statusOptions: Array<"All" | FieldWorkforceCellStatus> = ["All", "N", "AV", "CP", "VISITS", "F", "UNKNOWN"];
const pageSizeOptions = [25, 50, 100];

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

function TimelineDayCell({
  cell,
  onSelect,
}: {
  cell: FieldWorkforceDayCell;
  onSelect: (cell: FieldWorkforceDayCell) => void;
}) {
  return (
    <button
      aria-label={`${cell.employeeName} ${cell.dateIso}: ${cell.explanation}`}
      className={cn(
        "relative flex h-10 w-11 shrink-0 items-center justify-center rounded-lg border text-xs font-black transition focus:outline-none focus:ring-2 focus:ring-orange-300",
        statusCellClass(cell),
      )}
      title={cell.explanation}
      type="button"
      onClick={() => onSelect(cell)}
      onFocus={() => onSelect(cell)}
      onMouseEnter={() => onSelect(cell)}
    >
      {statusLabel(cell.status, cell.visitCount)}
      {cell.isPublicHoliday ? (
        <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border border-white bg-amber-400" />
      ) : null}
    </button>
  );
}

function TimelineCellDetails({ cell }: { cell: FieldWorkforceDayCell | null }) {
  if (!cell) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">
        Select a day to inspect the calculation context.
      </Card>
    );
  }

  return (
    <Card className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_14px_34px_rgba(15,23,42,0.06)]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">{displayDate(cell.dateIso)} / {weekday(cell.dateIso)}</p>
          <h3 className="mt-1 text-lg font-black text-slate-950">{cell.employeeName}</h3>
          <p className="text-xs font-semibold text-slate-500">{cell.hrId}</p>
        </div>
        {severityBadge(cell.severity)}
      </div>
      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Raw</p>
          <p className="mt-1 font-black text-slate-900">{formatRawValue(cell.rawValue)}</p>
        </div>
        <div className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2">
          <p className="text-[10px] font-black uppercase tracking-[0.14em] text-slate-400">Meaning</p>
          <p className="mt-1 font-black text-slate-900">{statusMeaning(cell.status)}</p>
        </div>
      </div>
      <p className="mt-4 text-sm leading-6 text-slate-700">{cell.explanation}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {cell.context.length > 0 ? cell.context.map((item) => (
          <Badge key={item} variant={item.includes("Public holiday") ? "warning" : "neutral"}>{item}</Badge>
        )) : <Badge variant="success">Counted normally</Badge>}
        {cell.countedAsWorkedDay ? <Badge variant="success">Worked day</Badge> : null}
        {cell.countedAsVisitTotal ? <Badge variant="success">Visit total</Badge> : null}
        {cell.countedAsNoActivityCandidate ? <Badge variant="warning">N candidate</Badge> : null}
      </div>
    </Card>
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
}: {
  activeTab: WorkspaceTab;
  onChange: (tab: WorkspaceTab) => void;
}) {
  return (
    <div className="phoenix-horizontal-scroll overflow-x-auto rounded-2xl border border-slate-200 bg-white/90 p-1.5 shadow-sm">
      <div className="flex min-w-max gap-1.5">
        {workspaceTabs.map((tab) => (
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
        <MetricCard label="Read-only Status" tone="success" value="Preview only" />
        <MetricCard label="Public Holidays" tone={result.metadata.holidayConnected ? "success" : "warning"} value={`${formatNumber(result.metadata.holidaysDetected)} detected`} />
      </div>
      <AdminCallout tone="neutral">
        <ShieldAlert className="mt-0.5 h-4 w-4" />
        <p>This workspace is still Phase 1: in-memory preview only. It does not save, approve, deduct payroll, or mutate leave balances.</p>
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
        <select
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={selectedEmployee?.hrId ?? ""}
          onChange={(event) => onSelectEmployee(event.target.value)}
        >
          {employees.map((employee) => (
            <option key={employee.hrId} value={employee.hrId}>{employee.employeeName} / {employee.hrId}</option>
          ))}
        </select>
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

function EmployeeMiniSummary({ employee }: { employee: FieldWorkforceEmployeeSummary }) {
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
      <MetricCard label="Eligible Days" value={formatNumber(employee.eligibleWorkingDays)} />
      <MetricCard label="Worked Days" tone="success" value={formatNumber(employee.workedDays)} />
      <MetricCard label="N Candidates" tone={employee.noActivityCandidates ? "warning" : "success"} value={formatNumber(employee.noActivityCandidates)} />
      <MetricCard label="Visits" tone="success" value={formatNumber(employee.totalVisits)} />
      <MetricCard label="AV Signals" tone={employee.vacationSignalDays ? "warning" : "neutral"} value={formatNumber(employee.vacationSignalDays)} />
      <MetricCard label="CP Signals" value={formatNumber(employee.campaignDays)} />
      <MetricCard label="Holiday Warnings" tone={employee.holidayWarnings ? "warning" : "neutral"} value={formatNumber(employee.holidayWarnings)} />
      <MetricCard label="Pre-hire Context" tone={employee.preHireIgnoredValues ? "warning" : "neutral"} value={formatNumber(employee.preHireIgnoredValues)} />
    </div>
  );
}

function SingleEmployeeTimeline({
  employee,
  onSelectCell,
  selectedCell,
}: {
  employee: FieldWorkforceEmployeeSummary;
  onSelectCell: (cell: FieldWorkforceDayCell) => void;
  selectedCell: FieldWorkforceDayCell | null;
}) {
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <Card className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="border-b border-slate-100 bg-slate-50 px-4 py-3">
          <p className="text-sm font-black text-slate-950">{employee.employeeName}</p>
          <p className="mt-1 font-mono text-xs font-bold text-slate-500">{employee.hrId} / Hire date {employee.hiringDateIso ?? "-"}</p>
        </div>
        <div className="phoenix-horizontal-scroll overflow-x-auto p-4">
          <div className="min-w-max">
            <div className="mb-2 flex gap-1.5">
              {employee.timeline.map((cell) => (
                <div
                  className={cn(
                    "w-11 shrink-0 rounded-md px-1 py-1 text-center text-[10px] font-black uppercase tracking-[0.08em] text-slate-500",
                    cell.isFriday ? "bg-slate-100" : "",
                    cell.isPublicHoliday ? "bg-amber-50 text-amber-700" : "",
                  )}
                  key={`${cell.dateIso}-header`}
                >
                  <span className="block text-[11px] text-slate-900">{cell.dayNumber}</span>
                  <span>{weekday(cell.dateIso)}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-1.5">
              {employee.timeline.map((cell) => (
                <TimelineDayCell cell={cell} key={cell.dateIso} onSelect={onSelectCell} />
              ))}
            </div>
          </div>
        </div>
      </Card>
      <TimelineCellDetails cell={selectedCell} />
    </div>
  );
}

function TimelinePanel({
  employeeNotes,
  employees,
  employeeSearch,
  onEmployeeSearchChange,
  onSelectCell,
  onSelectEmployee,
  onUpdateEmployeeNote,
  selectedCell,
  selectedEmployee,
}: {
  employeeNotes: Record<string, string>;
  employees: FieldWorkforceEmployeeSummary[];
  employeeSearch: string;
  onEmployeeSearchChange: (value: string) => void;
  onSelectCell: (cell: FieldWorkforceDayCell) => void;
  onSelectEmployee: (hrId: string) => void;
  onUpdateEmployeeNote: (hrId: string, value: string) => void;
  selectedCell: FieldWorkforceDayCell | null;
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
      <EmployeePicker
        employeeSearch={employeeSearch}
        employees={employees}
        selectedEmployee={selectedEmployee}
        onEmployeeSearchChange={onEmployeeSearchChange}
        onSelectEmployee={onSelectEmployee}
      />
      <TimelineLegend />
      <EmployeeMiniSummary employee={selectedEmployee} />
      <SingleEmployeeTimeline
        employee={selectedEmployee}
        selectedCell={selectedCell}
        onSelectCell={onSelectCell}
      />
      <Card className="rounded-xl border border-slate-200 bg-white p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-black text-slate-950">Temporary HR review note</p>
            <p className="mt-1 text-xs font-semibold text-slate-500">Session-only. Not saved, not approved, not sent to payroll or leave.</p>
          </div>
          <textarea
            className="min-h-20 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100 lg:max-w-xl"
            placeholder="Official conference, pending medical leave, field assignment, training day, device issue..."
            value={employeeNotes[selectedEmployee.hrId] ?? ""}
            onChange={(event) => onUpdateEmployeeNote(selectedEmployee.hrId, event.target.value)}
          />
        </div>
      </Card>
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
        <select
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={severity}
          onChange={(event) => {
            setSeverity(event.target.value as typeof severity);
            resetPage();
          }}
        >
          {severityOptions.map((option) => <option key={option} value={option}>{option} severity</option>)}
        </select>
        <select
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={status}
          onChange={(event) => {
            setStatus(event.target.value as typeof status);
            resetPage();
          }}
        >
          {statusOptions.map((option) => <option key={option} value={option}>{option === "All" ? "All statuses" : statusMeaning(option)}</option>)}
        </select>
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
        <select
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            resetPage();
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </select>
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

function MonthlySummaryTable({ employees }: { employees: FieldWorkforceEmployeeSummary[] }) {
  const [query, setQuery] = useState("");
  const [pageSize, setPageSize] = useState(25);
  const [page, setPage] = useState(1);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return employees;
    return employees.filter((employee) =>
      `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle),
    );
  }, [employees, query]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const visibleRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <AdminTableShell
      description="Compact employee-level totals. Public holidays are warning overlays, not automatic calculation changes."
      title="Monthly Employee Summary"
    >
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
        <select
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={pageSize}
          onChange={(event) => {
            setPageSize(Number(event.target.value));
            setPage(1);
          }}
        >
          {pageSizeOptions.map((option) => <option key={option} value={option}>{option} rows</option>)}
        </select>
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
              <th className="px-4 py-3">N</th>
              <th className="px-4 py-3">AV</th>
              <th className="px-4 py-3">CP</th>
              <th className="px-4 py-3">Visits</th>
              <th className="px-4 py-3">Holidays</th>
              <th className="px-4 py-3">Pre-hire</th>
              <th className="px-4 py-3">Unknown</th>
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
                <td className="px-4 py-3 font-bold text-rose-700">{formatNumber(employee.noActivityCandidates)}</td>
                <td className="px-4 py-3 text-sky-700">{formatNumber(employee.vacationSignalDays)}</td>
                <td className="px-4 py-3 text-violet-700">{formatNumber(employee.campaignDays)}</td>
                <td className="px-4 py-3 text-emerald-700">{formatNumber(employee.totalVisits)}</td>
                <td className="px-4 py-3 text-orange-700">{formatNumber(employee.holidayWarnings)}</td>
                <td className="px-4 py-3 text-rose-700">{formatNumber(employee.preHireIgnoredValues)}</td>
                <td className="px-4 py-3 text-red-700">{formatNumber(employee.unknownValues)}</td>
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
          <summary className="cursor-pointer text-sm font-black text-slate-900">Phase 1 boundaries</summary>
          <div className="mt-3 grid gap-2 text-sm leading-6 text-slate-600 sm:grid-cols-2">
            <p>No database writes.</p>
            <p>No upload archive.</p>
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

export function FieldWorkforceComplianceWorkspace() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [result, setResult] = useState<FieldWorkforcePreviewResult | null>(null);
  const [errors, setErrors] = useState<FieldWorkforceValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<FieldWorkforceValidationIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("overview");
  const [employeeSearch, setEmployeeSearch] = useState("");
  const [selectedHrId, setSelectedHrId] = useState<string>("");
  const [selectedCell, setSelectedCell] = useState<FieldWorkforceDayCell | null>(null);
  const [employeeNotes, setEmployeeNotes] = useState<Record<string, string>>({});

  const filteredEmployees = useMemo(() => {
    const rows = result?.employees ?? [];
    const needle = employeeSearch.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((employee) =>
      `${employee.employeeName} ${employee.hrId}`.toLowerCase().includes(needle),
    );
  }, [employeeSearch, result?.employees]);

  const selectedEmployee =
    filteredEmployees.find((employee) => employee.hrId === selectedHrId) ??
    filteredEmployees[0] ??
    null;
  const effectiveSelectedCell =
    selectedCell && selectedEmployee && selectedCell.hrId === selectedEmployee.hrId
      ? selectedCell
      : selectedEmployee?.timeline[0] ?? null;

  async function readPreviewResponse(response: Response): Promise<PreviewResponse> {
    const text = await response.text();
    if (!text) return { success: response.ok, message: response.statusText };
    try {
      return JSON.parse(text) as PreviewResponse;
    } catch {
      return { success: false, message: text };
    }
  }

  function selectEmployee(hrId: string) {
    const employee = filteredEmployees.find((row) => row.hrId === hrId) ?? result?.employees.find((row) => row.hrId === hrId);
    setSelectedHrId(hrId);
    setSelectedCell(employee?.timeline[0] ?? null);
  }

  async function handlePreview() {
    if (!selectedFile || isPreviewing) return;
    setIsPreviewing(true);
    setResult(null);
    setErrors([]);
    setWarnings([]);
    setMessage(null);
    setEmployeeNotes({});

    const formData = new FormData();
    formData.append("file", selectedFile);

    try {
      const response = await fetch("/api/admin/field-workforce-compliance/preview", {
        body: formData,
        method: "POST",
      });
      const payload = await readPreviewResponse(response);
      setErrors(payload.errors ?? []);
      setWarnings(payload.warnings ?? payload.data?.warnings ?? []);
      if (payload.success && payload.data) {
        setResult(payload.data);
        setSelectedHrId(payload.data.employees[0]?.hrId ?? "");
        setSelectedCell(payload.data.employees[0]?.timeline[0] ?? null);
        setActiveTab("timeline");
      } else {
        setSelectedHrId("");
        setSelectedCell(null);
        setActiveTab("overview");
        setMessage(payload.message ?? payload.error ?? "Preview failed.");
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Preview failed.");
    } finally {
      setIsPreviewing(false);
    }
  }

  const totalCandidates = result?.reviewCandidates.length ?? 0;
  const highCount = result?.severityCounts.High ?? 0;
  const holidayWarnings = result?.employees.reduce((sum, employee) => sum + employee.holidayWarnings, 0) ?? 0;

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-3xl border border-slate-200 bg-[linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-5 xl:p-7">
      <div className="space-y-5">
        <AdminPageHero
          actions={(
            <div className="flex flex-wrap gap-2">
              <Button
                className="gap-2 rounded-xl bg-slate-950 font-black text-white hover:bg-orange-600"
                disabled={!selectedFile || isPreviewing}
                onClick={() => void handlePreview()}
              >
                {isPreviewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
                Preview File
              </Button>
            </div>
          )}
          badges={(
            <>
              <AdminInsightChip tone="orange">Read-only preview</AdminInsightChip>
              <AdminInsightChip>No DB writes</AdminInsightChip>
              <AdminInsightChip tone="slate">No payroll or leave mutation</AdminInsightChip>
            </>
          )}
          description="Understand and review monthly field workforce activity safely before any future HR, leave, or payroll decision."
          eyebrow="Operational HR Governance"
          icon={<ShieldAlert className="h-3.5 w-3.5" />}
          title="Field Workforce Compliance"
        />

        <AdminTableShell
          description="Upload one monthly workbook. Phoenix parses and normalizes it in memory only."
          title="Monthly File Preview"
        >
          <div className="grid gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_320px]">
            <button
              className="flex min-h-[104px] w-full items-center justify-between gap-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-4 text-left text-sm shadow-sm transition hover:border-orange-400 hover:bg-orange-50/40"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              <span className="flex min-w-0 items-center gap-3">
                <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-orange-200 bg-orange-50 text-orange-600">
                  <FileSpreadsheet className="h-5 w-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-base font-black text-slate-950">
                    {selectedFile?.name ?? "Choose monthly field workforce workbook"}
                  </span>
                  <span className="mt-1 block text-xs font-semibold text-slate-500">
                    {selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(2)} MB selected` : ".xlsx only"}
                  </span>
                </span>
              </span>
              <UploadCloud className="h-5 w-5 shrink-0 text-slate-400" />
            </button>
            <Card className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-[10px] font-black uppercase tracking-[0.16em] text-slate-400">Preview Status</p>
              <div className="mt-3 flex items-center gap-2">
                <Badge variant={result ? "success" : errors.length ? "danger" : "neutral"}>
                  {result ? "Ready" : errors.length ? "Blocked" : "Waiting"}
                </Badge>
                {result ? <span className="text-xs font-semibold text-slate-500">{result.metadata.monthLabel} {result.metadata.year}</span> : null}
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-500">
                {result
                  ? `${result.metadata.employeeCount} employees from ${result.metadata.sheetName}.`
                  : "No upload data is saved in Phase 1."}
              </p>
              <input
                accept=".xlsx"
                className="hidden"
                ref={fileInputRef}
                type="file"
                onChange={(event) => {
                  setSelectedFile(event.target.files?.[0] ?? null);
                  setResult(null);
                  setSelectedHrId("");
                  setSelectedCell(null);
                  setErrors([]);
                  setWarnings([]);
                  setMessage(null);
                  setActiveTab("overview");
                }}
              />
            </Card>
          </div>
        </AdminTableShell>

        {message ? (
          <AdminCallout tone="danger">
            <AlertTriangle className="mt-0.5 h-4 w-4" />
            <p>{message}</p>
          </AdminCallout>
        ) : null}
        <ValidationIssues issues={errors} title="Preview blocked" tone="danger" />
        <ValidationIssues issues={warnings} title="Preview warnings" tone="warning" />

        {result ? (
          <>
            <WorkspaceTabs activeTab={activeTab} onChange={setActiveTab} />
            {activeTab === "overview" ? (
              <OverviewPanel
                highCount={highCount}
                holidayWarnings={holidayWarnings}
                result={result}
                totalCandidates={totalCandidates}
              />
            ) : null}
            {activeTab === "timeline" ? (
              <TimelinePanel
                employeeNotes={employeeNotes}
                employeeSearch={employeeSearch}
                employees={filteredEmployees}
                selectedCell={effectiveSelectedCell}
                selectedEmployee={selectedEmployee}
                onEmployeeSearchChange={setEmployeeSearch}
                onSelectCell={setSelectedCell}
                onSelectEmployee={selectEmployee}
                onUpdateEmployeeNote={(hrId, value) => setEmployeeNotes((current) => ({
                  ...current,
                  [hrId]: value,
                }))}
              />
            ) : null}
            {activeTab === "queue" ? <ReviewQueue candidates={result.reviewCandidates} /> : null}
            {activeTab === "summary" ? <MonthlySummaryTable employees={result.employees} /> : null}
            {activeTab === "diagnostics" ? (
              <DiagnosticsPanel errors={errors} result={result} warnings={warnings} />
            ) : null}
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
