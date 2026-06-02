import { AdminInsightChip, AdminPageHero } from "@/components/admin/admin-design-system";
import { ExpenseHeatmap } from "@/components/outstation/expense-heatmap";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { assertOutstationAdminAccess } from "@/lib/outstation/admin-access";
import { getOutstationHeatmapData } from "@/lib/outstation/service";
import type { ReactNode } from "react";

export const dynamic = "force-dynamic";

const panelClassName =
  "rounded-[28px] border border-[#D8E0EA] bg-white/94 shadow-[0_18px_46px_rgba(15,23,42,0.08)] backdrop-blur";

function HeatmapAdminShell({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-h-[calc(100vh-8rem)] overflow-hidden rounded-[34px] border border-[#D8E0EA] bg-[radial-gradient(circle_at_top_left,rgba(249,115,22,0.16),transparent_32%),linear-gradient(135deg,#FFF9F3_0%,#FFFFFF_44%,#F7FAFC_100%)] p-4 shadow-[0_24px_70px_rgba(15,23,42,0.1)] sm:p-6">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#F97316]/12 blur-3xl"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute bottom-10 left-1/4 h-64 w-64 rounded-full bg-[#0F172A]/6 blur-3xl"
      />
      <div className="relative z-10 space-y-6">{children}</div>
    </div>
  );
}

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

export default async function AdminOutstationHeatmapsPage() {
  const access = await resolveAccessContextFromPage();
  await assertOutstationAdminAccess(access, "approve");
  const data = await getOutstationHeatmapData();

  return (
    <HeatmapAdminShell>
        <AdminPageHero
          badges={(
            <div className="flex flex-wrap gap-2 text-xs">
              <AdminInsightChip tone="slate">Total Requests: {data.kpis.totalRequests}</AdminInsightChip>
              <AdminInsightChip tone="orange">Total Claimed: {egp(data.kpis.totalClaimed)}</AdminInsightChip>
              <AdminInsightChip tone="slate">Variance: {egp(data.kpis.totalVariance)}</AdminInsightChip>
              <AdminInsightChip tone="slate">High Risk: {data.kpis.highRiskRequests}</AdminInsightChip>
            </div>
          )}
          description="Review destination clusters, territory variance, and high-risk concentration by city, area, and line."
          eyebrow="Outstation Heatmaps"
          icon={<span className="inline-block h-3.5 w-3.5 rounded-full border border-[#FDBA74] bg-[#FFF7ED] text-[#EA580C]" />}
          title="Expense concentration and territory variance"
        />

        <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <MetricBlock label="Total Requests" value={String(data.kpis.totalRequests)} />
          <MetricBlock label="High Risk" value={String(data.kpis.highRiskRequests)} />
          <MetricBlock label="Claimed" value={egp(data.kpis.totalClaimed)} />
          <MetricBlock label="Variance" value={egp(data.kpis.totalVariance)} />
        </section>

        <ExpenseHeatmap data={data} />

        <div className="grid gap-6 xl:grid-cols-2">
          <SummaryTable
            rows={data.heatmapRows.byCity.map((row) => ({
              label: row.label,
              secondary: `${row.trips} trips`,
              value: egp(row.totalExpenses),
            }))}
            title="Expenses by City"
          />
          <SummaryTable
            rows={data.heatmapRows.byArea.map((row) => ({
              label: row.label,
              secondary: `${row.trips} trips`,
              value: egp(row.totalVariance),
            }))}
            title="Variance by Area"
          />
          <SummaryTable
            rows={data.heatmapRows.byLine.map((row) => ({
              label: row.label,
              secondary: `${row.trips} trips`,
              value: egp(row.totalExpenses),
            }))}
            title="Expenses by Line"
          />
          <SummaryTable
            rows={data.heatmapRows.highRiskByLocation.map((row) => ({
              label: row.label,
              secondary: "High-risk requests",
              value: String(row.highRiskTrips),
            }))}
            title="High-Risk by Location"
          />
        </div>
    </HeatmapAdminShell>
  );
}

function MetricBlock({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className={`${panelClassName} p-4 transition-transform duration-200 hover:-translate-y-0.5`}>
      <p className="text-[11px] font-black uppercase tracking-[0.16em] text-[#64748B]">{label}</p>
      <p className="mt-2 truncate text-2xl font-black text-[#0F172A]">{value}</p>
    </div>
  );
}

function SummaryTable({
  rows,
  title,
}: {
  rows: Array<{ label: string; secondary: string; value: string }>;
  title: string;
}) {
  return (
    <section className={`${panelClassName} overflow-hidden p-0`}>
      <div className="border-b border-[#E2E8F0] bg-[linear-gradient(135deg,#F8FAFC_0%,#FFF7ED_100%)] px-5 py-4">
        <h2 className="text-lg font-black tracking-[-0.03em] text-[#0F172A]">{title}</h2>
      </div>
      <div className="space-y-2 p-5">
        {rows.slice(0, 8).map((row) => (
          <div className="flex items-center justify-between gap-4 rounded-2xl border border-[#E2E8F0] bg-[#F8FAFC]/85 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.75)]" key={`${title}-${row.label}`}>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-[#0F172A]">{row.label}</p>
              <p className="mt-1 text-xs text-[#64748B]">{row.secondary}</p>
            </div>
            <span className="shrink-0 text-sm font-black text-[#0F172A]">{row.value}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
