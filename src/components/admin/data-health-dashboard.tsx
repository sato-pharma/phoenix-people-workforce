"use client";

import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Database,
  Heart,
  Loader2,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";
import { useState } from "react";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DataHealthStats, SalaryFlag, SalaryFlagsResult } from "@/lib/admin/service";
import { formatCurrency } from "@/lib/sales/format";

const PAGE_SIZE = 25;

type DataHealthDashboardProps = {
  stats: DataHealthStats;
  salaryFlags: SalaryFlagsResult | null;
};

type SummaryCardProps = {
  color: "blue" | "green" | "orange" | "rose";
  icon: typeof Users;
  title: string;
  value: number | string;
};

function Pagination({
  from,
  onPage,
  page,
  pageCount,
  to,
  total,
}: {
  from: number;
  onPage: (p: number) => void;
  page: number;
  pageCount: number;
  to: number;
  total: number;
}) {
  if (pageCount <= 1) return null;
  return (
    <div className="flex items-center justify-between border-t border-slate-200/80 bg-gradient-to-b from-slate-50/95 to-white px-5 py-3.5 backdrop-blur-sm">
      <span className="text-xs font-semibold text-slate-500">
        {from}-{to} of {total}
      </span>
      <div className="flex items-center gap-1.5">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-500 shadow-sm transition-all duration-200 hover:border-orange-400 hover:bg-orange-50 hover:text-orange-600 hover:shadow-md disabled:opacity-40 disabled:hover:border-slate-300 disabled:hover:bg-white disabled:hover:text-slate-500 disabled:hover:shadow-sm"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
          type="button"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <span className="px-3 text-xs font-bold text-slate-700">
          {page} / {pageCount}
        </span>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-300 bg-white text-slate-500 shadow-sm transition-all duration-200 hover:border-orange-400 hover:bg-orange-50 hover:text-orange-600 hover:shadow-md disabled:opacity-40 disabled:hover:border-slate-300 disabled:hover:bg-white disabled:hover:text-slate-500 disabled:hover:shadow-sm"
          disabled={page === pageCount}
          onClick={() => onPage(page + 1)}
          type="button"
        >
          <ChevronRight className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function formatDate(iso: string) {
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export function DataHealthDashboard({ salaryFlags: initialSalaryFlags, stats }: DataHealthDashboardProps) {
  const [employeePage, setEmployeePage] = useState(1);
  const [salesPage, setSalesPage] = useState(1);
  const [orphanPage, setOrphanPage] = useState(1);

  const [salaryFlagsData, setSalaryFlagsData] = useState<SalaryFlagsResult | null>(initialSalaryFlags);
  const [showResolved, setShowResolved] = useState(false);
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Paginated slices
  const employeeIssues = stats.employeeIssues.filter((e) => e.health_status !== "ok");
  const empPageCount = Math.max(1, Math.ceil(employeeIssues.length / PAGE_SIZE));
  const empVisible = employeeIssues.slice((employeePage - 1) * PAGE_SIZE, employeePage * PAGE_SIZE);

  const salesPageCount = Math.max(1, Math.ceil(stats.salesIssues.length / PAGE_SIZE));
  const salesVisible = stats.salesIssues.slice((salesPage - 1) * PAGE_SIZE, salesPage * PAGE_SIZE);

  const orphanPageCount = Math.max(1, Math.ceil(stats.orphanAudit.length / PAGE_SIZE));
  const orphanVisible = stats.orphanAudit.slice((orphanPage - 1) * PAGE_SIZE, orphanPage * PAGE_SIZE);

  async function handleResolveFlag(id: string) {
    setResolvingId(id);
    try {
      const res = await fetch("/api/admin/salary-flags", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error("Failed to resolve flag");
      const updated = await res.json() as SalaryFlagsResult;
      setSalaryFlagsData(updated);
    } catch (err) {
      console.error(err);
    } finally {
      setResolvingId(null);
    }
  }

  async function handleToggleResolved(val: boolean) {
    setShowResolved(val);
    try {
      const res = await fetch(`/api/admin/salary-flags?showResolved=${val}`);
      if (!res.ok) throw new Error("Failed to fetch flags");
      const updated = await res.json() as SalaryFlagsResult;
      setSalaryFlagsData(updated);
    } catch (err) {
      console.error(err);
    }
  }

  const flags: SalaryFlag[] = salaryFlagsData?.flags ?? [];
  const unresolvedCount = salaryFlagsData?.unresolvedCount ?? 0;
  const tableCardClass = "overflow-hidden rounded-2xl border border-slate-200/90 bg-white/95 shadow-[0_20px_48px_rgba(15,23,42,0.10)]";
  const tableHeadClass = "border-b border-slate-200/80 bg-gradient-to-b from-slate-50 to-white";
  const tableBodyClass = "divide-y divide-slate-100/80";
  const tableRowClass = "transition-all duration-200 hover:bg-orange-50/40";
  const sectionHeaderClass = "flex items-center justify-between border-b border-slate-200/80 bg-gradient-to-b from-white to-slate-50/50 px-6 py-5";

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-slate-200/90 bg-[radial-gradient(ellipse_at_top_left,rgba(249,115,22,0.08),transparent_45%),radial-gradient(ellipse_at_bottom_right,rgba(251,146,60,0.05),transparent_40%),radial-gradient(ellipse_at_center,rgba(148,163,184,0.02),transparent_35%),linear-gradient(180deg,#F8FAFC_0%,#F1F5F9_45%,#E8EEF5_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),0_0_120px_rgba(249,115,22,0.03)] sm:p-6 xl:p-8">
      <div className="space-y-10">
      {/* Header & Summary */}
      <div className="space-y-6">
        <div className="relative overflow-hidden rounded-3xl border border-slate-200/90 bg-white/95 p-8 shadow-[0_25px_70px_rgba(15,23,42,0.12),0_0_0_1px_rgba(255,255,255,0.8)_inset]">
          {/* Premium multi-layered glow blobs */}
          <div className="pointer-events-none absolute -right-20 -top-20 h-72 w-72 rounded-full bg-[#F97316]/12 blur-[100px]" />
          <div className="pointer-events-none absolute -bottom-16 left-32 h-56 w-56 rounded-full bg-[#F59E0B]/10 blur-[80px]" />
          <div className="pointer-events-none absolute right-1/4 top-1/3 h-40 w-40 rounded-full bg-[#FB923C]/8 blur-[70px]" />
          {/* Subtle grid pattern overlay */}
          <div className="pointer-events-none absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAiIGhlaWdodD0iNDAiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyI+PGRlZnM+PHBhdHRlcm4gaWQ9ImdyaWQiIHdpZHRoPSI0MCIgaGVpZ2h0PSI0MCIgcGF0dGVyblVuaXRzPSJ1c2VyU3BhY2VPblVzZSI+PHBhdGggZD0iTTAgNDBMMDQwIDBIMCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMDMpIiBzdHJva2Utd2lkdGg9IjEiLz48L3BhdHRlcm4+PC9kZWZzPjxyZWN0IHdpZHRoPSIxMDAlIiBoZWlnaHQ9IjEwMCUiIGZpbGw9InVybCgjZ3JpZCkiLz48L3N2Zz4=')] opacity-30" />
          {/* Subtle noise texture overlay */}
          <div className="pointer-events-none absolute inset-0 opacity-[0.02] bg-[url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyMDAiIGhlaWdodD0iMjAwIj48ZmlsdGVyIGlkPSJub2lzZSI+PGZlVHVyYnVsZW5jZSB0eXBlPSJmcmFjdGFsTm9pc2UiIGJhc2VGcmVxdWVuY3k9IjAuNjUiIG51bU9jdGF2ZXM9IjMiIHN0aXRjaFRpbGVzPSJzdGl0Y2giLz48L2ZpbHRlcj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWx0ZXI9InVybCgjbm9pc2UpIiBvcGFjaXR5PSIxIi8+PC9zdmc+')] mix-blend-overlay" />
          <div className="relative flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-4 inline-flex items-center gap-2.5 rounded-full border border-orange-500/25 bg-orange-500/8 px-4 py-1.5 backdrop-blur-sm">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-400 shadow-[0_0_8px_rgba(251,146,60,0.6)]" />
                <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-orange-200">Governance cockpit</span>
              </div>
              <div className="flex items-center gap-4">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-[#0B0B0B] to-[#1a1a1a] text-orange-400 shadow-[0_16px_36px_rgba(15,23,42,0.25)]">
                  <ShieldCheck className="h-6 w-6" />
                </div>
                <div>
                  <h1 className="text-4xl font-black tracking-tight text-slate-950 sm:text-5xl">Data Health Governance</h1>
                  <p className="mt-2 text-sm leading-relaxed text-slate-500">
                    Audit HR links, salary flags, sales records, and orphan IDs from one control surface.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white to-slate-50 px-5 py-4 shadow-[0_12px_28px_rgba(15,23,42,0.08)]">
              <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-slate-400">Current health</p>
              <p className="mt-1.5 text-3xl font-black text-slate-950">{stats.summary.healthRate.toFixed(1)}%</p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard color="blue" icon={Users} title="Total Employee Nodes" value={stats.summary.totalEmployees} />
          <SummaryCard color="green" icon={Users} title="Active Employees" value={stats.summary.activeEmployees} />
          <SummaryCard color="green" icon={Heart} title="Healthy Records" value={stats.summary.healthyEmployees} />
          <SummaryCard
            color={stats.summary.issuesCount > 0 ? "rose" : "green"}
            icon={AlertCircle}
            title="Data Issues"
            value={stats.summary.issuesCount}
          />
          <SummaryCard
            color={stats.summary.healthRate > 95 ? "green" : stats.summary.healthRate > 80 ? "orange" : "rose"}
            icon={TrendingUp}
            title="Health Rate"
            value={`${stats.summary.healthRate.toFixed(1)}%`}
          />
        </div>
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-5">
          <SummaryCard color={stats.summary.activeEmployeesMissingAuthAccess > 0 ? "rose" : "green"} icon={ShieldCheck} title="Active Missing Auth/Access" value={stats.summary.activeEmployeesMissingAuthAccess} />
          <SummaryCard color="orange" icon={Database} title="Non-login Nodes" value={stats.summary.nonLoginAggregationNodes} />
          <SummaryCard color="blue" icon={Database} title="Historical Records" value={stats.summary.historicalRecords} />
          <SummaryCard color="orange" icon={Users} title="Vacancy Nodes" value={stats.summary.vacancyNodes} />
          <SummaryCard color={stats.summary.unresolvedSalesExceptions > 0 ? "rose" : "green"} icon={Activity} title="Unresolved Sales" value={stats.summary.unresolvedSalesExceptions} />
          <SummaryCard color="green" icon={Activity} title="Assigned Sales" value={`${stats.salesClassification.assigned_employee_sales.records} / ${formatCurrency(stats.salesClassification.assigned_employee_sales.salesValue)}`} />
          <SummaryCard color="orange" icon={Activity} title="Non-Assignable Sales" value={`${stats.salesClassification.non_assignable_territory_sales.records} / ${formatCurrency(stats.salesClassification.non_assignable_territory_sales.salesValue)}`} />
          <SummaryCard color="orange" icon={Activity} title="Vacant Territory Sales" value={`${stats.salesClassification.vacant_territory_sales.records} / ${formatCurrency(stats.salesClassification.vacant_territory_sales.salesValue)}`} />
          <SummaryCard color="blue" icon={Activity} title="Line-Level Sales" value={`${stats.salesClassification.line_level_sales.records} / ${formatCurrency(stats.salesClassification.line_level_sales.salesValue)}`} />
          <SummaryCard color="blue" icon={Activity} title="Others/Unassigned Sales" value={`${stats.salesClassification.others_unassigned_sales.records} / ${formatCurrency(stats.salesClassification.others_unassigned_sales.salesValue)}`} />
        </div>
      </div>

      {/* Salary Flags Panel */}
      <Card className={tableCardClass}>
        <div className={sectionHeaderClass}>
          <div className="flex items-center gap-2.5">
            <AlertCircle className={cn("h-5 w-5", unresolvedCount > 0 ? "text-rose-500" : "text-emerald-500")} />
            <h3 className="text-sm font-bold text-slate-900">Salary Flags</h3>
            {unresolvedCount > 0 && (
              <span className="rounded-full bg-gradient-to-r from-rose-50 to-rose-100 px-2.5 py-1 text-[10px] font-bold text-rose-700 ring-1 ring-rose-200">
                {unresolvedCount} unresolved
              </span>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-2.5 rounded-full border border-slate-200/80 bg-slate-50/95 px-4 py-2 text-xs font-semibold text-slate-600 transition hover:bg-slate-100">
            <input
              checked={showResolved}
              className="h-3.5 w-3.5 accent-orange-500"
              onChange={(e) => handleToggleResolved(e.target.checked)}
              type="checkbox"
            />
            Show resolved
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["HR_ID", "Flag Type", "Severity", "Message", "Created At", "Action"].map((h) => (
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {flags.length === 0 ? (
                <tr>
                    <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={6}>
                    {unresolvedCount === 0 ? "All salary flags have been resolved." : "No flags to display."}
                  </td>
                </tr>
              ) : (
                flags.map((flag) => (
                  <tr className={tableRowClass} key={flag.id}>
                    <td className="px-6 py-4 font-mono text-sm font-bold text-slate-600">{flag.hrId ?? "-"}</td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-700">
                      <span className="rounded-full bg-gradient-to-r from-orange-50 to-orange-100 px-3 py-1 text-[11px] font-bold text-orange-700 ring-1 ring-orange-200">
                        {flag.flagType?.replace(/_/g, " ") ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-slate-500">
                      <span className={`font-semibold ${flag.severity === "high" ? "text-rose-600" : flag.severity === "medium" ? "text-amber-600" : "text-slate-500"}`}>
                        {flag.severity ?? "-"}
                      </span>
                    </td>
                    <td className="max-w-lg px-6 py-4 text-xs font-medium text-slate-500">
                      <span className="line-clamp-1">{flag.message ?? "-"}</span>
                    </td>
                    <td className="px-6 py-4 text-xs font-semibold text-slate-500">{formatDate(flag.createdAt)}</td>
                    <td className="px-6 py-4">
                      {flag.resolvedAt ? (
                        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-emerald-600">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Resolved
                        </span>
                      ) : (
                        <button
                          className="flex h-9 items-center gap-1.5 rounded-lg border border-emerald-200/80 bg-gradient-to-r from-emerald-50 to-emerald-100 px-3.5 text-[11px] font-bold text-emerald-700 transition-all duration-200 hover:border-emerald-300 hover:from-emerald-100 hover:to-emerald-200 hover:shadow-md disabled:opacity-50"
                          disabled={resolvingId === flag.id}
                          onClick={() => handleResolveFlag(flag.id)}
                          type="button"
                        >
                          {resolvingId === flag.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3.5 w-3.5" />
                          )}
                          Resolve
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Employee Linkage Audit */}
      <Card className={tableCardClass}>
        <div className={sectionHeaderClass}>
          <div className="flex items-center gap-2.5">
            <Users className="h-5 w-5 text-orange-500" />
            <h3 className="text-sm font-bold text-slate-900">Employee Linkage Audit</h3>
          </div>
          <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">
            Source: employee_linkage_health
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["HR_ID", "Employee Name", "Node Type", "Auth", "Manager HR_ID", "Status"].map((h) => (
                  <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {empVisible.map((issue, i) => (
                <tr className={tableRowClass} key={i}>
                  <td className="px-6 py-4 font-mono text-sm font-bold text-slate-600">{issue.hr_id}</td>
                  <td className="px-6 py-4 text-sm font-bold text-slate-900">
                    <div>{issue.full_name}</div>
                    <div className="mt-1 text-xs font-medium text-slate-400">{issue.job_title || issue.reason}</div>
                  </td>
                  <td className="px-6 py-4">
                    <StatusBadge status={issue.node_type} />
                  </td>
                  <td className="px-6 py-4 text-xs font-semibold text-slate-500">
                    <div>Auth: {issue.has_auth_user ? "yes" : "no"}</div>
                    <div>Access: {issue.has_access_profile ? "yes" : "no"}</div>
                  </td>
                  <td className="px-6 py-4 font-mono text-sm text-slate-400">{issue.manager_hr_id ?? "-"}</td>
                  <td className="px-6 py-4">
                    <StatusBadge status={issue.health_status} />
                  </td>
                </tr>
              ))}
              {empVisible.length === 0 && (
                <tr>
                    <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={6}>
                    No employee linkage issues detected.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <Pagination
          from={employeeIssues.length === 0 ? 0 : (employeePage - 1) * PAGE_SIZE + 1}
          onPage={setEmployeePage}
          page={employeePage}
          pageCount={empPageCount}
          to={Math.min(employeePage * PAGE_SIZE, employeeIssues.length)}
          total={employeeIssues.length}
        />
      </Card>

      <div className="grid grid-cols-1 gap-8 lg:grid-cols-2">
        {/* Sales Linkage */}
        <Card className={tableCardClass}>
          <div className={sectionHeaderClass}>
            <div className="flex items-center gap-2.5">
              <Activity className="h-5 w-5 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Sales Record Linkage</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className={tableHeadClass}>
                  {["Row", "Owner", "Line / Territory", "Product", "Sales", "Status"].map((h) => (
                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={tableBodyClass}>
                {salesVisible.map((issue, i) => (
                  <tr className={tableRowClass} key={i}>
                    <td className="px-6 py-4 font-mono text-xs font-bold text-slate-500">
                      {issue.batch_id ? `${issue.batch_id.slice(0, 8)}...` : "-"} / {issue.row_number ?? "-"}
                    </td>
                    <td className="px-6 py-4 text-xs font-semibold text-slate-500">
                      <div>Employee: <span className="font-mono">{issue.employee_hr_id ?? "-"}</span></div>
                      <div>Manager: <span className="font-mono">{issue.manager_hr_id ?? "-"}</span></div>
                    </td>
                    <td className="px-6 py-4 text-xs font-semibold text-slate-500">
                      <div>{issue.line ?? "-"}</div>
                      <div className="text-slate-400">{issue.territory ?? "-"}</div>
                    </td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-500">{issue.product}</td>
                    <td className="px-6 py-4 text-sm font-bold text-slate-700">{formatCurrency(issue.sales_value)}</td>
                    <td className="px-6 py-4">
                      <StatusBadge status={issue.linkage_health_status} />
                      <p className="mt-1 max-w-xs text-xs font-medium text-slate-400">{issue.reason}</p>
                    </td>
                  </tr>
                ))}
                {salesVisible.length === 0 && (
                  <tr>
                    <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={6}>
                      No sales linkage issues detected.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            from={stats.salesIssues.length === 0 ? 0 : (salesPage - 1) * PAGE_SIZE + 1}
            onPage={setSalesPage}
            page={salesPage}
            pageCount={salesPageCount}
            to={Math.min(salesPage * PAGE_SIZE, stats.salesIssues.length)}
            total={stats.salesIssues.length}
          />
        </Card>

        {/* Orphan HR_ID Audit */}
        <Card className={tableCardClass}>
          <div className={sectionHeaderClass}>
            <div className="flex items-center gap-2.5">
              <Database className="h-5 w-5 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Orphan HR_ID Audit</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className={tableHeadClass}>
                  {["Source", "HR_ID", "Count", "Sample Name"].map((h) => (
                    <th className="px-6 py-4 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={tableBodyClass}>
                {orphanVisible.map((orphan, i) => (
                  <tr className={tableRowClass} key={i}>
                    <td className="px-6 py-4 text-[11px] font-bold uppercase tracking-tighter text-slate-400">
                      {orphan.source}
                    </td>
                    <td className="px-6 py-4 font-mono text-sm font-bold text-rose-500">{orphan.hr_id}</td>
                    <td className="px-6 py-4 text-sm font-bold text-slate-900">{orphan.rows_count}</td>
                    <td className="px-6 py-4 text-sm font-medium text-slate-500">{orphan.sample_name ?? "-"}</td>
                  </tr>
                ))}
                {orphanVisible.length === 0 && (
                  <tr>
                    <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={4}>
                      No orphan HR_IDs found in the system.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <Pagination
            from={stats.orphanAudit.length === 0 ? 0 : (orphanPage - 1) * PAGE_SIZE + 1}
            onPage={setOrphanPage}
            page={orphanPage}
            pageCount={orphanPageCount}
            to={Math.min(orphanPage * PAGE_SIZE, stats.orphanAudit.length)}
            total={stats.orphanAudit.length}
          />
        </Card>
      </div>
      </div>
    </div>
  );
}

function SummaryCard({ color, icon: Icon, title, value }: SummaryCardProps) {
  const colorMap: Record<SummaryCardProps["color"], string> = {
    blue: "bg-gradient-to-br from-blue-50 to-blue-100 text-blue-600 ring-blue-200 shadow-[0_8px_20px_rgba(59,130,246,0.15)]",
    green: "bg-gradient-to-br from-emerald-50 to-emerald-100 text-emerald-600 ring-emerald-200 shadow-[0_8px_20px_rgba(16,185,129,0.15)]",
    orange: "bg-gradient-to-br from-orange-50 to-orange-100 text-orange-600 ring-orange-200 shadow-[0_8px_20px_rgba(249,115,22,0.15)]",
    rose: "bg-gradient-to-br from-rose-50 to-rose-100 text-rose-600 ring-rose-200 shadow-[0_8px_20px_rgba(244,63,94,0.15)]",
  };

  return (
    <Card className="relative overflow-hidden rounded-[24px] border border-slate-200/90 bg-white/95 p-6 shadow-[0_16px_40px_rgba(15,23,42,0.06)] transition-all duration-300 ease-out hover:-translate-y-1 hover:border-orange-300/80 hover:bg-white hover:shadow-[0_24px_52px_rgba(15,23,42,0.14)] hover:scale-[1.02]">
      <div className="pointer-events-none absolute -right-8 -top-10 h-32 w-32 rounded-full bg-orange-200/15 blur-3xl" />
      <div className="mb-4 flex items-center justify-between">
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-2xl ring-1 transition-all duration-300 hover:scale-110", colorMap[color])}>
          <Icon className="h-6 w-6" />
        </div>
      </div>
      <p className="mb-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-slate-400">{title}</p>
      <p className="break-words text-2xl font-black tracking-tight text-slate-900 sm:text-3xl">{value}</p>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isOk = ["ok", "active_employee", "assigned_employee_sales"].includes(status);
  const isWarning = [
    "missing_manager",
    "missing_line",
    "missing_area",
    "historical_record",
    "vacancy_node",
    "system_placeholder",
    "others_unassigned_node",
    "non_login_aggregation_node",
    "non_assignable_territory_sales",
    "vacant_territory_sales",
    "line_level_sales",
    "others_unassigned_sales",
  ].includes(status);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-wider ring-1 transition-all duration-200",
        isOk ? "bg-gradient-to-r from-emerald-50 to-emerald-100 text-emerald-700 ring-emerald-200" : isWarning ? "bg-gradient-to-r from-orange-50 to-orange-100 text-orange-700 ring-orange-200" : "bg-gradient-to-r from-rose-50 to-rose-100 text-rose-700 ring-rose-200",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
