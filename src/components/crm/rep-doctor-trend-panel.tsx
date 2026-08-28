"use client";

import { useState } from "react";

import {
  coverageAccent,
  coverageText,
  frequencyAccent,
  frequencyText,
} from "@/components/crm/rep-doctor-kpi-tone";
import {
  PortalDesktopTable,
  PortalRecordCard,
  PortalResponsiveDataList,
} from "@/components/employee-portal/portal-primitives";
import type { RepDoctorTrend, RepDoctorTrendPoint } from "@/lib/crm/rep-doctor-lists-trend";

// Month-over-month view of the two KPIs. Styling copies the tables beside it verbatim — flat
// borders, slate-900 header row, orange accents — because this sits inside the same board and must
// not read as a one-off (owner's standing rule).
//
// Desktop table / mobile cards via PortalResponsiveDataList, which tests/crm-mobile-table-cards.test.ts
// enforces across this whole directory. A 12-column matrix side-scrolling inside a phone is exactly
// what that test exists to stop.

type Metric = "coverage" | "frequency";

const THEAD = "px-3 py-2.5 text-phx-2xs font-black uppercase tracking-[0.12em] text-white";

const METRIC_LABEL: Record<Metric, string> = { coverage: "Coverage", frequency: "Frequency" };

const toneText = (metric: Metric, pct: number): string =>
  metric === "coverage" ? coverageText(pct) : frequencyText(pct);

const toneAccent = (metric: Metric, pct: number): "amber" | "emerald" | "rose" =>
  metric === "coverage" ? coverageAccent(pct) : frequencyAccent(pct);

const pctOf = (point: RepDoctorTrendPoint, metric: Metric): number =>
  metric === "coverage" ? point.coveragePct : point.frequencyPct;

const deltaOf = (point: RepDoctorTrendPoint, metric: Metric): number | null =>
  metric === "coverage" ? point.coverageDelta : point.frequencyDelta;

/** Short month label for a column head — "Jan" from "January 2026". Never truncated with an
 * ellipsis, and never wrapped (owner's standing rule): the head is already three letters. */
function shortMonth(monthLabel: string): string {
  return monthLabel.slice(0, 3);
}

/** A signed change, or a dash when there is nothing to compare against. */
function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-300">—</span>;
  if (value === 0) return <span className="text-slate-400">0</span>;
  return (
    <span className={value > 0 ? "text-emerald-700" : "text-rose-700"}>
      {value > 0 ? "+" : ""}
      {value}
    </span>
  );
}

/** One month of a company-level series, as a compact tile. */
function MonthTile({ point }: { point: RepDoctorTrendPoint }) {
  return (
    <div className="border border-slate-200 px-2.5 py-2">
      <p className="whitespace-nowrap text-phx-3xs font-black uppercase tracking-[0.12em] text-slate-400">
        {shortMonth(point.monthLabel)}
        {point.isPartialMonth ? <span className="text-amber-600"> · to date</span> : null}
        {point.sparseAgentCoverage ? <span className="text-rose-600"> · few reps</span> : null}
      </p>
      <p className="whitespace-nowrap">
        <span className={`text-base font-black ${coverageText(point.coveragePct)}`}>{point.coveragePct}%</span>
        <span className="text-phx-2xs font-bold text-slate-300"> cov</span>
      </p>
      <p className="whitespace-nowrap">
        <span className={`text-base font-black ${frequencyText(point.frequencyPct)}`}>{point.frequencyPct}%</span>
        <span className="text-phx-2xs font-bold text-slate-300"> freq</span>
      </p>
      <p className="whitespace-nowrap text-phx-2xs font-semibold text-slate-400">
        {point.plannedDoctors} doctors · {point.measuredReps} reps
      </p>
    </div>
  );
}

