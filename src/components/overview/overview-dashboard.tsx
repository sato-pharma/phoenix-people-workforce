"use client";

import {
  Activity,
  ArrowRight,
  Calendar,
  FileText,
  Landmark,
  Layers,
  LayoutDashboard,
  RefreshCw,
  Settings,
  Users,
} from "lucide-react";
import { useMemo, useState } from "react";

import { PageContainer } from "@/components/layout/page-container";
import { KPIBulletCard } from "@/components/cards/kpi-bullet-card";
import { StatusCard } from "@/components/cards/status-card";
import { ChartCard } from "@/components/cards/chart-card";
import { InsightCard } from "@/components/cards/insight-card";
import { StackedChart } from "@/components/charts/stacked-chart";
import { MultiLayerChart } from "@/components/charts/multi-layer-chart";
import { FilterChip } from "@/components/ui/filter-chip";
import { StatusBadge } from "@/components/ui/status-badge";
import type { OverviewDashboardData } from "@/lib/overview/service";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Formatting Helpers
// ---------------------------------------------------------------------------

const compactEGP = (val: number) => {
  const safe = Number.isFinite(val) ? val : 0;
  if (Math.abs(safe) >= 1_000_000) return `EGP ${(safe / 1_000_000).toFixed(2)}M`;
  if (Math.abs(safe) >= 1_000) return `EGP ${(safe / 1_000).toFixed(0)}K`;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "EGP", maximumFractionDigits: 0 }).format(safe);
};

// ---------------------------------------------------------------------------
// MAIN DASHBOARD COMPONENT
// ---------------------------------------------------------------------------

