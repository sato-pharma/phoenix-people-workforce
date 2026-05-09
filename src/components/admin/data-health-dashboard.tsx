"use client";

import { 
  ShieldCheck, 
  AlertCircle, 
  Users, 
  Heart,
  Database,
  TrendingUp,
  Activity
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { DataHealthStats } from "@/lib/admin/service";

type DataHealthDashboardProps = {
  stats: DataHealthStats;
};

type SummaryCardProps = {
  color: "blue" | "green" | "orange" | "rose";
  icon: typeof Users;
  title: string;
  value: number | string;
};

export function DataHealthDashboard({ stats }: DataHealthDashboardProps) {
  return (
    <div className="space-y-8 p-6 lg:p-8 max-w-[1600px] mx-auto bg-slate-50/50 min-h-screen">
      {/* 1. Header & Summary Cards */}
      <div>
        <div className="flex items-center gap-3 mb-6">
          <ShieldCheck className="h-8 w-8 text-orange-500" />
          <h1 className="text-2xl font-black text-slate-900 tracking-tight">Data Health Governance</h1>
        </div>
        
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          <SummaryCard 
            title="Total Employees" 
            value={stats.summary.totalEmployees} 
            icon={Users} 
            color="blue" 
          />
          <SummaryCard 
            title="Healthy Records" 
            value={stats.summary.healthyEmployees} 
            icon={Heart} 
            color="green" 
          />
          <SummaryCard 
            title="Data Issues" 
            value={stats.summary.issuesCount} 
            icon={AlertCircle} 
            color={stats.summary.issuesCount > 0 ? "rose" : "green"} 
          />
          <SummaryCard 
            title="Health Rate" 
            value={`${stats.summary.healthRate.toFixed(1)}%`} 
            icon={TrendingUp} 
            color={stats.summary.healthRate > 95 ? "green" : stats.summary.healthRate > 80 ? "orange" : "rose"} 
          />
        </div>
      </div>

      {/* 2. Employee Issues Table */}
      <Card className="border-slate-200 shadow-sm overflow-hidden bg-white">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between bg-white">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-orange-500" />
            <h3 className="text-sm font-bold text-slate-900">Employee Linkage Audit</h3>
          </div>
          <span className="text-[10px] font-black uppercase tracking-widest text-slate-400">
            Source: employee_linkage_health
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-slate-50/50 border-b border-slate-100">
                <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">HR_ID</th>
                <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Employee Name</th>
                <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Job Title</th>
                <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Manager HR_ID</th>
                <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-50">
              {stats.employeeIssues.map((issue, i) => (
                <tr key={i} className="hover:bg-slate-50/50 transition-colors group">
                  <td className="p-4 text-xs font-mono font-bold text-slate-500">{issue.hr_id}</td>
                  <td className="p-4 text-xs font-bold text-slate-900">{issue.full_name}</td>
                  <td className="p-4 text-xs font-medium text-slate-500">{issue.job_title}</td>
                  <td className="p-4 text-xs font-mono text-slate-400">{issue.manager_hr_id || "-"}</td>
                  <td className="p-4 text-right">
                    <StatusBadge status={issue.health_status} />
                  </td>
                </tr>
              ))}
              {stats.employeeIssues.length === 0 && (
                <tr>
                  <td colSpan={5} className="p-8 text-center text-slate-400 font-medium">No employee linkage issues detected.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* 3. Sales Linkage Issues */}
        <Card className="border-slate-200 shadow-sm overflow-hidden bg-white">
          <div className="p-5 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Sales Record Linkage</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Employee HR_ID</th>
                  <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Product</th>
                  <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {stats.salesIssues.map((issue, i) => (
                  <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-4 text-xs font-mono font-bold text-slate-500">{issue.employee_hr_id}</td>
                    <td className="p-4 text-xs font-medium text-slate-500">{issue.product}</td>
                    <td className="p-4 text-right">
                      <StatusBadge status={issue.linkage_health_status} />
                    </td>
                  </tr>
                ))}
                {stats.salesIssues.length === 0 && (
                  <tr>
                    <td colSpan={3} className="p-8 text-center text-slate-400 font-medium">No sales linkage issues detected.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>

        {/* 4. Orphan HR_ID Audit */}
        <Card className="border-slate-200 shadow-sm overflow-hidden bg-white">
          <div className="p-5 border-b border-slate-100 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Database className="h-4 w-4 text-orange-500" />
              <h3 className="text-sm font-bold text-slate-900">Orphan HR_ID Audit</h3>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/50 border-b border-slate-100">
                  <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Source</th>
                  <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">HR_ID</th>
                  <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Count</th>
                  <th className="p-4 text-[10px] font-black text-slate-400 uppercase tracking-widest">Sample Name</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {stats.orphanAudit.map((orphan, i) => (
                  <tr key={i} className="hover:bg-slate-50/50 transition-colors">
                    <td className="p-4 text-[10px] font-bold text-slate-400 uppercase tracking-tighter">{orphan.source}</td>
                    <td className="p-4 text-xs font-mono font-bold text-rose-500">{orphan.hr_id}</td>
                    <td className="p-4 text-xs font-bold text-slate-900">{orphan.rows_count}</td>
                    <td className="p-4 text-xs font-medium text-slate-500">{orphan.sample_name || "-"}</td>
                  </tr>
                ))}
                {stats.orphanAudit.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-slate-400 font-medium">No orphan HR_IDs found in the system.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}

function SummaryCard({ title, value, icon: Icon, color }: SummaryCardProps) {
  const colorMap: Record<SummaryCardProps["color"], string> = {
    orange: "bg-orange-50 text-orange-500",
    green: "bg-emerald-50 text-emerald-500",
    rose: "bg-rose-50 text-rose-500",
    blue: "bg-blue-50 text-blue-500",
  };

  return (
    <Card className="p-6 bg-white border-slate-200 shadow-sm transition-all hover:shadow-md">
      <div className="flex items-center justify-between mb-4">
        <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center", colorMap[color] || colorMap.orange)}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      <div>
        <p className="text-[10px] font-black uppercase tracking-[0.15em] text-slate-400 mb-1">{title}</p>
        <p className="text-2xl font-black text-slate-900 tracking-tight">{value}</p>
      </div>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const isOk = status === "ok";
  const isWarning = ["missing_manager", "missing_line", "missing_area"].includes(status);
  
  return (
    <span className={cn(
      "inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-black uppercase tracking-wider",
      isOk ? "bg-emerald-50 text-emerald-600" : 
      isWarning ? "bg-orange-50 text-orange-600" : 
      "bg-rose-50 text-rose-600"
    )}>
      {status.replace(/_/g, " ")}
    </span>
  );
}
