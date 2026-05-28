"use client";

import {
  AlertTriangle,
  BadgeCheck,
  CalendarDays,
  FileSpreadsheet,
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

const severityOptions: Array<"All" | FieldWorkforceSeverity> = ["All", "High", "Review", "Medium", "Low"];
const statusOptions: Array<"All" | FieldWorkforceCellStatus> = ["All", "N", "AV", "CP", "VISITS", "F", "UNKNOWN"];

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
  if (severity === "Review") return <Badge variant="warning">{severity}</Badge>;
  if (severity === "Medium") return <Badge variant="warning">{severity}</Badge>;
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
        "relative flex h-10 w-11 items-center justify-center rounded-lg border text-xs font-black transition focus:outline-none focus:ring-2 focus:ring-orange-300",
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

function EmployeeTimelineGrid({
  employees,
  onSelectCell,
  selectedCell,
}: {
  employees: FieldWorkforceEmployeeSummary[];
  onSelectCell: (cell: FieldWorkforceDayCell) => void;
  selectedCell: FieldWorkforceDayCell | null;
}) {
  const dates = employees[0]?.timeline ?? [];
  return (
    <div className="hidden md:block">
      <div className="phoenix-horizontal-scroll max-h-[64vh] overflow-auto rounded-xl border border-slate-200 bg-white">
        <table className="min-w-max border-separate border-spacing-0 text-left">
          <thead className="sticky top-0 z-30 bg-slate-50 text-[10px] font-black uppercase tracking-[0.13em] text-slate-500">
            <tr>
              <th className="sticky left-0 z-40 w-72 min-w-72 border-b border-r border-slate-200 bg-slate-50 px-4 py-3">
                Employee
              </th>
              {dates.map((cell) => (
                <th
                  className={cn(
                    "w-14 min-w-14 border-b border-r border-slate-200 px-2 py-2 text-center",
                    cell.isFriday ? "bg-slate-100" : "",
                    cell.isPublicHoliday ? "bg-amber-50 text-amber-700" : "",
                  )}
                  key={cell.dateIso}
                >
                  <span className="block text-[11px] text-slate-900">{cell.dayNumber}</span>
                  <span>{weekday(cell.dateIso)}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {employees.map((employee) => (
              <tr className="group hover:bg-slate-50/70" key={employee.hrId}>
                <td className="sticky left-0 z-20 w-72 min-w-72 border-b border-r border-slate-100 bg-white px-4 py-3 shadow-[10px_0_14px_-16px_rgba(15,23,42,0.55)] group-hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-black text-slate-950">{employee.employeeName}</p>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5">
                      <span className="font-mono text-xs font-bold text-slate-500">{employee.hrId}</span>
                      <Badge variant={employee.matchStatus === "matched" ? "success" : "danger"}>
                        {employee.matchStatus}
                      </Badge>
                    </div>
                  </div>
                </td>
                {employee.timeline.map((cell) => (
                  <td className="border-b border-r border-slate-100 px-1.5 py-2 text-center" key={`${employee.hrId}-${cell.dateIso}`}>
                    <TimelineDayCell cell={cell} onSelect={onSelectCell} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-4">
        <TimelineCellDetails cell={selectedCell} />
      </div>
    </div>
  );
}

function MobileTimeline({
  employee,
  onSelectCell,
  selectedCell,
}: {
  employee: FieldWorkforceEmployeeSummary | null;
  onSelectCell: (cell: FieldWorkforceDayCell) => void;
  selectedCell: FieldWorkforceDayCell | null;
}) {
  if (!employee) {
    return (
      <Card className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500 md:hidden">
        No employee selected.
      </Card>
    );
  }

  return (
    <div className="space-y-4 md:hidden">
      <Card className="rounded-xl border border-slate-200 bg-white p-4">
        <p className="text-sm font-black text-slate-950">{employee.employeeName}</p>
        <p className="mt-1 font-mono text-xs font-bold text-slate-500">{employee.hrId}</p>
        <div className="mt-4 grid grid-cols-7 gap-1.5">
          {employee.timeline.map((cell) => (
            <TimelineDayCell cell={cell} key={cell.dateIso} onSelect={onSelectCell} />
          ))}
        </div>
      </Card>
      <TimelineCellDetails cell={selectedCell} />
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
          {issues.slice(0, 8).map((issue, index) => (
            <p key={`${issue.code}:${issue.rowNumber ?? "file"}:${index}`}>
              {issue.rowNumber ? `Row ${issue.rowNumber}: ` : ""}{issue.message}
            </p>
          ))}
          {issues.length > 8 ? <p>{issues.length - 8} more issue(s) hidden in diagnostics.</p> : null}
        </div>
      </div>
    </AdminCallout>
  );
}

function ReviewQueue({
  candidates,
  employeeFilter,
}: {
  candidates: FieldWorkforceReviewCandidate[];
  employeeFilter: string;
}) {
  const [severity, setSeverity] = useState<"All" | FieldWorkforceSeverity>("All");
  const [status, setStatus] = useState<"All" | FieldWorkforceCellStatus>("All");
  const [holidayOnly, setHolidayOnly] = useState(false);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const filtered = useMemo(() => candidates.filter((candidate) => {
    if (severity !== "All" && candidate.severity !== severity) return false;
    if (status !== "All" && !candidateMatchesStatus(candidate, status)) return false;
    if (holidayOnly && !candidate.context.some((item) => item.toLowerCase().includes("public holiday"))) return false;
    if (employeeFilter.trim()) {
      const needle = employeeFilter.trim().toLowerCase();
      const haystack = `${candidate.employeeName} ${candidate.hrId}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  }), [candidates, employeeFilter, holidayOnly, severity, status]);

  return (
    <AdminTableShell
      description="Review candidates are labels only. They do not approve, deduct, save, or mutate payroll/leave."
      title="Review Candidate Queue"
    >
      <div className="grid gap-3 border-b border-slate-100 p-4 md:grid-cols-[180px_180px_1fr]">
        <select
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={severity}
          onChange={(event) => setSeverity(event.target.value as typeof severity)}
        >
          {severityOptions.map((option) => <option key={option} value={option}>{option} severity</option>)}
        </select>
        <select
          className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
        >
          {statusOptions.map((option) => <option key={option} value={option}>{option === "All" ? "All statuses" : statusMeaning(option)}</option>)}
        </select>
        <label className="inline-flex h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700">
          <input
            checked={holidayOnly}
            className="h-4 w-4 accent-orange-600"
            type="checkbox"
            onChange={(event) => setHolidayOnly(event.target.checked)}
          />
          Public holiday warnings only
        </label>
      </div>
      <div className="phoenix-horizontal-scroll overflow-x-auto">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
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
            {filtered.slice(0, 250).map((candidate) => (
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
            {filtered.length === 0 ? (
              <tr>
                <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={8}>
                  No review candidates match the current filters.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
      {filtered.length > 250 ? (
        <div className="border-t border-slate-100 px-4 py-3 text-xs font-semibold text-slate-500">
          Showing first 250 of {formatNumber(filtered.length)} candidates.
        </div>
      ) : null}
    </AdminTableShell>
  );
}

function MonthlySummaryTable({ employees }: { employees: FieldWorkforceEmployeeSummary[] }) {
  return (
    <AdminTableShell
      description="Employee-level totals for the uploaded file. Public holidays are warning overlays, not automatic calculation changes."
      title="Monthly Employee Summary"
    >
      <div className="phoenix-horizontal-scroll overflow-x-auto">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">
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
            {employees.map((employee) => (
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

export function FieldWorkforceComplianceWorkspace() {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [result, setResult] = useState<FieldWorkforcePreviewResult | null>(null);
  const [errors, setErrors] = useState<FieldWorkforceValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<FieldWorkforceValidationIssue[]>([]);
  const [message, setMessage] = useState<string | null>(null);
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

  async function readPreviewResponse(response: Response): Promise<PreviewResponse> {
    const text = await response.text();
    if (!text) return { success: response.ok, message: response.statusText };
    try {
      return JSON.parse(text) as PreviewResponse;
    } catch {
      return { success: false, message: text };
    }
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
      } else {
        setSelectedHrId("");
        setSelectedCell(null);
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
  const reviewCount = result?.severityCounts.Review ?? 0;
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
              className="flex min-h-[118px] w-full items-center justify-between gap-4 rounded-xl border border-dashed border-slate-300 bg-white px-4 py-5 text-left text-sm shadow-sm transition hover:border-orange-400 hover:bg-orange-50/40"
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <MetricCard label="Employees" value={formatNumber(result.metadata.employeeCount)} />
              <MetricCard label="Review Candidates" tone={totalCandidates ? "warning" : "success"} value={formatNumber(totalCandidates)} />
              <MetricCard label="High Severity" tone={highCount ? "danger" : "success"} value={formatNumber(highCount)} />
              <MetricCard label="Holiday Warnings" tone={holidayWarnings ? "warning" : "neutral"} value={formatNumber(holidayWarnings)} />
              <MetricCard label="Matched HR IDs" tone={result.metadata.unmatchedEmployees ? "warning" : "success"} value={`${formatNumber(result.metadata.matchedEmployees)} / ${formatNumber(result.metadata.employeeCount)}`} />
            </div>

            <AdminTableShell
              description="The timeline is the primary review surface for monthly field activity."
              title="Employee Timeline Review"
            >
              <div className="space-y-4 p-4">
                <div className="sticky top-0 z-30 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
                  <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
                    <div className="flex flex-wrap gap-2">
                      <LegendChip className="border-rose-300 bg-rose-50 text-rose-800" label="No activity">N</LegendChip>
                      <LegendChip className="border-sky-300 bg-sky-50 text-sky-800" label="Vacation">AV</LegendChip>
                      <LegendChip className="border-violet-300 bg-violet-50 text-violet-800" label="Campaign">CP</LegendChip>
                      <LegendChip className="border-emerald-300 bg-emerald-50 text-emerald-800" label="Visits">5</LegendChip>
                      <LegendChip className="border-slate-200 bg-slate-100 text-slate-500" label="Friday">F</LegendChip>
                      <LegendChip className="border-amber-300 bg-amber-50 text-amber-800 ring-2 ring-amber-300" label="Holiday">H</LegendChip>
                    </div>
                    <div className="relative">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                      <input
                        className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                        placeholder="Filter employee or HR ID"
                        value={employeeSearch}
                        onChange={(event) => setEmployeeSearch(event.target.value)}
                      />
                    </div>
                  </div>
                  <div className="mt-3 grid gap-3 md:hidden">
                    <select
                      className="h-10 rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                      value={selectedEmployee?.hrId ?? ""}
                      onChange={(event) => setSelectedHrId(event.target.value)}
                    >
                      {filteredEmployees.map((employee) => (
                        <option key={employee.hrId} value={employee.hrId}>{employee.employeeName} / {employee.hrId}</option>
                      ))}
                    </select>
                  </div>
                </div>

                <EmployeeTimelineGrid
                  employees={filteredEmployees}
                  selectedCell={selectedCell}
                  onSelectCell={setSelectedCell}
                />
                <MobileTimeline
                  employee={selectedEmployee}
                  selectedCell={selectedCell}
                  onSelectCell={setSelectedCell}
                />

                {selectedEmployee ? (
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
                        onChange={(event) => setEmployeeNotes((current) => ({
                          ...current,
                          [selectedEmployee.hrId]: event.target.value,
                        }))}
                      />
                    </div>
                  </Card>
                ) : null}
              </div>
            </AdminTableShell>

            {reviewCount > 0 && !result.metadata.holidayConnected ? (
              <AdminCallout tone="warning">
                <CalendarDays className="mt-0.5 h-4 w-4" />
                <p>{result.metadata.holidayMessage ?? "Public holiday overlay could not be loaded for this preview."}</p>
              </AdminCallout>
            ) : null}

            <ReviewQueue candidates={result.reviewCandidates} employeeFilter={employeeSearch} />
            <MonthlySummaryTable employees={result.employees} />

            <AdminTableShell
              description="Technical parsing details for support and validation."
              title="Import Diagnostics"
            >
              <div className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-4">
                <MetricCard label="File" value={result.metadata.fileName} />
                <MetricCard label="Sheet" value={result.metadata.sheetName} />
                <MetricCard label="Date Range" value={`${displayDate(result.metadata.dateRange.start)} - ${displayDate(result.metadata.dateRange.end)}`} />
                <MetricCard
                  label="Public Holidays"
                  tone={result.metadata.holidayConnected ? "success" : "warning"}
                  value={`${formatNumber(result.metadata.holidaysDetected)} detected`}
                />
              </div>
            </AdminTableShell>
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
          </Card>
        )}
      </div>
    </div>
  );
}
