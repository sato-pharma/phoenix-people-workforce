// Legacy component — superseded by AdminCommandCenter. Kept for reference only.
import {
  Users, 
  UserCheck, 
  CreditCard, 
  FileText, 
  TrendingUp, 
  Receipt,
  AlertTriangle,
  Briefcase,
  Gift,
  Network,
  Database,
  ChevronRight,
  Activity,
  ArrowRight
} from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { PhoenixAdminStats } from "@/lib/admin/service";

type PhoenixAdminDashboardProps = {
  stats: PhoenixAdminStats;
};

type DashboardTone = "orange" | "rose";

type KpiCardProps = {
  color?: DashboardTone;
  icon: typeof Users;
  title: string;
  value: number;
};

type AlertCardProps = {
  color?: DashboardTone;
  icon: typeof Users;
  title: string;
  urgent?: boolean;
  value: number;
};

type ModuleCardProps = {
  description: string;
  href: string;
  icon: typeof Users;
  stat?: number;
  title: string;
};

export function PhoenixAdminDashboard({ stats }: PhoenixAdminDashboardProps) {
  return (
    <div className="space-y-8 p-6 lg:p-8 max-w-[1600px] mx-auto bg-slate-50/50 min-h-screen">
      {/* 1. Header & KPIs */}
      <div>
        <h1 className="text-2xl font-black text-slate-900 tracking-tight mb-6">Command Center</h1>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
          <KPICard title="Total Employees" value={stats.totalEmployees} icon={Users} color="orange" />
          <KPICard title="Active Staff" value={stats.activeEmployees} icon={UserCheck} color="orange" />
          <KPICard title="Payroll Eligible" value={stats.payrollEligible} icon={CreditCard} color="orange" />
          <KPICard title="Salary Records" value={stats.salaryRecords} icon={FileText} color="orange" />
          <KPICard title="Sales Records" value={stats.salesRecords} icon={TrendingUp} color="orange" />
          <KPICard title="Total Expenses" value={stats.expensesCount} icon={Receipt} color="orange" />
        </div>
      </div>

      {/* 2. Operational Alerts */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <AlertCard 
          title="Salary Flags" 
          value={stats.salaryFlags} 
          icon={AlertTriangle} 
          urgent={stats.salaryFlags > 0} 
        />
        <AlertCard 
          title="Data Health Issues" 
          value={stats.dataHealthIssues} 
          icon={Database} 
          urgent={stats.dataHealthIssues > 0} 
        />
        <AlertCard 
          title="Open Vacancies" 
          value={stats.vacancies} 
          icon={Briefcase} 
          color="orange"
        />
        <AlertCard 
          title="Pending Offers" 
          value={stats.offers} 
          icon={Gift} 
          color="orange"
        />
      </div>

      {/* 3. Module Navigation */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <ModuleCard 
          title="People Management" 
          description="Manage employees, profiles and documents" 
          href="/employees" 
          stat={stats.totalEmployees}
          icon={Users}
        />
        <ModuleCard 
          title="Organogram" 
          description="Visual hierarchy and structure" 
          href="/organogram" 
          icon={Network}
        />
        <ModuleCard 
          title="Payroll Control" 
          description="Salary processing and compliance" 
          href="/payroll" 
          stat={stats.salaryRecords}
          icon={CreditCard}
        />
        <ModuleCard 
          title="Sales Operations" 
          description="Performance and field data" 
          href="/sales" 
          stat={stats.salesRecords}
          icon={TrendingUp}
        />
        <ModuleCard 
          title="Expenses" 
          description="Claim approvals and reimbursements" 
          href="/payroll/expenses" 
          stat={stats.expensesCount}
          icon={Receipt}
        />
        <ModuleCard 
          title="Offer Lifecycle" 
          description="Recruitment and onboarding" 
          href="/offers" 
          stat={stats.offers}
          icon={Gift}
        />
        <ModuleCard 
          title="Data Health" 
          description="Sync status and data integrity" 
          href="/admin/data-health" 
          stat={stats.dataHealthIssues}
          icon={Database}
        />
        <ModuleCard 
          title="Monitoring" 
          description="Auth, notification, and audit activity" 
          href="/admin/monitoring" 
          icon={Activity}
        />
      </div>

      {/* 4. System Activity */}
      <Card className="border-slate-200 shadow-sm overflow-hidden bg-white">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-orange-500" />
            <h3 className="text-sm font-bold text-slate-900">System Activity (Audit Logs)</h3>
          </div>
          <Link href="/admin/logs" className="text-xs font-bold text-orange-600 hover:underline flex items-center gap-1">
            View All <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
        <div className="divide-y divide-slate-50">
          {stats.auditLogs.map((log, i) => (
            <div key={i} className="p-4 flex items-center justify-between hover:bg-slate-50 transition-colors">
              <div className="flex items-center gap-4">
                <div className="h-8 w-8 rounded-lg bg-slate-50 flex items-center justify-center">
                  <span className="text-[10px] font-bold text-slate-400">#{i + 1}</span>
                </div>
                <div>
                  <p className="text-xs font-bold text-slate-900">{log.action || "Unknown Action"}</p>
                  <p className="text-[10px] text-slate-500 font-medium">{log.entity_name || "System"}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-bold text-slate-400">
                  {log.created_at ? new Date(log.created_at).toLocaleString() : "Just now"}
                </p>
                <p className="text-[9px] text-slate-300 font-black uppercase tracking-widest">{log.user_email || "System"}</p>
              </div>
            </div>
          ))}
          {stats.auditLogs.length === 0 && (
            <div className="p-8 text-center">
              <p className="text-sm text-slate-400 font-medium">No recent activity logs found.</p>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

function KPICard({ title, value, icon: Icon }: KpiCardProps) {
  return (
    <Card className="p-5 bg-white border-slate-200 shadow-sm hover:border-orange-200 transition-colors group">
      <div className="flex flex-col gap-3">
        <div className="h-10 w-10 rounded-xl bg-orange-50 text-orange-500 flex items-center justify-center group-hover:bg-orange-500 group-hover:text-white transition-colors">
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <p className="text-[10px] font-black uppercase tracking-[0.1em] text-slate-400 mb-1">{title}</p>
          <p className="text-2xl font-black text-slate-900">{value.toLocaleString()}</p>
        </div>
      </div>
    </Card>
  );
}

function AlertCard({ title, value, icon: Icon, urgent = false, color }: AlertCardProps) {
  return (
    <Card className={cn(
      "p-5 border-slate-200 shadow-sm transition-all",
      urgent ? "bg-rose-50 border-rose-100" : "bg-white",
      !urgent && color === "orange" && "hover:border-orange-200"
    )}>
      <div className="flex items-center gap-4">
        <div className={cn(
          "h-12 w-12 rounded-2xl flex items-center justify-center",
          urgent ? "bg-rose-500 text-white" : "bg-slate-50 text-slate-400"
        )}>
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <p className={cn(
            "text-[10px] font-black uppercase tracking-[0.1em] mb-1",
            urgent ? "text-rose-600" : "text-slate-400"
          )}>{title}</p>
          <p className={cn(
            "text-2xl font-black",
            urgent ? "text-rose-700" : "text-slate-900"
          )}>{value.toLocaleString()}</p>
        </div>
      </div>
    </Card>
  );
}

function ModuleCard({ title, description, href, stat, icon: Icon }: ModuleCardProps) {
  return (
    <Link href={href}>
      <Card className="p-5 h-full bg-white border-slate-200 shadow-sm hover:border-orange-500 hover:shadow-md transition-all group">
        <div className="flex justify-between items-start mb-4">
          <div className="h-10 w-10 rounded-xl bg-slate-50 text-slate-400 flex items-center justify-center group-hover:bg-orange-50 group-hover:text-orange-500 transition-colors">
            <Icon className="h-5 w-5" />
          </div>
          {stat !== undefined && (
            <span className="text-xs font-black text-slate-400 group-hover:text-orange-600">
              {stat.toLocaleString()}
            </span>
          )}
        </div>
        <h4 className="text-sm font-black text-slate-900 mb-1 group-hover:text-orange-600 transition-colors">{title}</h4>
        <p className="text-[11px] text-slate-500 font-medium leading-relaxed">{description}</p>
        <div className="mt-4 flex items-center text-[10px] font-black uppercase tracking-widest text-slate-300 group-hover:text-orange-500">
          Open Module <ChevronRight className="h-3 w-3 ml-1" />
        </div>
      </Card>
    </Link>
  );
}
