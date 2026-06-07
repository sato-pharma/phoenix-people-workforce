import {
  AlertTriangle,
  Building2,
  Gauge,
  Lightbulb,
  MapPinned,
  Users,
} from "lucide-react";
import type { ReactNode } from "react";

import {
  AdminCallout,
  AdminInsightChip,
  AdminPageHero,
  AdminTableShell,
} from "@/components/admin/admin-design-system";
import { SalesCommandToolbar } from "@/components/admin/sales-command-toolbar";
import type { AdminCommandCenterData } from "@/lib/admin/command-center";
import { formatCurrency, formatNumber, formatPercent } from "@/lib/sales/format";
import type { ExecutiveReport } from "@/lib/sales/executive-report";

type StripResult = { data: AdminCommandCenterData | null; error: string | null };

type Props = {
  generatedAtIso: string;
  loadError: string | null;
  periods: string[];
  prior: ExecutiveReport | null;
  priorPeriod: string | null;
  report: ExecutiveReport | null;
  /** null = all-time view. */
  selected: string | null;
  strip: StripResult;
  yoy: ExecutiveReport | null;
  yoyPeriod: string | null;
};

const thBase = "whitespace-nowrap px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wide";
const thNum = `${thBase} text-right`;
const tdBase = "whitespace-nowrap px-3 py-2";
const tdNum = `${tdBase} text-right tabular-nums text-slate-700`;
const tdName = `${tdBase} font-semibold text-slate-900`;

function periodText(period: string | null) {
  return period ?? "All-time";
}

function deltaPct(current: number, previous: number | null | undefined): number | null {
  if (previous == null || previous === 0) return null;
  return (current - previous) / previous;
}

// A numeric, no-chart comparison cell: ▲/▼ + percent, or an em dash when the baseline period was
// never imported (we never invent a comparison against missing data).
function DeltaBadge({ current, previous }: { current: number; previous: number | null | undefined }) {
  const delta = deltaPct(current, previous);
  if (delta === null) return <span className="text-slate-400">—</span>;
  const up = delta >= 0;
  return (
    <span className={up ? "font-semibold text-emerald-600" : "font-semibold text-rose-600"}>
      {up ? "▲" : "▼"} {formatPercent(Math.abs(delta), { input: "ratio" })}
    </span>
  );
}

