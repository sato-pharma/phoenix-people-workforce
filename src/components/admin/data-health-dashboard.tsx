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
    <div className="flex items-center justify-between border-t border-[#E2E8F0] bg-[#F8FAFC]/80 px-4 py-3">
      <span className="text-xs font-semibold text-slate-500">
        {from}-{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#CBD5E1] bg-white text-slate-500 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"
          disabled={page === 1}
          onClick={() => onPage(page - 1)}
          type="button"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        <span className="px-2 text-xs font-semibold text-slate-600">
          {page} / {pageCount}
        </span>
        <button
          className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#CBD5E1] bg-white text-slate-500 shadow-sm transition hover:border-orange-300 hover:bg-orange-50 hover:text-orange-600 disabled:opacity-40"
          disabled={page === pageCount}
          onClick={() => onPage(page + 1)}
          type="button"
        >
          <ChevronRight className="h-3.5 w-3.5" />
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
  const tableCardClass = "overflow-hidden border-[#D8E0EA] bg-white/95 shadow-[0_18px_42px_rgba(15,23,42,0.08)]";
  const tableHeadClass = "border-b border-[#E2E8F0] bg-[#F8FAFC]";
  const tableBodyClass = "divide-y divide-slate-100";
  const tableRowClass = "transition-colors hover:bg-orange-50/35";
  const sectionHeaderClass = "flex items-center justify-between border-b border-[#E2E8F0] bg-white/90 px-6 py-5";

  return (
    <div className="min-h-[calc(100vh-7rem)] rounded-[32px] border border-[#E2E8F0] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.12),transparent_30%),linear-gradient(180deg,#F8FAFC_0%,#EEF3F8_100%)] p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)] sm:p-6 xl:p-8">
      <div className="space-y-7">
      {/* Header & Summary */}
      <div className="space-y-5">
        <div className="relative overflow-hidden rounded-3xl border border-[#D8E0EA] bg-white/95 p-7 shadow-[0_20px_54px_rgba(15,23,42,0.09)]">
          <div className="pointer-events-none absolute -right-16 -top-16 h-48 w-48 rounded-full bg-orange-200/35 blur-3xl" />
          <div className="pointer-events-none absolute bottom-0 left-12 h-28 w-28 rounded-full bg-slate-200/45 blur-2xl" />
          <div className="relative flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-200 bg-orange-50 px-3 py-1">
                <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                <span className="text-[11px] font-black uppercase tracking-[0.18em] text-orange-600">Governance cockpit</span>
              </div>
              <div className="flex items-center gap-3">
                <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-[#0B0B0B] text-orange-400 shadow-[0_14px_30px_rgba(15,23,42,0.22)]">
                  <ShieldCheck className="h-5 w-5" />
                </div>
                <div>
                  <h1 className="text-3xl font-black tracking-tight text-slate-950">Data Health Governance</h1>
                  <p className="mt-1 text-sm text-slate-500">
                    Audit HR links, salary flags, sales records, and orphan IDs from one control surface.
                  </p>
                </div>
              </div>
            </div>
            <div className="rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC] px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.9)]">
              <p className="text-[10px] font-black uppercase tracking-[0.18em] text-slate-400">Current health</p>
              <p className="mt-1 text-2xl font-black text-slate-950">{stats.summary.healthRate.toFixed(1)}%</p>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SummaryCard color="blue" icon={Users} title="Total Employees" value={stats.summary.totalEmployees} />
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
      </div>

      {/* Salary Flags Panel */}
      <Card className={tableCardClass}>
        <div className={sectionHeaderClass}>
          <div className="flex items-center gap-2">
            <AlertCircle className={cn("h-4 w-4", unresolvedCount > 0 ? "text-rose-500" : "text-emerald-500")} />
            <h3 className="text-sm font-bold text-slate-900">Salary Flags</h3>
            {unresolvedCount > 0 && (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-black text-rose-600 ring-1 ring-rose-100">
                {unresolvedCount} unresolved
              </span>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-2 rounded-full border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-1.5 text-xs font-semibold text-slate-600">
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
                  <th className="px-5 py-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
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
                    <td className="px-5 py-4 font-mono text-sm font-bold text-slate-600">{flag.hrId ?? "-"}</td>
                    <td className="px-5 py-4 text-sm font-medium text-slate-700">
                      <span className="rounded-full bg-orange-50 px-2.5 py-1 text-[11px] font-bold text-orange-600 ring-1 ring-orange-100">
                        {flag.flagType?.replace(/_/g, " ") ?? "unknown"}
                      </span>
                    </td>
                    <td className="px-5 py-4 text-sm text-slate-500">
                      <span className={`font-semibold ${flag.severity === "high" ? "text-rose-600" : flag.severity === "medium" ? "text-amber-600" : "text-slate-500"}`}>
                        {flag.severity ?? "-"}
                      </span>
                    </td>
                    <td className="max-w-lg px-5 py-4 text-xs font-medium text-slate-500">
                      <span className="line-clamp-1">{flag.message ?? "-"}</span>
                    </td>
                    <td className="px-5 py-4 text-xs font-semibold text-slate-500">{formatDate(flag.createdAt)}</td>
                    <td className="px-5 py-4">
                      {flag.resolvedAt ? (
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-500">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Resolved
                        </span>
                      ) : (
                        <button
                          className="flex h-8 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 text-[11px] font-black text-emerald-700 transition hover:bg-emerald-100 disabled:opacity-50"
                          disabled={resolvingId === flag.id}
                          onClick={() => handleResolveFlag(flag.id)}
                          type="button"
                        >
                          {resolvingId === flag.id ? (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="h-3 w-3" />
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
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-orange-500" />
            <h3 className="text-sm font-bold text-slate-900">Employee Linkage Audit</h3>
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            Source: employee_linkage_health
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className={tableHeadClass}>
                {["HR_ID", "Employee Name", "Job Title", "Manager HR_ID", "Status"].map((h) => (
                  <th className="px-5 py-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={tableBodyClass}>
              {empVisible.map((issue, i) => (
                <tr className={tableRowClass} key={i}>
                  <td className="px-5 py-4 font-mono text-sm font-bold text-slate-600">{issue.hr_id}</td>
                  <td className="px-5 py-4 text-sm font-bold text-slate-900">{issue.full_name}</td>
                  <td className="px-5 py-4 text-sm font-medium text-slate-500">{issue.job_title}</td>
                  <td className="px-5 py-4 font-mono text-sm text-slate-400">{issue.manager_hr_id ?? "-"}</td>
                  <td className="px-5 py-4">
                    <StatusBadge status={issue.health_status} />
                  </td>
                </tr>
              ))}
              {empVisible.length === 0 && (
                <tr>
                    <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={5}>
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
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Sales Record Linkage</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className={tableHeadClass}>
                  {["Employee HR_ID", "Product", "Status"].map((h) => (
                    <th className="px-5 py-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={tableBodyClass}>
                {salesVisible.map((issue, i) => (
                  <tr className={tableRowClass} key={i}>
                    <td className="px-5 py-4 font-mono text-sm font-bold text-slate-600">{issue.employee_hr_id}</td>
                    <td className="px-5 py-4 text-sm font-medium text-slate-500">{issue.product}</td>
                    <td className="px-5 py-4">
                      <StatusBadge status={issue.linkage_health_status} />
                    </td>
                  </tr>
                ))}
                {salesVisible.length === 0 && (
                  <tr>
                    <td className="p-8 text-center text-sm font-medium text-slate-400" colSpan={3}>
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
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Orphan HR_ID Audit</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className={tableHeadClass}>
                  {["Source", "HR_ID", "Count", "Sample Name"].map((h) => (
                    <th className="px-5 py-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className={tableBodyClass}>
                {orphanVisible.map((orphan, i) => (
                  <tr className={tableRowClass} key={i}>
                    <td className="px-5 py-4 text-[11px] font-bold uppercase tracking-tighter text-slate-400">
                      {orphan.source}
                    </td>
                    <td className="px-5 py-4 font-mono text-sm font-bold text-rose-500">{orphan.hr_id}</td>
                    <td className="px-5 py-4 text-sm font-bold text-slate-900">{orphan.rows_count}</td>
                    <td className="px-5 py-4 text-sm font-medium text-slate-500">{orphan.sample_name ?? "-"}</td>
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
    blue: "bg-blue-50 text-blue-500 ring-blue-100",
    green: "bg-emerald-50 text-emerald-500 ring-emerald-100",
    orange: "bg-orange-50 text-orange-500 ring-orange-100",
    rose: "bg-rose-50 text-rose-500 ring-rose-100",
  };

  return (
    <Card className="relative overflow-hidden border-[#E2E8F0] bg-white/95 p-6 shadow-[0_16px_36px_rgba(15,23,42,0.07)] transition-all hover:-translate-y-0.5 hover:border-[#FDBA74] hover:bg-white hover:shadow-[0_22px_48px_rgba(15,23,42,0.10)]">
      <div className="pointer-events-none absolute -right-8 -top-10 h-24 w-24 rounded-full bg-orange-200/20 blur-2xl" />
      <div className="mb-4 flex items-center justify-between">
        <div className={cn("flex h-11 w-11 items-center justify-center rounded-2xl ring-8", colorMap[color])}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <p className="mb-1 text-[10px] font-black uppercase tracking-[0.15em] text-slate-400">{title}</p>
      <p className="text-2xl font-black tracking-tight text-slate-900">{value}</p>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isOk = status === "ok";
  const isWarning = ["missing_manager", "missing_line", "missing_area"].includes(status);

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-3 py-1 text-[11px] font-black uppercase tracking-wider ring-1",
        isOk ? "bg-emerald-50 text-emerald-600 ring-emerald-100" : isWarning ? "bg-orange-50 text-orange-600 ring-orange-100" : "bg-rose-50 text-rose-600 ring-rose-100",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
