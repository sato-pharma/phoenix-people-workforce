"use client";

/**
 * The HR command centre's charts — one block per function, above that function's tiles.
 *
 * WHY IT EXISTS. The owner's verdict on this page, 2026-09-01: *"there are too many key codes,
 * there are no any chart."* HR Operations was shown 22 figures and not one shape. A figure answers
 * "how many"; these answer the questions the figures cannot — is that a bad Tuesday or a fortnight
 * of drift, is next month six renewals or sixty, are those seven probation verdicts comfortable or
 * due this week.
 *
 * WHAT IT DRAWS WITH. `AnalyticsTrendChart`, the same wrapper the four admin analytics dashboards
 * use — dynamically imported with `ssr: false`, so recharts stays out of the initial bundle of a
 * page that is somebody's home page, and the y-axis formatter lives inside the client tree rather
 * than crossing the server boundary as a prop. This file invents no chart of its own (AGENTS.md §4:
 * match the sibling pages, never invent a one-off look), and the colours are the house palette the
 * data layer already assigns per series.
 *
 * AN EMPTY CHART STILL SHOWS ITS NAME AND SAYS WHAT IT WOULD SHOW. Both HR seats opened on
 * 1 September 2026, so on day one several of these are genuinely all-zero. A plot that vanishes
 * when it is empty teaches a new seat that the measure does not exist — the owner's rule for this
 * page type is "relevant even if empty". So the header, the caption and the link always render, and
 * only the plot itself is replaced, by `emptyLabel`. A flat axis of zeroes would be worse than
 * either: it reads as a measurement rather than as an absence.
 *
 * NEVER A HORIZONTAL SCROLL (owner's golden rule). No table, no `min-width`, no `overflow-x-auto`.
 * The plot sits in a `ResponsiveContainer` at `width="100%"`, so it fits 375px and 1440px by
 * measuring its parent rather than by being dragged sideways. The legend is `flex-wrap` and every
 * caption is `break-words`; nothing is truncated with an ellipsis.
 *
 * ONE COLUMN ON A PHONE, TWO FROM `lg`. A 14-day bar chart at 375px is legible at full width and
 * illegible at half, and `people_records` is the only function carrying two charts — which is
 * exactly where the second column earns its place on a desktop.
 */

import { ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { AnalyticsTrendChart } from "@/components/analytics/analytics-trend-chart";
import type { HrCommandChart } from "@/lib/hr/command-center";

/**
 * Whether anything is actually plotted. Decided here rather than in the data layer because it is a
 * rendering question, and because `command-center.ts` imports the Supabase services — a client
 * component may only `import type` from it.
 */
function hasData(chart: HrCommandChart): boolean {
  return chart.rows.some((row) =>
    chart.series.some((series) => Number(row[series.key] ?? 0) > 0),
  );
}

function Legend({ series }: { series: HrCommandChart["series"] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
      {series.map((one) => (
        <span className="inline-flex items-center gap-1.5" key={one.key}>
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: one.color }}
          />
          <span className="break-words text-[10px] font-black uppercase tracking-[0.12em] text-slate-500">
            {one.name}
          </span>
        </span>
      ))}
    </div>
  );
}

function ChartCard({ chart }: { chart: HrCommandChart }) {
  const plotted = hasData(chart);

  return (
    <figure className="min-w-0 border border-slate-200 bg-white">
      <figcaption className="border-b border-slate-200/70 bg-gradient-to-b from-white to-slate-50/60 px-4 py-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1.5">
          <span className="break-words text-[11px] font-black uppercase tracking-[0.14em] text-slate-950">
            {chart.title}
          </span>
          <Legend series={chart.series} />
        </div>
        <p className="mt-1.5 break-words text-[11px] font-medium leading-5 text-slate-500">
          {chart.caption}
        </p>
      </figcaption>

      <div className="px-2 py-4 sm:px-3">
        {plotted ? (
          <AnalyticsTrendChart
            data={chart.rows}
            height={200}
            layers={chart.series.map((one) => ({
              color: one.color,
              key: one.key,
              name: one.name,
              type: "bar" as const,
            }))}
            xAxisKey="label"
          />
        ) : (
          // Not a flat axis of zeroes: a plotted zero reads as a measurement, and the honest
          // statement here is that there is nothing to measure yet.
          <p className="flex min-h-[200px] items-center justify-center break-words px-4 text-center text-[12px] font-semibold leading-relaxed text-slate-400">
            {chart.emptyLabel}
          </p>
        )}
      </div>

      <div className="border-t border-slate-200/70 px-4 py-2.5">
        <Link
          className="inline-flex items-center gap-1 whitespace-nowrap text-[11px] font-black uppercase tracking-[0.1em] text-orange-600 transition-colors hover:text-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500"
          href={chart.href}
        >
          {chart.hrefLabel}
          <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />
        </Link>
      </div>
    </figure>
  );
}

export function HrCommandCharts({ charts }: { charts: HrCommandChart[] }) {
  if (charts.length === 0) return null;

  return (
    <div
      className={`grid grid-cols-1 gap-3 px-5 pt-5 ${charts.length > 1 ? "lg:grid-cols-2" : ""}`}
    >
      {charts.map((chart) => (
        <ChartCard chart={chart} key={chart.key} />
      ))}
    </div>
  );
}