export function OverviewDashboard({ data: initialData }: { data: OverviewDashboardData }) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [data] = useState(initialData);

  const handleRefresh = () => {
    setIsRefreshing(true);
    setTimeout(() => {
      setIsRefreshing(false);
    }, 1500);
  };

  const sparklineData = useMemo(() => 
    data.sales.trend.slice(-10).map((s) => ({ val: s.sales || 0 })),
  [data.sales.trend]);

  const dynamicInsights = useMemo(() => {
    const baseInsights = [
      { 
        l: `Sales reached ${Math.round(data.sales.achievementRate * 100)}% of target`, 
        s: data.sales.achievementRate >= 1 ? "Great job! Keep up the momentum." : "Focus on closing pending deals.", 
        c: data.sales.achievementRate >= 1 ? "bg-emerald-50 text-emerald-500" : "bg-orange-50 text-orange-500" 
      },
      { 
        l: `Acceptance rate is ${Math.round(data.recruitment.acceptanceRate * 100)}%`, 
        s: "Offers are being converted successfully.", 
        c: "bg-blue-50 text-blue-500" 
      },
      { 
        l: `${data.risk.expiringContracts + data.risk.probationEndings} operational risks found`, 
        s: "Review expiring contracts and probations.", 
        c: "bg-rose-50 text-rose-500" 
      },
      { 
        l: `People cost is ${Math.round((data.financial.peopleCost / (data.financial.revenue || 1)) * 100)}% of revenue`, 
        s: "Maintaining healthy margin.", 
        c: "bg-emerald-50 text-emerald-500" 
      },
    ];
    return baseInsights;
  }, [data]);

  if (isRefreshing) {
    return (
      <PageContainer className="bg-[#F8FAFC] min-h-screen pb-12 flex items-center justify-center">
        <div className="text-center space-y-4">
          <RefreshCw className="h-12 w-12 text-orange-500 animate-spin mx-auto" />
          <p className="text-slate-500 font-bold uppercase tracking-widest text-sm">Synchronizing Admin Data...</p>
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="bg-[#F8FAFC] min-h-screen pb-12">
      <div className="mx-auto max-w-[1600px] space-y-6">
        
        {/* Admin Header Filters */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-2">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3 w-full sm:w-auto">
            <FilterChip label="Admin Overview" icon={LayoutDashboard} className="border-orange-500 bg-orange-50" showChevron={false} />
            <FilterChip label="All Entities" icon={Layers} />
            <FilterChip label="Fiscal Year 2025" icon={Calendar} />
          </div>
          <div className="flex items-center gap-2 sm:gap-3 w-full sm:w-auto justify-end">
            <button 
              onClick={handleRefresh}
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-400 shadow-sm transition hover:bg-slate-50 disabled:opacity-50"
            >
              <RefreshCw className={cn("h-4 w-4", isRefreshing && "animate-spin text-orange-500")} />
            </button>
            <FilterChip label="Admin Settings" icon={Settings} showChevron={false} className="font-bold" />
          </div>
        </div>

        {/* Executive KPI Row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <KPIBulletCard 
            title="Total Revenue" 
            value={compactEGP(data.financial.revenue).replace("EGP ", "")} 
            trend="+12.4%" 
            trendDir="up" 
            icon={Landmark} 
            color="#10B981" 
            data={sparklineData}
          />
          <KPIBulletCard 
            title="People Cost" 
            value={compactEGP(data.financial.peopleCost).replace("EGP ", "")} 
            trend="+5.2%" 
            trendDir="up" 
            icon={Users} 
            color="#3B82F6" 
            data={sparklineData}
          />
          <StatusCard 
            title="Gross Margin" 
            value={`${Math.round(data.financial.grossMargin * 100)}%`} 
            subtitle="Efficiency vs Cost" 
            percent={Math.round(data.financial.grossMargin * 100)} 
          />
          <StatusCard 
            title="Acceptance Rate" 
            value={`${Math.round(data.recruitment.acceptanceRate * 100)}%`} 
            subtitle="Recruitment Success" 
            percent={Math.round(data.recruitment.acceptanceRate * 100)} 
            colorClass="stroke-orange-500"
          />
          <KPIBulletCard 
            title="Active Employees" 
            value={data.hr.activeEmployees} 
            trend="+8" 
            trendDir="up" 
            icon={Activity} 
            color="#8B5CF6" 
            data={sparklineData}
          />
        </div>

        {/* Financial Intelligence & Recruitment Funnel */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-12">
          <ChartCard 
            title="Financial Intelligence (Revenue vs. Cost)" 
            className="md:col-span-2 lg:col-span-8"
            action={
              <div className="flex gap-4">
                <div className="flex items-center gap-1.5 text-[10px] font-bold text-emerald-500">
                  <div className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> Revenue
                </div>
                <div className="flex items-center gap-1.5 text-[10px] font-bold text-blue-500">
                  <div className="h-1.5 w-1.5 rounded-full bg-blue-500" /> People Cost
                </div>
              </div>
            }
          >
            <MultiLayerChart 
              data={data.financial.trend} 
              xAxisKey="month"
              yAxisFormatter={(v) => `${v}M`}
              tooltipSuffix="M"
              layers={[
                { key: "revenue", name: "Revenue", type: "line", color: "#10B981" },
                { key: "cost", name: "People Cost", type: "line", color: "#3B82F6" },
              ]}
            />
          </ChartCard>

          <ChartCard 
            title="Recruitment Pipeline" 
            className="md:col-span-1 lg:col-span-4"
          >
            <StackedChart 
              centerLabel={String(data.recruitment.totalOffers)}
              centerSub="Total Offers"
              data={data.recruitment.pipeline}
            />
          </ChartCard>
        </div>

        {/* Operational Risk & Employee Status */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-12">
          <ChartCard title="Operational Risk Watch" className="md:col-span-2 lg:col-span-4">
            <div className="space-y-4">
              {data.risk.alerts.length > 0 ? (
                data.risk.alerts.slice(0, 5).map((a, i) => (
                  <div key={i} className="flex gap-3 group cursor-pointer transition-transform hover:translate-x-1 p-2 rounded-xl hover:bg-slate-50">
                    <div className={cn(
                      "flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-colors", 
                      a.type === "contract" ? "bg-rose-50 text-rose-500" : "bg-orange-50 text-orange-500"
                    )}>
                      {a.type === "contract" ? <FileText className="h-5 w-5" /> : <Activity className="h-5 w-5" />}
                    </div>
                    <div>
                      <p className="text-[11px] font-black text-slate-900 group-hover:text-orange-600 transition-colors">
                        {a.type === "contract" ? "Contract Renewal" : "Probation Ending"}
                      </p>
                      <p className="text-[10px] font-bold text-slate-500">{a.name}</p>
                      <p className="mt-0.5 text-[9px] font-black text-rose-600 uppercase tracking-widest">
                        {a.days} Days Remaining
                      </p>
                    </div>
                  </div>
                ))
              ) : (
                <div className="text-center py-8 text-slate-400 font-bold text-xs">No immediate risks detected</div>
              )}
            </div>
            <button className="mt-6 flex w-full items-center justify-center text-[10px] font-black text-orange-600 uppercase tracking-widest hover:underline">
              View Risk Matrix <ArrowRight className="ml-1 h-3 w-3" />
            </button>
          </ChartCard>

          <ChartCard title="Employee Status Distribution" className="md:col-span-1 lg:col-span-4">
            <StackedChart 
              type="pie"
              innerRadius={35}
              outerRadius={55}
              centerLabel={String(data.hr.totalEmployees)}
              centerSub="Total Staff"
              data={data.hr.statusDistribution}
            />
          </ChartCard>

          <InsightCard 
            title="Strategic Insights" 
            className="md:col-span-1 lg:col-span-4"
            insights={dynamicInsights}
            actionLabel="Download Executive Report"
            onAction={() => console.log('download report')}
          />
        </div>

        {/* Recent Admin Activities */}
        <div className="grid grid-cols-1 gap-6">
           <ChartCard title="Recent Admin System Logs" className="w-full" headerClassName="mb-6">
              <div className="hidden sm:block overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Activity</th>
                      <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">Module</th>
                      <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest">User</th>
                      <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Time</th>
                      <th className="pb-3 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-50">
                    {data.activity.recent.map((a, i) => (
                      <tr key={i} className="group hover:bg-slate-50/50 transition-colors cursor-pointer">
                        <td className="py-4 text-[11px] font-bold text-slate-900 group-hover:text-orange-600 transition-colors">{a.description}</td>
                        <td className="py-4 text-[11px] font-bold text-slate-400 uppercase tracking-tighter">{a.module}</td>
                        <td className="py-4 text-[11px] font-bold text-slate-600">{a.userName}</td>
                        <td className="py-4 text-[11px] font-black text-slate-300 text-right">{a.timestamp}</td>
                        <td className="py-4 text-right">
                           <StatusBadge status={a.status} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              
              <button className="mt-6 flex w-full items-center justify-center text-[10px] font-black text-orange-600 uppercase tracking-widest hover:underline">
                View Detailed Logs <ArrowRight className="ml-1 h-3 w-3" />
              </button>
           </ChartCard>
        </div>

      </div>
    </PageContainer>
  );
}
