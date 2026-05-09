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
    <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
      <span className="text-xs text-slate-400">
        {from}–{to} of {total}
      </span>
      <div className="flex items-center gap-1">
        <button
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:bg-slate-50 disabled:opacity-40"
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
          className="flex h-7 w-7 items-center justify-center rounded-lg border border-slate-200 text-slate-400 hover:bg-slate-50 disabled:opacity-40"
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
  const [resolvingId, setResolvingId] = useState<number | null>(null);

  // Paginated slices
  const employeeIssues = stats.employeeIssues.filter((e) => e.health_status !== "ok");
  const empPageCount = Math.max(1, Math.ceil(employeeIssues.length / PAGE_SIZE));
  const empVisible = employeeIssues.slice((employeePage - 1) * PAGE_SIZE, employeePage * PAGE_SIZE);

  const salesPageCount = Math.max(1, Math.ceil(stats.salesIssues.length / PAGE_SIZE));
  const salesVisible = stats.salesIssues.slice((salesPage - 1) * PAGE_SIZE, salesPage * PAGE_SIZE);

  const orphanPageCount = Math.max(1, Math.ceil(stats.orphanAudit.length / PAGE_SIZE));
  const orphanVisible = stats.orphanAudit.slice((orphanPage - 1) * PAGE_SIZE, orphanPage * PAGE_SIZE);

  async function handleResolveFlag(id: number) {
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

  return (
    <div className="mx-auto max-w-[1600px] min-h-screen space-y-8 bg-slate-50/50 p-6 lg:p-8">
      {/* Header & Summary */}
      <div>
        <div className="mb-6 flex items-center gap-3">
          <ShieldCheck className="h-8 w-8 text-orange-500" />
          <h1 className="text-2xl font-black tracking-tight text-slate-900">Data Health Governance</h1>
        </div>
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
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
      <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 p-5">
          <div className="flex items-center gap-2">
            <AlertCircle className={cn("h-4 w-4", unresolvedCount > 0 ? "text-rose-500" : "text-emerald-500")} />
            <h3 className="text-sm font-bold text-slate-900">Salary Flags</h3>
            {unresolvedCount > 0 && (
              <span className="rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-black text-rose-600">
                {unresolvedCount} unresolved
              </span>
            )}
          </div>
          <label className="flex cursor-pointer items-center gap-2 text-xs text-slate-500">
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
              <tr className="border-b border-slate-100 bg-slate-50/50">
                {["HR_ID", "Flag Type", "Flag Value", "Created At", "Resolved By", "Action"].map((h) => (
                  <th className="p-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {flags.length === 0 ? (
                <tr>
                  <td className="p-8 text-center font-medium text-slate-400" colSpan={6}>
                    {unresolvedCount === 0 ? "All salary flags have been resolved. 🎉" : "No flags to display."}
                  </td>
                </tr>
              ) : (
                flags.map((flag) => (
                  <tr className="group transition-colors hover:bg-slate-50/50" key={flag.id}>
                    <td className="p-4 font-mono text-xs font-bold text-slate-500">{flag.hrId ?? "—"}</td>
                    <td className="p-4 text-xs font-medium text-slate-700">
                      <span className="rounded-full bg-orange-50 px-2 py-0.5 text-[10px] font-semibold text-orange-600">
                        {flag.flagType?.replace(/_/g, " ") ?? "unknown"}
                      </span>
                    </td>
                    <td className="max-w-xs p-4 font-mono text-[11px] text-slate-400">
                      <span className="line-clamp-1">{JSON.stringify(flag.flagValue)}</span>
                    </td>
                    <td className="p-4 text-xs text-slate-400">{formatDate(flag.createdAt)}</td>
                    <td className="p-4 text-xs text-slate-400">
                      {flag.resolvedAt ? (
                        <span className="text-emerald-600">
                          {flag.resolvedBy ?? "—"} · {formatDate(flag.resolvedAt)}
                        </span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="p-4">
                      {flag.resolvedAt ? (
                        <span className="flex items-center gap-1 text-[10px] font-semibold text-emerald-500">
                          <CheckCircle2 className="h-3.5 w-3.5" /> Resolved
                        </span>
                      ) : (
                        <button
                          className="flex h-7 items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 text-[10px] font-bold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"
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
      <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 bg-white p-5">
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
              <tr className="border-b border-slate-100 bg-slate-50/50">
                {["HR_ID", "Employee Name", "Job Title", "Manager HR_ID", "Status"].map((h) => (
                  <th className="p-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {empVisible.map((issue, i) => (
                <tr className="group transition-colors hover:bg-slate-50/50" key={i}>
                  <td className="p-4 font-mono text-xs font-bold text-slate-500">{issue.hr_id}</td>
                  <td className="p-4 text-xs font-bold text-slate-900">{issue.full_name}</td>
                  <td className="p-4 text-xs font-medium text-slate-500">{issue.job_title}</td>
                  <td className="p-4 font-mono text-xs text-slate-400">{issue.manager_hr_id ?? "—"}</td>
                  <td className="p-4">
                    <StatusBadge status={issue.health_status} />
                  </td>
                </tr>
              ))}
              {empVisible.length === 0 && (
                <tr>
                  <td className="p-8 text-center font-medium text-slate-400" colSpan={5}>
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
        <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 p-5">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Sales Record Linkage</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  {["Employee HR_ID", "Product", "Status"].map((h) => (
                    <th className="p-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {salesVisible.map((issue, i) => (
                  <tr className="transition-colors hover:bg-slate-50/50" key={i}>
                    <td className="p-4 font-mono text-xs font-bold text-slate-500">{issue.employee_hr_id}</td>
                    <td className="p-4 text-xs font-medium text-slate-500">{issue.product}</td>
                    <td className="p-4">
                      <StatusBadge status={issue.linkage_health_status} />
                    </td>
                  </tr>
                ))}
                {salesVisible.length === 0 && (
                  <tr>
                    <td className="p-8 text-center font-medium text-slate-400" colSpan={3}>
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
        <Card className="overflow-hidden border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-100 p-5">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Orphan HR_ID Audit</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/50">
                  {["Source", "HR_ID", "Count", "Sample Name"].map((h) => (
                    <th className="p-4 text-[10px] font-black uppercase tracking-widest text-slate-400" key={h}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {orphanVisible.map((orphan, i) => (
                  <tr className="transition-colors hover:bg-slate-50/50" key={i}>
                    <td className="p-4 text-[10px] font-bold uppercase tracking-tighter text-slate-400">
                      {orphan.source}
                    </td>
                    <td className="p-4 font-mono text-xs font-bold text-rose-500">{orphan.hr_id}</td>
                    <td className="p-4 text-xs font-bold text-slate-900">{orphan.rows_count}</td>
                    <td className="p-4 text-xs font-medium text-slate-500">{orphan.sample_name ?? "—"}</td>
                  </tr>
                ))}
                {orphanVisible.length === 0 && (
                  <tr>
                    <td className="p-8 text-center font-medium text-slate-400" colSpan={4}>
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
  );
}

function SummaryCard({ color, icon: Icon, title, value }: SummaryCardProps) {
  const colorMap: Record<SummaryCardProps["color"], string> = {
    blue: "bg-blue-50 text-blue-500",
    green: "bg-emerald-50 text-emerald-500",
    orange: "bg-orange-50 text-orange-500",
    rose: "bg-rose-50 text-rose-500",
  };

  return (
    <Card className="border-slate-200 bg-white p-6 shadow-sm transition-all hover:shadow-md">
      <div className="mb-4 flex items-center justify-between">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-xl", colorMap[color])}>
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
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-[10px] font-black uppercase tracking-wider",
        isOk ? "bg-emerald-50 text-emerald-600" : isWarning ? "bg-orange-50 text-orange-600" : "bg-rose-50 text-rose-600",
      )}
    >
      {status.replace(/_/g, " ")}
    </span>
  );
}