export function RepDoctorTrendPanel({ trend }: { trend: RepDoctorTrend }) {
  const [metric, setMetric] = useState<Metric>("coverage");

  if (trend.months.length === 0) {
    return (
      <p className="px-5 py-6 text-xs text-slate-400">
        No months in range. The plan mirror starts at January 2026 — earlier months hold no plan at all.
      </p>
    );
  }

  const first = trend.company[0];
  const last = trend.company[trend.company.length - 1];
  const lfl = trend.likeForLike;
  const lflFirst = lfl.length > 0 ? lfl[0] : null;
  const lflLast = lfl.length > 0 ? lfl[lfl.length - 1] : null;

  return (
    <div className="space-y-5 p-5">
      {/* The population caveat comes FIRST, before any number, because the company line below rises
          for a reason that has nothing to do with performance and the reader needs that before the
          chart, not after it. */}
      <div className="border border-amber-200 bg-amber-50 px-3 py-2.5 text-phx-xs font-semibold text-amber-900">
        The company line changes population as it goes. A rep who has since left the company is
        excluded from every month, so an early month is scored over the survivors only — the plan
        mirror holds {first?.measuredReps ?? 0} measurable reps in {first?.monthLabel ?? "the first month"} against{" "}
        {last?.measuredReps ?? 0} in {last?.monthLabel ?? "the last"}. Read the{" "}
        <strong>like-for-like</strong> line beneath it for the real change: it uses only the{" "}
        {trend.likeForLikeReps} reps present in all {trend.months.length} months.
      </div>

      <div className="space-y-2">
        <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
          Everyone measured that month
        </p>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {trend.company.map((point) => (
            <MonthTile key={point.month} point={point} />
          ))}
        </div>
      </div>

      {lfl.length > 0 ? (
        <div className="space-y-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.14em] text-slate-400">
            Like for like — the same {trend.likeForLikeReps} reps in every month
          </p>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {lfl.map((point) => (
              <MonthTile key={point.month} point={point} />
            ))}
          </div>
          {lflFirst && lflLast ? (
            <p className="text-phx-xs font-semibold text-slate-500">
              Across the range those {trend.likeForLikeReps} reps moved{" "}
              <span className={coverageText(lflLast.coveragePct)}>
                {lflFirst.coveragePct}% → {lflLast.coveragePct}%
              </span>{" "}
              on coverage and{" "}
              <span className={frequencyText(lflLast.frequencyPct)}>
                {lflFirst.frequencyPct}% → {lflLast.frequencyPct}%
              </span>{" "}
              on frequency.
              {lflLast.isPartialMonth
                ? ` ${lflLast.monthLabel} is still running and is scored to date, which flatters frequency against the closed months beside it.`
                : ""}
            </p>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">Show</span>
        {(["coverage", "frequency"] as Metric[]).map((option) => (
          <button
            className={`h-8 border px-3 text-phx-xs font-black uppercase tracking-[0.12em] ${
              metric === option
                ? "border-slate-900 bg-slate-900 text-white"
                : "border-slate-200 bg-white text-slate-600 hover:border-orange-400"
            }`}
            key={option}
            onClick={() => setMetric(option)}
            type="button"
          >
            {METRIC_LABEL[option]}
          </button>
        ))}
        <span className="whitespace-nowrap text-phx-xs font-semibold text-slate-400">
          Worst change first · a blank month is one with no plan, never a zero
        </span>
      </div>

      <PortalResponsiveDataList
        empty={<p className="px-3 py-6 text-center text-xs text-slate-400">No rep has a plan in this range.</p>}
        getKey={(series) => series.repKey}
        items={trend.reps}
        renderCard={(series) => (
          <PortalRecordCard
            accent={series.latest ? toneAccent(metric, pctOf(series.latest, metric)) : "slate"}
            meta={`${series.measuredMonths} of ${trend.months.length} months measured`}
            status={
              series.latest ? (
                <span className="flex flex-col items-end leading-tight">
                  <span className={`text-sm font-black ${toneText(metric, pctOf(series.latest, metric))}`}>
                    {pctOf(series.latest, metric)}%
                  </span>
                  <span className="whitespace-nowrap text-phx-4xs font-black uppercase tracking-[0.12em] text-slate-400">
                    {METRIC_LABEL[metric]} now
                  </span>
                </span>
              ) : null
            }
            title={series.repName}
          >
            {/* The month strip, as a wrapping row of small chips rather than a table — a phone gets
                cards, never a 12-column matrix (owner's standing rule, CI-enforced module-wide). */}
            <div className="flex flex-wrap gap-1.5">
              {series.cells.map((cell, index) => (
                <span
                  className="min-w-[54px] border border-slate-100 px-1.5 py-1 text-center"
                  key={trend.months[index]}
                >
                  <span className="block whitespace-nowrap text-phx-4xs font-black uppercase tracking-[0.1em] text-slate-400">
                    {shortMonth(trend.company[index].monthLabel)}
                  </span>
                  {cell ? (
                    <span className={`block whitespace-nowrap text-xs font-black ${toneText(metric, pctOf(cell, metric))}`}>
                      {pctOf(cell, metric)}%
                    </span>
                  ) : (
                    <span className="block whitespace-nowrap text-xs font-black text-slate-300">—</span>
                  )}
                </span>
              ))}
            </div>
            <p className="mt-2 whitespace-nowrap text-phx-xs font-semibold text-slate-500">
              First measured to latest:{" "}
              <Delta value={metric === "coverage" ? series.coverageChange : series.frequencyChange} /> pts
            </p>
          </PortalRecordCard>
        )}
        renderTable={() => (
          <PortalDesktopTable className="text-xs" minWidth={`${320 + trend.months.length * 74}px`}>
            <thead>
              <tr className="bg-slate-900 text-left">
                <th className={THEAD}>Rep</th>
                {trend.company.map((point) => (
                  <th className={`${THEAD} text-right`} key={point.month}>
                    {shortMonth(point.monthLabel)}
                    {point.isPartialMonth ? <span className="text-amber-300"> *</span> : null}
                  </th>
                ))}
                <th className={`${THEAD} text-right`}>Change</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {trend.reps.map((series) => (
                <tr className="whitespace-nowrap bg-white hover:bg-slate-50" key={series.repKey}>
                  <td className="px-3 py-2 font-semibold text-slate-900">{series.repName}</td>
                  {series.cells.map((cell, index) => (
                    <td className="px-3 py-2 text-right" key={trend.months[index]}>
                      {cell ? (
                        <span className={`font-black ${toneText(metric, pctOf(cell, metric))}`}>
                          {pctOf(cell, metric)}%
                        </span>
                      ) : (
                        /* No plan that month. A 0% here would accuse a rep of a month he was never
                           measured in — the one way this board could be quietly libellous. */
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                  ))}
                  <td className="px-3 py-2 text-right font-black">
                    <Delta value={metric === "coverage" ? series.coverageChange : series.frequencyChange} />
                  </td>
                </tr>
              ))}
            </tbody>
          </PortalDesktopTable>
        )}
      />

      <p className="text-phx-xs font-semibold text-slate-400">
        {trend.company.some((point) => point.isPartialMonth)
          ? "* still running — scored to the day, so its frequency is not directly comparable with a closed month. "
          : ""}
        A month reads &ldquo;—&rdquo; when that rep had no plan at all; it is never counted as 0%.
      </p>
    </div>
  );
}

/** Kept beside the panel so a caller can show the per-month delta without re-deriving it. */
export { Delta as RepDoctorTrendDelta };
