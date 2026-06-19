import { PeriodSelector } from "@/components/sales-operations/period-selector";
import type { SalesOpsDashboardData } from "@/lib/sales-operations/dashboard";

// Rollup-backed dashboard (server component). Reads only pre-aggregated rollups (fast). Distinguishes
// "no data" (—) from a genuine zero so a non-reporting period/source never reads as a real zero.

const money = (n: number) => Math.round(n).toLocaleString();
const units = (n: number) => (Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 }));

function Kpi({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="bg-white px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]">{label}</div>
      <div className="text-base font-black text-[#0F172A]">{value}</div>
      {sub ? <div className="text-[11px] text-[#64748B]">{sub}</div> : null}
    </div>
  );
}

function RankTable({ title, headers, rows }: { title: string; headers: string[]; rows: (string | number)[][] }) {
  return (
    <section className="border border-[#D8E0EA] bg-white">
      <div className="bg-[#020617] px-3 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-white">{title}</div>
      <div className="overflow-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr>{headers.map((h, i) => <th key={h} className={`bg-[#0F172A] px-3 py-1.5 text-[11px] font-bold uppercase tracking-wider text-[#F1F5F9] ${i === 0 ? "text-left" : "text-right"}`}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={headers.length} className="px-3 py-3 text-center text-xs text-[#94A3B8]">— no data —</td></tr>
            ) : (
              rows.map((r, ri) => (
                <tr key={ri} className="border-b border-[rgba(249,115,22,0.18)]">
                  {r.map((c, ci) => <td key={ci} className={`px-3 py-1.5 ${ci === 0 ? "text-left font-medium text-[#0F172A]" : "text-right tabular-nums text-[#334155]"}`}>{c}</td>)}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function SalesOpsDashboard({
  data,
  trend,
  periods,
  selected,
}: {
  data: SalesOpsDashboardData;
  trend: { period: string; totalValue: number; totalQty: number }[];
  periods: string[];
  selected: string | null;
}) {
  const trendMax = Math.max(1, ...trend.map((t) => t.totalValue));
  const officeRows = data.byDistributor.filter((d) => d.distributorCode.toUpperCase() === "OFFICE");

  // area × product matrix: areas (top by value) × top 10 products
  const topProducts = data.byProduct.slice(0, 10);
  const cell = new Map(data.areaProduct.map((c) => [`${c.areaCode}|${c.productCode}`, c.totalValue]));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-black uppercase tracking-[0.08em] text-[#0F172A]">Sales Operations · Dashboard</h1>
          <p className="text-sm text-[#64748B]">Reads pre-aggregated rollups (no live fact scans). {selected ? `Showing ${selected}.` : ""}</p>
        </div>
        <PeriodSelector periods={periods} selected={selected} />
      </div>

      {!data.hasData ? (
        <div className="border border-[#D8E0EA] bg-white p-6 text-sm text-[#475569]">
          {periods.length === 0
            ? "No committed uploads yet. Upload a distributor sheet to populate the dashboard."
            : `No data for ${selected ?? "the selected period"}. Pick another period above, or upload a sheet for this month.`}
        </div>
      ) : (
        <>
          {/* KPI strip */}
          <div className="grid grid-cols-2 gap-px border border-[#E2E8F0] bg-[#E2E8F0] sm:grid-cols-3 lg:grid-cols-6">
            <Kpi label="Total value" value={data.totals ? money(data.totals.totalValue) : "—"} />
            <Kpi label="Total units" value={data.totals ? units(data.totals.totalQty) : "—"} />
            <Kpi label="Distributors" value={data.totals ? String(data.totals.distributorCount) : "—"} />
            <Kpi label="Areas" value={data.totals ? String(data.totals.areaCount) : "—"} />
            <Kpi label="Bricks" value={data.totals ? String(data.totals.brickCount) : "—"} />
            <Kpi label="Products" value={data.totals ? String(data.totals.productCount) : "—"} />
          </div>

          {/* Trend */}
          {trend.length > 1 ? (
            <section className="border border-[#D8E0EA] bg-white p-3">
              <div className="mb-2 text-[11px] font-black uppercase tracking-[0.12em] text-[#475569]">Value by period</div>
              <div className="space-y-1">
                {trend.map((t) => (
                  <div key={t.period} className="flex items-center gap-2 text-xs">
                    <span className={`w-16 shrink-0 tabular-nums ${t.period === selected ? "font-black text-[#F97316]" : "text-[#64748B]"}`}>{t.period}</span>
                    <span className="h-3 bg-[#F97316]" style={{ width: `${Math.max(2, (t.totalValue / trendMax) * 100)}%`, opacity: t.period === selected ? 1 : 0.55 }} />
                    <span className="tabular-nums text-[#334155]">{money(t.totalValue)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <RankTable
              title="By distributor"
              headers={["Distributor", "Units", "Value"]}
              rows={data.byDistributor.map((d) => [d.distributorCode === "Office" ? "Office (allocated)" : d.distributorCode, units(d.totalQty), money(d.totalValue)])}
            />
            <RankTable title="By line" headers={["Line", "Units", "Value"]} rows={data.byLine.map((l) => [l.officialLine, units(l.totalQty), money(l.totalValue)])} />
            <RankTable title="By region" headers={["Region", "Units", "Value"]} rows={data.byRegion.map((r) => [r.regionName || r.regionCode, units(r.totalQty), money(r.totalValue)])} />
            <RankTable title="Top products" headers={["Product", "Units", "Value"]} rows={data.byProduct.slice(0, 15).map((p) => [p.productName || p.productCode, units(p.totalQty), money(p.totalValue)])} />
          </div>

          {officeRows.length > 0 ? (
            <div className="border border-[#FED7AA] bg-[#FFF7ED] px-3 py-2 text-xs text-[#9A3412]">
              Office is a computed allocation ({money(officeRows[0].totalValue)} value across {officeRows[0].rowCount} brick slices) — distributed by contribution share, shown separately above.
            </div>
          ) : null}

          {/* Area × product matrix (top 10 products) */}
          <section className="border border-[#D8E0EA] bg-white">
            <div className="bg-[#020617] px-3 py-2 text-[11px] font-black uppercase tracking-[0.12em] text-white">Area × product (value, top {topProducts.length} products)</div>
            <div className="overflow-auto">
              <table className="w-full border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="bg-[#0F172A] px-2 py-1.5 text-left font-bold uppercase tracking-wider text-[#F1F5F9]">Area</th>
                    {topProducts.map((p) => <th key={p.productCode} className="bg-[#0F172A] px-2 py-1.5 text-right font-bold text-[#F1F5F9]" title={p.productName}>{(p.productName || p.productCode).slice(0, 10)}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {data.byArea.length === 0 ? (
                    <tr><td colSpan={topProducts.length + 1} className="px-3 py-3 text-center text-[#94A3B8]">— no data —</td></tr>
                  ) : (
                    data.byArea.map((a) => (
                      <tr key={a.areaCode} className="border-b border-[rgba(249,115,22,0.18)]">
                        <td className="px-2 py-1 text-left font-medium text-[#0F172A]">{a.areaName || a.areaCode}</td>
                        {topProducts.map((p) => {
                          const v = cell.get(`${a.areaCode}|${p.productCode}`);
                          return <td key={p.productCode} className="px-2 py-1 text-right tabular-nums text-[#334155]">{v ? money(v) : <span className="text-[#CBD5E1]">—</span>}</td>;
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