function TableFrame({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto border border-[#E2E8F0]">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

function CompanyStrip({ strip }: { strip: StripResult }) {
  if (strip.error || !strip.data) {
    return (
      <AdminCallout tone="neutral">
        <AlertTriangle className="mt-0.5 h-4 w-4" />
        <p>Company pulse temporarily unavailable{strip.error ? ` — ${strip.error}` : "."}</p>
      </AdminCallout>
    );
  }
  const o = strip.data.overview;
  const cards: { hint?: string; label: string; value: string }[] = [
    { label: "Active Headcount", value: formatNumber(o.hr.activeEmployees) },
    { hint: o.payroll.batchLabel, label: "Net Payroll (latest)", value: formatCurrency(o.payroll.net) },
    { label: "Attrition (30d)", value: `${o.executive.attritionRate30d.toFixed(1)}%` },
    { label: "Contracts Due (7d)", value: formatNumber(o.executive.contractsDueSoon) },
    { label: "Critical Probation", value: formatNumber(o.executive.criticalProbation) },
    { label: "Overdue Leave SLA", value: formatNumber(o.executive.overdueLeaveSla) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => (
        <div className="border border-[#E2E8F0] bg-white p-3" key={card.label}>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{card.label}</p>
          <p className="mt-1 text-lg font-black tabular-nums text-slate-900">{card.value}</p>
          {card.hint ? <p className="mt-0.5 truncate text-[10px] text-slate-400">{card.hint}</p> : null}
        </div>
      ))}
    </div>
  );
}

export function SalesCommandDashboard(props: Props) {
  const { generatedAtIso, loadError, periods, prior, priorPeriod, report, selected, strip, yoy, yoyPeriod } = props;
  const selectedValue = selected ?? "all";

  const hero = (
    <AdminPageHero
      badges={(
        <>
          <AdminInsightChip>Period: {periodText(selected)}</AdminInsightChip>
          <AdminInsightChip tone="slate">Lines: {report?.byLine.length ?? 0}</AdminInsightChip>
          <AdminInsightChip tone="slate">Distributors: {report?.comparison.distributors.length ?? 0}</AdminInsightChip>
          <AdminInsightChip tone="orange">Source of Sales • company-wide</AdminInsightChip>
        </>
      )}
      description="One analytical, table-first view of the company's Source of Sales — every line, distributor, region, product and customer, with month-over-month and year-over-year comparison. No charts: just the numbers."
      eyebrow="Sales Command"
      icon={<Gauge className="h-4 w-4" />}
      title="Sales Command Center"
    />
  );

  const national = report?.comparison.national;
  const generatedLabel = (() => {
    try {
      return new Date(generatedAtIso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" });
    } catch {
      return generatedAtIso;
    }
  })();

  if (loadError) {
    return (
      <div className="min-h-[calc(100vh-7rem)] space-y-7">
        {hero}
        <SalesCommandToolbar periods={periods} selected={selectedValue} />
        <CompanyStrip strip={strip} />
        <AdminCallout tone="danger">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <p>{loadError}</p>
        </AdminCallout>
      </div>
    );
  }

  if (!national || national.value === 0) {
    return (
      <div className="min-h-[calc(100vh-7rem)] space-y-7">
        {hero}
        <SalesCommandToolbar periods={periods} selected={selectedValue} />
        <CompanyStrip strip={strip} />
        <AdminCallout tone="neutral">
          <AlertTriangle className="mt-0.5 h-4 w-4" />
          <p>No validated Source of Sales data for {periodText(selected)} yet. Upload and validate distributor sheets to populate this dashboard.</p>
        </AdminCallout>
      </div>
    );
  }

  // Baseline lookups for the comparison columns (only present when those months were imported).
  // MoM/YoY joins use STABLE keys, never display labels: distributor + region by code, line by a
  // normalized (trim + case-folded) name — so a region-name collision or line-name drift between
  // periods cannot silently mismatch or drop a comparison.
  const lineKey = (value: string) => value.trim().toLowerCase();
  const priorNational = prior?.comparison.national.value ?? null;
  const yoyNational = yoy?.comparison.national.value ?? null;
  const priorLine = new Map((prior?.byLine ?? []).map((line) => [lineKey(line.officialLine), line.value]));
  const yoyLine = new Map((yoy?.byLine ?? []).map((line) => [lineKey(line.officialLine), line.value]));
  const priorDist = new Map((prior?.comparison.byDistributor ?? []).map((dist) => [dist.distributorCode, dist.value]));
  const priorRegion = new Map((prior?.comparison.regionByDistributor ?? []).map((region) => [region.key, region.total]));

  const comparison = report!.comparison;
  const headlineCards = [
    { delta: <DeltaBadge current={national.value} previous={priorNational} />, label: "Total Value (EGP)", value: formatCurrency(national.value) },
    { delta: <DeltaBadge current={national.units} previous={prior?.comparison.national.units ?? null} />, label: "Total Units", value: formatNumber(national.units) },
    { label: "Distributors", value: formatNumber(comparison.distributors.length) },
    { label: "Lines", value: formatNumber(report!.byLine.length) },
    { label: "Products", value: formatNumber(national.productCount) },
    { label: "Areas", value: formatNumber(national.areaCount) },
    { label: "Customers", value: formatNumber(national.customerCount) },
    { delta: <DeltaBadge current={national.value} previous={yoyNational} />, label: "vs Year Ago", value: yoyPeriod ?? "—" },
  ];

  // Top products with a running cumulative share (Pareto, as a table). n ≤ 10, so the per-row
  // prefix sum is cheap and keeps the render free of mutable accumulators.
  const rankedProducts = comparison.rankings.products;
  const topProducts = rankedProducts.map((row, index) => ({
    ...row,
    cumulative: rankedProducts.slice(0, index + 1).reduce((sum, item) => sum + item.share, 0),
  }));

  return (
    <div className="min-h-[calc(100vh-7rem)] space-y-7">
      {hero}
      <SalesCommandToolbar periods={periods} selected={selectedValue} />
      <CompanyStrip strip={strip} />

      <AdminTableShell
        description={`Company-wide Source of Sales for ${periodText(selected)}. Comparisons: MoM vs ${priorPeriod ?? "—"}, YoY vs ${yoyPeriod ?? "—"}. Data as of ${generatedLabel}.`}
        title="Headline"
      >
        <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 xl:grid-cols-8 md:p-5">
          {headlineCards.map((card) => (
            <div className="border border-[#E2E8F0] bg-white p-3" key={card.label}>
              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{card.label}</p>
              <p className="mt-1 text-lg font-black tabular-nums text-slate-900">{card.value}</p>
              {card.delta ? <p className="mt-0.5 text-xs">{card.delta}</p> : null}
            </div>
          ))}
        </div>
      </AdminTableShell>

      <AdminTableShell description="Each line's contribution, with month-over-month and year-over-year movement." title="By Line">
        <TableFrame>
          <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
            <tr>
              <th className={thBase}>Line</th>
              <th className={thNum}>Value (EGP)</th>
              <th className={thNum}>% Share</th>
              <th className={thNum}>MoM</th>
              <th className={thNum}>YoY</th>
              <th className={thNum}>Units</th>
              <th className={thNum}>Products</th>
              <th className={thNum}>Areas</th>
              <th className={thNum}>Distributors</th>
            </tr>
          </thead>
          <tbody>
            {report!.byLine.map((line, index) => (
              <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={line.officialLine}>
                <td className={tdName}>{line.officialLine}</td>
                <td className={tdNum}>{formatCurrency(line.value)}</td>
                <td className={tdNum}>{formatPercent(line.valueShare, { input: "ratio" })}</td>
                <td className={`${tdBase} text-right`}><DeltaBadge current={line.value} previous={priorLine.get(lineKey(line.officialLine)) ?? null} /></td>
                <td className={`${tdBase} text-right`}><DeltaBadge current={line.value} previous={yoyLine.get(lineKey(line.officialLine)) ?? null} /></td>
                <td className={tdNum}>{formatNumber(line.units)}</td>
                <td className={tdNum}>{formatNumber(line.productCount)}</td>
                <td className={tdNum}>{formatNumber(line.areaCount)}</td>
                <td className={tdNum}>{formatNumber(line.distributorCount)}</td>
              </tr>
            ))}
            <tr className="bg-[#0B0B0B] text-white">
              <td className={`${tdBase} font-black`}>ALL LINES</td>
              <td className={`${tdBase} text-right font-black tabular-nums`}>{formatCurrency(national.value)}</td>
              <td className={`${tdBase} text-right font-black tabular-nums`}>100%</td>
              <td className={`${tdBase} text-right font-black`}><DeltaBadge current={national.value} previous={priorNational} /></td>
              <td className={`${tdBase} text-right font-black`}><DeltaBadge current={national.value} previous={yoyNational} /></td>
              <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(national.units)}</td>
              <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(national.productCount)}</td>
              <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(national.areaCount)}</td>
              <td className={`${tdBase} text-right font-black tabular-nums`}>{formatNumber(comparison.distributors.length)}</td>
            </tr>
          </tbody>
        </TableFrame>
      </AdminTableShell>

      <AdminTableShell description="Channel split across distributors — value, reach and concentration." title="By Distributor">
        <TableFrame>
          <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
            <tr>
              <th className={thBase}>Distributor</th>
              <th className={thNum}>Value (EGP)</th>
              <th className={thNum}>% Share</th>
              <th className={thNum}>MoM</th>
              <th className={thNum}>Units</th>
              <th className={thNum}>Areas</th>
              <th className={thNum}>Customers</th>
              <th className={thNum}>Products</th>
              <th className={thNum}>Value / Customer</th>
            </tr>
          </thead>
          <tbody>
            {comparison.byDistributor.map((dist, index) => (
              <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={dist.distributorCode}>
                <td className={tdName}>{dist.distributorName}</td>
                <td className={tdNum}>{formatCurrency(dist.value)}</td>
                <td className={tdNum}>{formatPercent(dist.valueShare, { input: "ratio" })}</td>
                <td className={`${tdBase} text-right`}><DeltaBadge current={dist.value} previous={priorDist.get(dist.distributorCode) ?? null} /></td>
                <td className={tdNum}>{formatNumber(dist.units)}</td>
                <td className={tdNum}>{formatNumber(dist.areaCount)}</td>
                <td className={tdNum}>{formatNumber(dist.customerCount)}</td>
                <td className={tdNum}>{formatNumber(dist.productCount)}</td>
                <td className={tdNum}>{formatCurrency(dist.avgValuePerCustomer)}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </AdminTableShell>

      <AdminTableShell description="Geographic split by region, with month-over-month movement." title="By Region">
        <TableFrame>
          <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
            <tr>
              <th className={thBase}>Region</th>
              <th className={thNum}>Value (EGP)</th>
              <th className={thNum}>% Share</th>
              <th className={thNum}>MoM</th>
            </tr>
          </thead>
          <tbody>
            {comparison.regionByDistributor.map((region, index) => (
              <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={region.key}>
                <td className={tdName}>{region.label}</td>
                <td className={tdNum}>{formatCurrency(region.total)}</td>
                <td className={tdNum}>{formatPercent(national.value > 0 ? region.total / national.value : 0, { input: "ratio" })}</td>
                <td className={`${tdBase} text-right`}><DeltaBadge current={region.total} previous={priorRegion.get(region.key) ?? null} /></td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </AdminTableShell>

      <div className="grid gap-7 xl:grid-cols-2">
        <AdminTableShell description="Top products by value, with cumulative share (Pareto)." title="Top Products">
          <TableFrame>
            <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
              <tr>
                <th className={thBase}>#</th>
                <th className={thBase}>Product</th>
                <th className={thNum}>Value (EGP)</th>
                <th className={thNum}>% Share</th>
                <th className={thNum}>Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {topProducts.map((row, index) => (
                <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={row.key}>
                  <td className={tdNum}>{row.rank}</td>
                  <td className={tdName}>{row.label}</td>
                  <td className={tdNum}>{formatCurrency(row.value)}</td>
                  <td className={tdNum}>{formatPercent(row.share, { input: "ratio" })}</td>
                  <td className={tdNum}>{formatPercent(row.cumulative, { input: "ratio" })}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        </AdminTableShell>

        <AdminTableShell
          description={`Top customers by value. Top 10 = ${formatPercent(comparison.pareto.customers.share, { input: "ratio" })} of sales (concentration).`}
          title="Top Customers"
        >
          <TableFrame>
            <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
              <tr>
                <th className={thBase}>#</th>
                <th className={thBase}>Customer</th>
                <th className={thBase}>Distributor</th>
                <th className={thNum}>Value (EGP)</th>
                <th className={thNum}>% Share</th>
              </tr>
            </thead>
            <tbody>
              {comparison.rankings.customers.map((row, index) => (
                <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={`${row.key}-${index}`}>
                  <td className={tdNum}>{row.rank}</td>
                  <td className={tdName}>{row.label}</td>
                  <td className={`${tdBase} text-slate-600`}>{row.sublabel}</td>
                  <td className={tdNum}>{formatCurrency(row.value)}</td>
                  <td className={tdNum}>{formatPercent(row.share, { input: "ratio" })}</td>
                </tr>
              ))}
            </tbody>
          </TableFrame>
        </AdminTableShell>
      </div>

      <AdminTableShell
        action={<AdminInsightChip tone="orange"><MapPinned className="h-3.5 w-3.5" /> Coverage</AdminInsightChip>}
        description="How much of the network each distributor actually reaches."
        title="Coverage"
      >
        <TableFrame>
          <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
            <tr>
              <th className={thBase}>Distributor</th>
              <th className={thNum}>Areas Reached</th>
              <th className={thNum}>Area Coverage</th>
              <th className={thNum}>Bricks Reached</th>
              <th className={thNum}>Brick Coverage</th>
            </tr>
          </thead>
          <tbody>
            {comparison.coverage.map((row, index) => (
              <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={row.distributorName}>
                <td className={tdName}>{row.distributorName}</td>
                <td className={tdNum}>{formatNumber(row.areasReached)}</td>
                <td className={tdNum}>{formatPercent(row.areaShare, { input: "ratio" })}</td>
                <td className={tdNum}>{formatNumber(row.bricksReached)}</td>
                <td className={tdNum}>{formatPercent(row.brickShare, { input: "ratio" })}</td>
              </tr>
            ))}
          </tbody>
        </TableFrame>
      </AdminTableShell>

      <div className="grid gap-7 xl:grid-cols-2">
        <AdminTableShell
          action={<AdminInsightChip tone="slate"><Building2 className="h-3.5 w-3.5" /> White-space</AdminInsightChip>}
          description="Where there is no coverage yet — the growth gaps."
          title="White-space & Risk"
        >
          <div className="space-y-3 p-4 md:p-5">
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Areas with zero sales", value: comparison.whiteSpace.zeroSalesAreas.length, total: comparison.totalAreas },
                { label: "Bricks with zero sales", value: comparison.whiteSpace.zeroSalesBricks.length, total: comparison.totalBricks },
                { label: "Single-distributor areas", value: comparison.whiteSpace.singleDistributorAreas.length },
                { label: "Products missing a region", value: comparison.whiteSpace.productGaps.length },
              ].map((item) => (
                <div className="border border-[#E2E8F0] bg-white p-3" key={item.label}>
                  <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">{item.label}</p>
                  <p className="mt-1 text-lg font-black tabular-nums text-slate-900">
                    {formatNumber(item.value)}
                    {item.total ? <span className="text-xs font-semibold text-slate-400"> / {formatNumber(item.total)}</span> : null}
                  </p>
                </div>
              ))}
            </div>
            {comparison.whiteSpace.singleDistributorAreas.length > 0 ? (
              <TableFrame>
                <thead className="bg-[#0B0B0B] text-[#F1F5F9]">
                  <tr>
                    <th className={thBase}>Single-distributor area</th>
                    <th className={thBase}>Region</th>
                    <th className={thBase}>Sole distributor</th>
                    <th className={thNum}>Value (EGP)</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.whiteSpace.singleDistributorAreas.slice(0, 10).map((row, index) => (
                    <tr className={index % 2 === 1 ? "bg-[#F8FAFC]" : ""} key={row.areaCode}>
                      <td className={tdName}>{row.areaName}</td>
                      <td className={`${tdBase} text-slate-600`}>{row.regionName}</td>
                      <td className={`${tdBase} text-slate-600`}>{row.distributorName}</td>
                      <td className={tdNum}>{formatCurrency(row.value)}</td>
                    </tr>
                  ))}
                </tbody>
              </TableFrame>
            ) : null}
          </div>
        </AdminTableShell>

        <AdminTableShell
          action={<AdminInsightChip tone="orange"><Lightbulb className="h-3.5 w-3.5" /> Read-outs</AdminInsightChip>}
          description="Plain-number takeaways from this period."
          title="Insights"
        >
          <div className="p-4 md:p-5">
            {comparison.insights.length === 0 ? (
              <p className="text-sm text-slate-500">No insights for this period.</p>
            ) : (
              <ul className="space-y-2">
                {comparison.insights.map((insight, index) => (
                  <li className="flex gap-2 border border-[#E2E8F0] bg-white p-3 text-sm text-slate-700" key={index}>
                    <span className="mt-0.5 inline-flex h-5 shrink-0 items-center bg-[#0B0B0B] px-2 text-[10px] font-bold uppercase tracking-wide text-white">
                      {insight.category}
                    </span>
                    <span>{insight.text}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </AdminTableShell>
      </div>

      <p className="flex items-center gap-2 px-1 text-xs text-slate-400">
        <Users className="h-3.5 w-3.5" /> Medical-rep sales (targets &amp; achievement %) will merge into this view in a later phase.
      </p>
    </div>
  );
}
