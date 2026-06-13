"use client";

import { useMemo, useRef, useState } from "react";
import { CheckCircle2, CircleDashed, Download, FileSpreadsheet, Search, XCircle } from "lucide-react";
import { useRouter } from "next/navigation";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type {
  FingerprintReportColumn,
  FingerprintReportData,
  FingerprintReportRow,
} from "@/lib/attendance/fingerprint-report";

type DecisionState = "pending" | "deduct" | "exempt";

const DECISION_CONFIG: Record<DecisionState, { label: string; icon: React.ReactNode; className: string; next: DecisionState }> = {
  pending: { label: "Pending", icon: <CircleDashed className="h-3 w-3" />, className: "bg-slate-100 text-slate-500 ring-1 ring-slate-200 hover:bg-slate-200", next: "deduct" },
  deduct:  { label: "Deduct",  icon: <XCircle className="h-3 w-3" />,      className: "bg-rose-50 text-rose-700 ring-1 ring-rose-300 hover:bg-rose-100",   next: "exempt" },
  exempt:  { label: "Exempt",  icon: <CheckCircle2 className="h-3 w-3" />, className: "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-300 hover:bg-emerald-100", next: "pending" },
};

function DecisionToggle({ state, onChange }: { state: DecisionState; onChange: (next: DecisionState) => void }) {
  const cfg = DECISION_CONFIG[state];
  return (
    <button
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-[11px] font-bold tracking-wide transition-colors ${cfg.className}`}
      type="button"
      onClick={() => onChange(cfg.next)}
    >
      {cfg.icon}
      {cfg.label}
    </button>
  );
}

function rowDecisionClass(state: DecisionState): string {
  if (state === "deduct") return "bg-rose-50/40 hover:bg-rose-50/70";
  if (state === "exempt") return "bg-emerald-50/40 hover:bg-emerald-50/70";
  return "hover:bg-slate-50/60";
}

type Props = {
  initialData: FingerprintReportData | null;
  initialError: string | null;
};

function statusBadge(value: string) {
  if (value === "Complete") return <Badge variant="success">{value}</Badge>;
  if (value === "Short day") return <Badge variant="warning">{value}</Badge>;
  return <Badge variant="danger">{value}</Badge>;
}

function hasCellValue(row: FingerprintReportRow, column: FingerprintReportColumn) {
  return String(row[column.key] ?? "").trim().length > 0;
}

function stickyClass(column: FingerprintReportColumn, area: "body" | "head") {
  const base = area === "head" ? "bg-slate-50" : "bg-white group-hover:bg-slate-50";
  if (column.key === "deviceUserId") return `sticky left-0 z-30 w-24 min-w-24 ${base}`;
  if (column.key === "employeeHrId") return `sticky left-24 z-30 w-32 min-w-32 ${base}`;
  if (column.key === "employeeName") return `sticky left-56 z-30 w-60 min-w-60 shadow-[8px_0_12px_-12px_rgba(15,23,42,0.45)] ${base}`;
  return "";
}

export function FingerprintReport({ initialData, initialError }: Props) {
  const router = useRouter();
  const topScrollRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const [activeTab, setActiveTab] = useState<"daily" | "policies">("daily");
  const [decisions, setDecisions] = useState<Map<string, DecisionState>>(new Map());
  const [dateFrom, setDateFrom] = useState(initialData?.filters.dateFrom ?? "");
  const [dateTo, setDateTo] = useState(initialData?.filters.dateTo ?? "");
  const [deduction, setDeduction] = useState(initialData?.filters.deduction ?? "");
  const [department, setDepartment] = useState(initialData?.filters.department ?? "");
  const [deviceUserId, setDeviceUserId] = useState(initialData?.filters.deviceUserId ?? "");
  const [employeeHrId, setEmployeeHrId] = useState(initialData?.filters.employeeHrId ?? "");
  const [employeeName, setEmployeeName] = useState(initialData?.filters.employeeName ?? "");
  const [jobTitle, setJobTitle] = useState(initialData?.filters.jobTitle ?? "");
  const [search, setSearch] = useState(initialData?.filters.search ?? "");
  const [status, setStatus] = useState(initialData?.filters.status ?? "");

  const visibleColumns = useMemo(() => {
    const rows = initialData?.rows ?? [];
    return (initialData?.columns ?? []).filter((column) => column.always || rows.some((row) => hasCellValue(row, column)));
  }, [initialData?.columns, initialData?.rows]);

  function syncScroll(source: "top" | "table") {
    const top = topScrollRef.current;
    const table = tableScrollRef.current;
    if (!top || !table) return;
    if (source === "top") table.scrollLeft = top.scrollLeft;
    else top.scrollLeft = table.scrollLeft;
  }

  function filterParams() {
    const params = new URLSearchParams();
    if (dateFrom) params.set("dateFrom", dateFrom);
    if (dateTo) params.set("dateTo", dateTo);
    if (deduction.trim()) params.set("deduction", deduction.trim());
    if (department.trim()) params.set("department", department.trim());
    if (deviceUserId.trim()) params.set("deviceUserId", deviceUserId.trim());
    if (employeeHrId.trim()) params.set("employeeHrId", employeeHrId.trim());
    if (employeeName.trim()) params.set("employeeName", employeeName.trim());
    if (jobTitle.trim()) params.set("jobTitle", jobTitle.trim());
    if (search.trim()) params.set("search", search.trim());
    if (status.trim()) params.set("status", status.trim());
    return params;
  }

  function applyFilters() {
    const params = filterParams();
    router.push(`/attendance/fingerprint-report${params.toString() ? `?${params.toString()}` : ""}`);
  }

  const rows = initialData?.rows ?? [];
  const policyDetails = initialData?.policyDetails ?? [];
  const hasDateRange = Boolean(initialData?.hasDateRange);
  const exportHref = `/api/attendance/fingerprint-report/export${filterParams().toString() ? `?${filterParams().toString()}` : ""}`;

  const pendingCount = rows.filter((r) => r.status !== "Complete" && (decisions.get(r.sortKey) ?? "pending") === "pending").length;
  const deductCount  = rows.filter((r) => decisions.get(r.sortKey) === "deduct").length;
  const exemptCount  = rows.filter((r) => decisions.get(r.sortKey) === "exempt").length;

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={(
          <>
            <AdminInsightChip>{initialData?.summary.rows ?? 0} daily rows</AdminInsightChip>
            <AdminInsightChip tone="slate">{initialData?.summary.complete ?? 0} complete</AdminInsightChip>
            <AdminInsightChip tone="orange">{initialData?.summary.deductions ?? 0} deduction flags</AdminInsightChip>
          </>
        )}
        description="Live daily attendance built from raw fingerprint punches. Mark rows before sending to payroll — decisions are local until exported."
        eyebrow="Attendance"
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
        title="My Attendance"
        actions={(
          <a
            className={`inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 backdrop-blur transition hover:border-[#FDBA74] hover:bg-white/[0.16] hover:text-white ${!hasDateRange || rows.length === 0 ? "pointer-events-none opacity-50" : ""}`}
            href={exportHref}
          >
            <Download className="h-4 w-4" />
            Export XLSX
          </a>
        )}
      />

      {initialError ? <AdminCallout tone="danger">{initialError}</AdminCallout> : null}
      {!hasDateRange ? (
        <AdminCallout tone="warning">
          Choose a From and To date, then click Apply. The daily attendance report will not load all historical logs by default.
        </AdminCallout>
      ) : null}
      <AdminCallout tone="neutral">
        The report evaluates active attendance policies and estimates deductions from day fractions. Payroll is not changed from this screen.
      </AdminCallout>

      {rows.length > 0 ? (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-slate-200 bg-white px-5 py-3.5 shadow-sm">
          <span className="text-xs font-black uppercase tracking-[0.14em] text-slate-400">Before Decision</span>
          <div className="flex items-center gap-1.5 rounded-full bg-slate-100 px-3 py-1 text-xs font-bold text-slate-500 ring-1 ring-slate-200">
            <CircleDashed className="h-3.5 w-3.5" />
            {pendingCount} pending
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-rose-50 px-3 py-1 text-xs font-bold text-rose-700 ring-1 ring-rose-300">
            <XCircle className="h-3.5 w-3.5" />
            {deductCount} to deduct
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-3 py-1 text-xs font-bold text-emerald-700 ring-1 ring-emerald-300">
            <CheckCircle2 className="h-3.5 w-3.5" />
            {exemptCount} exempt
          </div>
        </div>
      ) : null}

      <AdminTableShell
        description="Filter by any key field in the report before reviewing or exporting."
        title="Report Filters"
      >
        <div className="grid gap-3 p-4 md:grid-cols-4 xl:grid-cols-6">
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">From</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">To</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              type="date"
              value={dateTo}
              onChange={(event) => setDateTo(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Search</span>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                className="h-10 w-full rounded-lg border border-slate-200 bg-white pl-9 pr-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
                placeholder="HR_ID, name, device user, department"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">AC-No.</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={deviceUserId}
              onChange={(event) => setDeviceUserId(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Employee ID</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={employeeHrId}
              onChange={(event) => setEmployeeHrId(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Name</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={employeeName}
              onChange={(event) => setEmployeeName(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Job Title</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={jobTitle}
              onChange={(event) => setJobTitle(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Department</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Status</span>
            <select
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="Complete">Complete</option>
              <option value="Late">Late</option>
              <option value="Early leave">Early leave</option>
              <option value="Short day">Short day</option>
              <option value="Single punch">Single punch</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Deduction</span>
            <input
              className="h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-semibold text-slate-700 outline-none focus:border-orange-400 focus:ring-2 focus:ring-orange-100"
              placeholder="days, value, action"
              value={deduction}
              onChange={(event) => setDeduction(event.target.value)}
            />
          </label>
          <div className="flex items-end md:col-span-2 xl:col-span-1">
            <Button className="h-10 w-full" type="button" onClick={applyFilters}>
              Apply
            </Button>
          </div>
        </div>
      </AdminTableShell>

      <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        <Button type="button" variant={activeTab === "daily" ? "default" : "secondary"} onClick={() => setActiveTab("daily")}>
          Daily Report
        </Button>
        <Button type="button" variant={activeTab === "policies" ? "default" : "secondary"} onClick={() => setActiveTab("policies")}>
          Policy Details
        </Button>
      </div>

      {activeTab === "policies" ? (
        <AdminTableShell
          description="Schedule details resolved from employee HR_ID policy, then job title policy, then default policy."
          title="Employee Policy Details"
        >
          <div className="phoenix-horizontal-scroll overflow-x-auto">
            <table className="min-w-[1100px] border-separate border-spacing-0 text-left">
              <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
                <tr>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Employee ID</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Name</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Job Title</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Department</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Scheduled Start</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Scheduled End</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Daily Grace</th>
                  <th className="border-b border-r border-slate-200 px-4 py-3">Policy</th>
                  <th className="border-b border-slate-200 px-4 py-3">Effective</th>
                </tr>
              </thead>
              <tbody>
                {policyDetails.map((row) => (
                  <tr className="text-sm hover:bg-slate-50/60" key={row.employeeHrId}>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 font-semibold text-slate-800">{row.employeeHrId}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.employeeName}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.jobTitle || "-"}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.department || "-"}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.scheduledStart || "-"}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.scheduledEnd || "-"}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.graceMinutes || "-"}</td>
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700">{row.policyName}</td>
                    <td className="whitespace-nowrap border-b border-slate-100 px-4 py-3 text-slate-700">
                      {row.effectiveFrom || "-"}{row.effectiveTo ? ` to ${row.effectiveTo}` : ""}
                    </td>
                  </tr>
                ))}
                {policyDetails.length === 0 ? (
                  <tr>
                    <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={9}>
                      No employee policy details match this filter.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </AdminTableShell>
      ) : (
      <AdminTableShell
        description="Choose a From/To duration first. The first columns are frozen through Name. Click the Before Decision badge on any row to toggle it."
        title="Daily Report"
      >
        <div
          className="phoenix-horizontal-scroll overflow-x-auto border-b border-slate-100 bg-slate-50/60"
          ref={topScrollRef}
          onScroll={() => syncScroll("top")}
        >
          <div className="h-3 min-w-[2060px]" />
        </div>
        <div
          className="phoenix-horizontal-scroll max-h-[70vh] overflow-auto"
          ref={tableScrollRef}
          onScroll={() => syncScroll("table")}
        >
          <table className="min-w-[2060px] table-fixed border-separate border-spacing-0 text-left">
            <thead className="bg-slate-50 text-[11px] font-black uppercase tracking-[0.16em] text-slate-500">
              <tr>
                {visibleColumns.map((column) => (
                  <th className={`whitespace-nowrap border-b border-r border-slate-200 px-4 py-3 ${stickyClass(column, "head")}`} key={column.key}>{column.label}</th>
                ))}
                <th className="whitespace-nowrap border-b border-r border-slate-200 px-4 py-3">Before Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const decision = decisions.get(row.sortKey) ?? "pending";
                return (
                  <tr className={`group text-sm ${rowDecisionClass(decision)}`} key={row.sortKey}>
                    {visibleColumns.map((column) => (
                      <td className={`whitespace-nowrap border-b border-r border-slate-100 px-4 py-3 text-slate-700 ${stickyClass(column, "body")}`} key={`${row.sortKey}-${column.key}`}>
                        {column.key === "status" ? statusBadge(row.status) : row[column.key] || "-"}
                      </td>
                    ))}
                    <td className="whitespace-nowrap border-b border-r border-slate-100 px-4 py-3">
                      {row.status === "Complete" ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <DecisionToggle
                          state={decision}
                          onChange={(next) =>
                            setDecisions((prev) => {
                              const m = new Map(prev);
                              m.set(row.sortKey, next);
                              return m;
                            })
                          }
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr>
                  <td className="px-4 py-8 text-center text-sm text-slate-500" colSpan={Math.max(visibleColumns.length + 1, 1)}>
                    No attendance rows found for this filter.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </AdminTableShell>
      )}
    </div>
  );
}
