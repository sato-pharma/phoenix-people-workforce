"use client";

import { useMemo, useState } from "react";
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
import { summarizeFingerprintDeductionQuantities } from "@/lib/attendance/metrics";
import {
  PortalDesktopTable,
  PortalEmptyState,
  PortalRecordCard,
  PortalRecordFields,
  PortalResponsiveDataList,
  PortalStackingCell,
  portalStackingBodyClassName,
  portalStackingHeadClassName,
  portalStackingRowClassName,
  portalStackingTableClassName,
} from "@/components/employee-portal/portal-primitives";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { phxFieldClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";


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
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-phx-xs font-bold tracking-wide transition-colors ${cfg.className}`}
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

export function FingerprintReport({ initialData, initialError }: Props) {
  const router = useRouter();
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

  const deductionQuantities = useMemo(
    () => summarizeFingerprintDeductionQuantities(initialData?.rows ?? []),
    [initialData?.rows],
  );
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
            <AdminInsightChip tone="orange">{deductionQuantities.deductionDays} deduction days</AdminInsightChip>
            <AdminInsightChip tone="orange">Qty {deductionQuantities.quantity}</AdminInsightChip>
          </>
        )}
        description="Live daily attendance built from raw fingerprint punches. Mark rows before sending to payroll — decisions are local until exported."
        eyebrow="Attendance"
        icon={<FileSpreadsheet className="h-3.5 w-3.5" />}
        title="Fingerprint Attendance Report"
        actions={(
          <a
            className={`inline-flex items-center justify-center gap-2 rounded-lg border border-white/20 bg-white/10 px-4 py-2 text-sm font-medium text-slate-100 backdrop-blur transition hover:border-phx-accent-line hover:bg-white/[0.16] hover:text-white ${!hasDateRange || rows.length === 0 ? "pointer-events-none opacity-50" : ""}`}
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
          <div className="flex items-center gap-1.5 rounded-full bg-phx-paper px-3 py-1 text-xs font-bold text-phx-ink-soft ring-1 ring-phx-line">
            <CircleDashed className="h-3.5 w-3.5" />
            {pendingCount} pending
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-phx-danger-bg px-3 py-1 text-xs font-bold text-phx-danger ring-1 ring-phx-danger-line">
            <XCircle className="h-3.5 w-3.5" />
            {deductCount} to deduct
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-phx-ok-bg px-3 py-1 text-xs font-bold text-phx-ok ring-1 ring-phx-ok-line">
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
              className={phxFieldClassName}
              type="date"
              value={dateFrom}
              onChange={(event) => setDateFrom(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">To</span>
            <input
              className={phxFieldClassName}
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
                className={cn(phxFieldClassName, "pl-9")}
                placeholder="HR_ID, name, device user, department"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">AC-No.</span>
            <input
              className={phxFieldClassName}
              value={deviceUserId}
              onChange={(event) => setDeviceUserId(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Employee ID</span>
            <input
              className={phxFieldClassName}
              value={employeeHrId}
              onChange={(event) => setEmployeeHrId(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Name</span>
            <input
              className={phxFieldClassName}
              value={employeeName}
              onChange={(event) => setEmployeeName(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Job Title</span>
            <input
              className={phxFieldClassName}
              value={jobTitle}
              onChange={(event) => setJobTitle(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Department</span>
            <input
              className={phxFieldClassName}
              value={department}
              onChange={(event) => setDepartment(event.target.value)}
            />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Status</span>
            <SearchableSelect
              className="w-full px-3"
              value={status}
              onChange={(event) => setStatus(event.target.value)}
            >
              <option value="">All statuses</option>
              <option value="Complete">Complete</option>
              <option value="Late">Late</option>
              <option value="Early leave">Early leave</option>
              <option value="Short day">Short day</option>
              <option value="Single punch">Single punch</option>
            </SearchableSelect>
          </label>
          <label className="space-y-1">
            <span className="text-xs font-black uppercase tracking-[0.16em] text-slate-500">Deduction</span>
            <input
              className={phxFieldClassName}
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
          {/* Cards below md, the ten-column table from md up — the owner's standing rule:
              "desktop shows full tables/dashboards, mobile never does". These rows are read-only,
              so PortalResponsiveDataList is the right half of the pair; the Daily Report below
              carries a decision per row and uses the stacking pattern instead, for the reason
              written on those constants.

              This page reached an HR rail on 2026-09-05, when the Attendance hub row was replaced
              by its cards and the Fingerprint Report became a row of its own. Before that the only
              HR row was the hub, tests/hr-shell-mobile-tables.test.ts never walked this far, and a
              1180px minimum sat one tap from a phone. */}
          <PortalResponsiveDataList
            empty={
              <PortalEmptyState
                message="No employee policy details match this filter."
                title="No policies to show"
              />
            }
            getKey={(row) => row.employeeHrId}
            items={policyDetails}
            renderCard={(row) => (
              <PortalRecordCard
                meta={
                  <span>{[row.jobTitle, row.department].filter(Boolean).join(" · ")}</span>
                }
                title={row.employeeName}
              >
                <PortalRecordFields
                  fields={[
                    { label: "Policy", value: row.policyName },
                    { label: "Schedule", value: row.scheduledStart || row.scheduledEnd ? `${row.scheduledStart || "—"} – ${row.scheduledEnd || "—"}` : "—" },
                    { label: "Daily Grace", value: row.graceMinutes || "—" },
                    { label: "Workdays", value: row.workingDays || "—" },
                    {
                      label: "Effective",
                      value: `${row.effectiveFrom || "—"}${row.effectiveTo ? ` to ${row.effectiveTo}` : ""}`,
                    },
                  ]}
                />
              </PortalRecordCard>
            )}
            renderTable={() => (
              <PortalDesktopTable
                cols={
                  <colgroup>
                    <col className="w-[26%]" />
                    <col className="w-[18%]" />
                    <col className="w-[14%]" />
                    <col className="w-[10%]" />
                    <col className="w-[14%]" />
                    <col className="w-[18%]" />
                  </colgroup>
                }
              >
                <thead className="bg-slate-50 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">
                  <tr>
                    <th className="border-b border-slate-200 px-3 py-3">Employee</th>
                    <th className="border-b border-slate-200 px-3 py-3">Policy</th>
                    <th className="border-b border-slate-200 px-3 py-3">Schedule</th>
                    <th className="border-b border-slate-200 px-3 py-3">Daily Grace</th>
                    <th className="border-b border-slate-200 px-3 py-3">Workdays</th>
                    <th className="border-b border-slate-200 px-3 py-3">Effective</th>
                  </tr>
                </thead>
                <tbody>
                  {policyDetails.map((row) => (
                    <tr className="text-sm hover:bg-slate-50/60" key={row.employeeHrId}>
                      <td className="break-words border-b border-slate-100 px-3 py-3 text-slate-700">
                        <span className="font-semibold text-slate-800">{row.employeeName}</span>
                        {row.jobTitle ? <div className="text-xs text-slate-500">{row.jobTitle}</div> : null}
                        {row.department ? <div className="text-xs text-slate-500">{row.department}</div> : null}
                      </td>
                      <td className="break-words border-b border-slate-100 px-3 py-3 text-slate-700">{row.policyName}</td>
                      <td className="break-words border-b border-slate-100 px-3 py-3 text-slate-700">
                        {row.scheduledStart || row.scheduledEnd ? `${row.scheduledStart || "—"} – ${row.scheduledEnd || "—"}` : "—"}
                      </td>
                      <td className="break-words border-b border-slate-100 px-3 py-3 text-slate-700">{row.graceMinutes || "—"}</td>
                      <td className="break-words border-b border-slate-100 px-3 py-3 text-slate-700">{row.workingDays || "—"}</td>
                      <td className="break-words border-b border-slate-100 px-3 py-3 text-slate-700">
                        {row.effectiveFrom || "—"}{row.effectiveTo ? ` to ${row.effectiveTo}` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </PortalDesktopTable>
            )}
          />
        </AdminTableShell>
      ) : (
      <AdminTableShell
        description="Choose a From/To duration first. Click the Before Decision badge on any row to toggle it."
        title="Daily Report"
      >
        <div className="max-h-[70vh] overflow-y-auto">
          {/* The STACKING pattern, not PortalResponsiveDataList, and the difference matters here.
              Every row carries a decision — deduct, exempt or pending — and the page says so in as
              many words: "decisions are local until exported". PortalResponsiveDataList renders
              each row twice, a card instance and a table instance, so a phone turned to landscape
              crosses md mid-review and swaps in the other instance. One table that stacks has
              neither problem. The twenty report columns are merged into ten cells that fit. */}
          <table className={`${portalStackingTableClassName} md:w-full md:table-fixed`}>
            <colgroup>
              <col className="w-[15%]" />
              <col className="w-[7%]" />
              <col className="w-[9%]" />
              <col className="w-[9%]" />
              <col className="w-[9%]" />
              <col className="w-[8%]" />
              <col className="w-[8%]" />
              <col className="w-[16%]" />
              <col className="w-[11%]" />
              <col className="w-[8%]" />
            </colgroup>
            <thead className={`${portalStackingHeadClassName} bg-slate-50 text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500`}>
              <tr>
                <th className="border-b border-slate-200 px-3 py-3">Employee</th>
                <th className="border-b border-slate-200 px-3 py-3">Date</th>
                <th className="border-b border-slate-200 px-3 py-3">Punches</th>
                <th className="border-b border-slate-200 px-3 py-3">Time</th>
                <th className="border-b border-slate-200 px-3 py-3">Late / Early</th>
                <th className="border-b border-slate-200 px-3 py-3">Status</th>
                <th className="border-b border-slate-200 px-3 py-3">Deduction</th>
                <th className="border-b border-slate-200 px-3 py-3">Evidence</th>
                <th className="border-b border-slate-200 px-3 py-3">Recommended Action</th>
                <th className="border-b border-slate-200 px-3 py-3">Before Decision</th>
              </tr>
            </thead>
            <tbody className={portalStackingBodyClassName}>
              {rows.map((row) => {
                const decision = decisions.get(row.sortKey) ?? "pending";
                const cell = "break-words text-slate-700 md:border-b md:border-slate-100";
                const evidence = (
                  [
                    ["approvedLeave", "Vacation/Leave"],
                    ["approvedExcuse", "Excuse"],
                    ["crmActivity", "CRM"],
                    ["weeklyPlan", "Plan"],
                  ] as const
                ).filter(([key]) => visibleColumns.some((column) => column.key === key) && String(row[key] ?? "").trim());
                return (
                  <tr
                    className={`${portalStackingRowClassName} group border-b border-slate-200 py-2 text-sm md:border-b-0 md:py-0 ${rowDecisionClass(decision)}`}
                    key={row.sortKey}
                  >
                    <PortalStackingCell className={cell} label="Employee">
                      <span className="font-semibold text-slate-800">{row.employeeName || "—"}</span>
                      {row.jobTitle ? <div className="text-xs text-slate-500">{row.jobTitle}</div> : null}
                      {row.department ? <div className="text-xs text-slate-500">{row.department}</div> : null}
                      {row.deviceUserId ? <div className="text-xs text-slate-400">AC-No. {row.deviceUserId}</div> : null}
                    </PortalStackingCell>
                    <PortalStackingCell className={cell} label="Date">{row.date || "—"}</PortalStackingCell>
                    <PortalStackingCell className={cell} label="Punches">
                      {row.actualFirstPunch || row.actualLastPunch ? `${row.actualFirstPunch || "—"} – ${row.actualLastPunch || "—"}` : "—"}
                    </PortalStackingCell>
                    <PortalStackingCell className={cell} label="Time">
                      <div>Long {row.timeLong || "—"}</div>
                      <div className="text-xs text-slate-500">Valid {row.validTime || "—"}</div>
                    </PortalStackingCell>
                    <PortalStackingCell className={cell} label="Late / Early">
                      <div>Late {row.lateMinutes || "—"}</div>
                      <div className="text-xs text-slate-500">Early {row.earlyLeaveMinutes || "—"}</div>
                    </PortalStackingCell>
                    <PortalStackingCell className={cell} label="Status">{statusBadge(row.status)}</PortalStackingCell>
                    <PortalStackingCell className={cell} label="Deduction">
                      <div>{row.deductionDays || "—"}</div>
                      <div className="text-xs text-slate-500">{row.deductionValue || "—"}</div>
                    </PortalStackingCell>
                    <PortalStackingCell className={cell} label="Evidence">
                      {evidence.length === 0 ? (
                        "—"
                      ) : (
                        evidence.map(([key, label]) => (
                          <div key={key}>
                            <span className="text-xs font-bold text-slate-500">{label}: </span>
                            {row[key]}
                          </div>
                        ))
                      )}
                    </PortalStackingCell>
                    <PortalStackingCell className={cell} label="Recommended Action">{row.recommendedAction || "—"}</PortalStackingCell>
                    <PortalStackingCell className="md:border-b md:border-slate-100" label="Before Decision">
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
                    </PortalStackingCell>
                  </tr>
                );
              })}
              {rows.length === 0 ? (
                <tr className={portalStackingRowClassName}>
                  <td className="block px-4 py-8 text-center text-sm text-slate-500 md:table-cell" colSpan={10}>
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
