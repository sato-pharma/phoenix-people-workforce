import { AppShell } from "@/components/layout/app-shell";
import { AdminInsightChip, AdminPageHero, adminPanelClassName } from "@/components/admin/admin-design-system";
import { ExpenseHeatmap } from "@/components/outstation/expense-heatmap";
import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContextFromPage } from "@/lib/auth/server";
import { getOutstationHeatmapData } from "@/lib/outstation/service";

export const dynamic = "force-dynamic";

function egp(value: number) {
  return new Intl.NumberFormat("en-US", {
    currency: "EGP",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(Number.isFinite(value) ? value : 0);
}

export default async function AdminOutstationHeatmapsPage() {
  const access = await resolveAccessContextFromPage();
  await assertPermission(access, "outstation", "read");
  const data = await getOutstationHeatmapData();

  return (
    <AppShell showTopbar={false}>
      <div className="space-y-6">
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
      </div>
    </AppShell>
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
    <div className={`${adminPanelClassName} rounded-[18px] p-4`}>
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
    <section className={`${adminPanelClassName} p-0`}>
      <div className="border-b border-[#E2E8F0] px-5 py-4">
        <h2 className="text-lg font-black tracking-[-0.03em] text-[#0F172A]">{title}</h2>
      </div>
      <div className="space-y-2 p-5">
        {rows.slice(0, 8).map((row) => (
          <div className="flex items-center justify-between gap-4 rounded-[12px] border border-[#E2E8F0] bg-[#F8FAFC] p-4" key={`${title}-${row.label}`}>
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
