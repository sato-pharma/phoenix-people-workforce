import Link from "next/link";

import { CAPTION, KpiMeter, KpiRepName, KpiSection, TD, TH, toneOf } from "@/components/crm/kpis-chrome";
import { kpiBandOf, type KpiBand } from "@/lib/crm/kpis-filters";
import type { KpiTrend, KpiTrendCell, KpiTrendColumn } from "@/lib/crm/kpis-trend";
import {
  KPI_TREND_METRIC_LABEL,
  KPI_TREND_METRICS,
  KPI_TREND_SCALE_LABEL,
  KPI_TREND_SCALES,
  type KpiTrendMetric,
  type KpiTrendScale,
} from "@/lib/crm/kpis-trend-options";

/**
 * The KPIs board's Weekly tab — call rate, coverage and frequency week by week beside the month they
 * add up to, or month by month beside the quarter or semester (owner, 2026-09-22).
 *
 * TWO TABLES. The team first, one row per measure and one column per week — the owner's own picture
 * of the screen ("week one, week two, week three, and the total consolidated month of those three").
 * Then every rep on ONE measure at a time, chosen by the switch above it: five measures across six
 * periods would be thirty numbers a row, which no screen width holds without a horizontal scroll.
 *
 * THE SAME HOUSE RULES AS THE BOARD BESIDE IT (kpis-board-view.tsx carries the reasoning):
 *   - `w-full table-fixed` over a `<colgroup>` summing to 100%, never a min-width or overflow-x-auto.
 *     The column heads are short ("Week 1", "Jul", "Q3") because app/globals.css forces every head to
 *     0.78rem, and the narrowest table is the portal's 619px: a first column of 22-24% leaves 11-13%
 *     for each period, about 70-80px, and "Week 1" wraps at its space rather than overflowing.
 *   - Desktop gets the table inside `hidden md:block`, a phone gets `md:hidden` cards.
 *   - Square corners, no ellipsis, and text-phx-* never through cn().
 *   - AM, PM and pharmacy are three rows and three switch positions, never one figure.
 *
 * A server component with no function props: every link is built by the page and handed in as a
 * string, so nothing here crosses the client boundary.
 */

/**
 * A period column's head and cell: the board's TH and NUM with px-2 in place of px-3. Spelled out rather
 * than appended, because two padding utilities on one element are resolved by stylesheet order, not by
 * which is written last.
 */
const PERIOD_TH = "px-2 py-2.5 text-left text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500";
const PERIOD_TD = "px-2 py-3 align-top text-sm font-semibold tabular-nums text-slate-900";

type Reading = { value: string; caption: string; band: KpiBand; fill: number | null };

const EMPTY_READING: Reading = { value: "—", caption: "Not on the board", band: "noplan", fill: null };

function rate(value: number | null): string {
  return value == null ? "—" : value.toFixed(2);
}

/** What one cell prints for one measure. Absences are words, never a red 0% (see amPct in the board). */
function readingOf(cell: KpiTrendCell | null, metric: KpiTrendMetric, column: KpiTrendColumn): Reading {
  if (!cell) return EMPTY_READING;
  if (metric === "coverage") {
    if (cell.coverage.pct == null) return { value: "No plan", caption: "No doctor planned", band: "noplan", fill: null };
    return {
      value: `${cell.coverage.pct}%`,
      caption: `${cell.coverage.visited} of ${cell.coverage.planned} doctors`,
      band: kpiBandOf(cell.coverage.pct),
      fill: cell.coverage.pct,
    };
  }
  if (metric === "frequency") {
    if (cell.frequency.pct == null) {
      return {
        value: "No plan",
        caption: column.rules === "phoenix" ? "No graded doctor" : "No doctor planned",
        band: "noplan",
        fill: null,
      };
    }
    return {
      value: `${cell.frequency.pct}%`,
      caption: `${cell.frequency.met} of ${cell.frequency.base} ${column.rules === "legacy" ? "exact" : column.rules === "phoenix" ? "at norm" : "on target"}`,
      band: kpiBandOf(cell.frequency.pct),
      fill: cell.frequency.pct,
    };
  }

  // The three call rates. Ruling C1 first: a window that opened today has no finished day to score.
  if (column.beganToday) return { value: "—", caption: "Scored from tomorrow", band: "noplan", fill: null };
  if (cell.noGpsFeed) return { value: "No GPS feed", caption: "None provable", band: "noplan", fill: null };
  if (cell.callDays === 0) return { value: "—", caption: "No working day", band: "noplan", fill: null };
  if (!cell.logged) return { value: "No calls", caption: `${cell.callDays} working days`, band: "noplan", fill: null };
  const slice = metric === "am" ? cell.am : metric === "pm" ? cell.pm : cell.pharmacy;
  if (slice.target == null) {
    // Pharmacy has no owner-set target yet, so it is the raw rate with no percentage and no band.
    return { value: rate(slice.rate), caption: `${slice.verified} calls · no target`, band: "noplan", fill: null };
  }
  return {
    value: slice.attainmentPct == null ? "—" : `${slice.attainmentPct}%`,
    caption: `${rate(slice.rate)} of ${slice.target} a day`,
    band: kpiBandOf(slice.attainmentPct),
    fill: slice.attainmentPct,
  };
}

/** The total column is tinted so "what the weeks add up to" is found at a glance. */
function cellTint(column: KpiTrendColumn): string {
  return column.kind === "total" ? " bg-orange-50/70" : "";
}

function ReadingBlock({ reading }: { reading: Reading }) {
  return (
    <>
      <span className={`block text-base font-black ${toneOf(reading.band).text}`}>{reading.value}</span>
      <KpiMeter band={reading.band} value={reading.fill} />
      <span className="mt-1 block text-phx-xs font-semibold leading-4 text-slate-500">{reading.caption}</span>
    </>
  );
}

function PeriodHead({ column, running }: { column: KpiTrendColumn; running: boolean }) {
  const soFar = column.kind === "total" && running;
  return (
    <th className={PERIOD_TH} scope="col">
      <span className="block">{column.label}</span>
      <span className="mt-0.5 block text-phx-xs font-bold normal-case tracking-normal text-slate-400">
        {column.span}
        {soFar ? " · so far" : ""}
      </span>
    </th>
  );
}

/** Link-styled segmented switch. Links, so a change re-runs the server's scope gate like every control. */
function Switch<T extends string>({
  current,
  hrefs,
  labels,
  options,
  title,
}: {
  current: T;
  hrefs: Record<T, string>;
  labels: Record<T, string>;
  options: readonly T[];
  title: string;
}) {
  return (
    <div className="min-w-0">
      <p className="text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{title}</p>
      <div className="mt-1 flex flex-wrap gap-1.5">
        {options.map((option) => (
          <Link
            aria-current={option === current ? "page" : undefined}
            className={
              option === current
                ? "border border-orange-500 bg-orange-50 px-2.5 py-1.5 text-phx-sm font-black uppercase tracking-[0.1em] text-orange-800"
                : "border border-slate-300 bg-white px-2.5 py-1.5 text-phx-sm font-bold uppercase tracking-[0.1em] text-slate-600 transition-colors hover:border-slate-500 hover:text-slate-900"
            }
            href={hrefs[option]}
            key={option}
          >
            {labels[option]}
          </Link>
        ))}
      </div>
    </div>
  );
}

/** The team: five measures down, the periods across. */
function TeamMatrix({ trend }: { trend: KpiTrend }) {
  const { columns, team } = trend;
  const periodWidth = `${(78 / columns.length).toFixed(3)}%`;
  return (
    <>
      <div className="divide-y divide-slate-100 md:hidden">
        {KPI_TREND_METRICS.map((metric) => (
          <div className="px-4 py-4" key={metric}>
            <p className="text-phx-md font-black uppercase tracking-[0.12em] text-slate-900">
              {KPI_TREND_METRIC_LABEL[metric]}
            </p>
            <div className="mt-2 grid grid-cols-3 gap-2">
              {columns.map((column, index) => (
                <div
                  className={`min-w-0 border px-2 py-2 ${column.kind === "total" ? "border-orange-300 bg-orange-50/70" : "border-slate-200 bg-white"}`}
                  key={column.key}
                >
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{column.label}</p>
                  <p className="text-phx-xs text-slate-400">{column.span}</p>
                  <div className="mt-1 tabular-nums">
                    <ReadingBlock reading={readingOf(team[index] ?? null, metric, column)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="hidden md:block">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: "22%" }} />
            {columns.map((column) => (
              <col key={column.key} style={{ width: periodWidth }} />
            ))}
          </colgroup>
          <thead className="border-y border-slate-200 bg-slate-50">
            <tr>
              <th className={TH} scope="col">
                Measure
              </th>
              {columns.map((column) => (
                <PeriodHead column={column} key={column.key} running={trend.plan.running} />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {KPI_TREND_METRICS.map((metric) => (
              <tr key={metric}>
                <th className={`${TD} text-left font-bold text-slate-900`} scope="row">
                  {KPI_TREND_METRIC_LABEL[metric]}
                </th>
                {columns.map((column, index) => (
                  <td className={`${PERIOD_TD}${cellTint(column)}`} key={column.key}>
                    <ReadingBlock reading={readingOf(team[index] ?? null, metric, column)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** Every rep on the one measure the switch chose, the periods across. */
function RepMatrix({ metric, trend }: { metric: KpiTrendMetric; trend: KpiTrend }) {
  const { columns, reps } = trend;
  const periodWidth = `${(76 / columns.length).toFixed(3)}%`;
  return (
    <>
      <div className="divide-y divide-slate-100 md:hidden">
        {reps.map((line) => (
          <div className="px-4 py-4" key={line.key}>
            <KpiRepName areaName={line.areaName} hireDate={line.hireDate} jobTitle={line.jobTitle} lineName={line.lineName} name={line.repName} />
            <div className="mt-2 grid grid-cols-3 gap-2">
              {columns.map((column, index) => (
                <div
                  className={`min-w-0 border px-2 py-2 ${column.kind === "total" ? "border-orange-300 bg-orange-50/70" : "border-slate-200 bg-white"}`}
                  key={column.key}
                >
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-500">{column.label}</p>
                  <div className="mt-1 tabular-nums">
                    <ReadingBlock reading={readingOf(line.cells[index] ?? null, metric, column)} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
      <div className="hidden md:block">
        <table className="w-full table-fixed">
          <colgroup>
            <col style={{ width: "24%" }} />
            {columns.map((column) => (
              <col key={column.key} style={{ width: periodWidth }} />
            ))}
          </colgroup>
          <thead className="border-y border-slate-200 bg-slate-50">
            <tr>
              <th className={TH} scope="col">
                Medical rep
                <span className="mt-0.5 block text-phx-xs font-bold normal-case tracking-normal text-slate-400">
                  Line · area
                </span>
              </th>
              {columns.map((column) => (
                <PeriodHead column={column} key={column.key} running={trend.plan.running} />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {reps.map((line) => (
              <tr key={line.key}>
                <td className={TD}>
                  <KpiRepName areaName={line.areaName} hireDate={line.hireDate} jobTitle={line.jobTitle} lineName={line.lineName} name={line.repName} />
                </td>
                {columns.map((column, index) => (
                  <td className={`${PERIOD_TD}${cellTint(column)}`} key={column.key}>
                    <ReadingBlock reading={readingOf(line.cells[index] ?? null, metric, column)} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** How the total column was formed, in words — so it is never read as an average of the pieces. */
function totalExplained(trend: KpiTrend): string {
  const { plan, columns } = trend;
  const total = columns[columns.length - 1];
  const pieces = columns.filter((column) => column.kind !== "total");
  const names = pieces.map((column) => column.label);
  const list = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : (names[0] ?? "");
  if (plan.scale === "month") {
    return `${total.label} is ${total.span} scored as one window — ${list} together: their calls over their working days, and the doctors reached over the doctors planned in those days. It is not an average of the weeks, and a doctor planned in two weeks counts once in the month.`;
  }
  return `${total.label} adds ${list}: their calls over their working days, their doctors reached over their doctors planned. It is not an average of the monthly percentages, so a longer month weighs more than a shorter one.`;
}

export function KpiTrendView({
  metric,
  metricHrefs,
  scale,
  scaleHrefs,
  trend,
}: {
  metric: KpiTrendMetric;
  metricHrefs: Record<KpiTrendMetric, string>;
  scale: KpiTrendScale;
  scaleHrefs: Record<KpiTrendScale, string>;
  trend: KpiTrend;
}) {
  const single = trend.reps.length === 1 ? trend.reps[0] : null;
  const pieceWord = trend.plan.scale === "month" ? "week" : "month";
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 border-t border-slate-100 px-4 py-4 sm:px-5">
        <Switch current={scale} hrefs={scaleHrefs} labels={KPI_TREND_SCALE_LABEL} options={KPI_TREND_SCALES} title="View" />
        <p className="text-phx-md font-black uppercase tracking-[0.12em] text-slate-900">
          {trend.plan.title}
          {trend.plan.running ? <span className="ml-1.5 text-slate-500">· so far</span> : null}
        </p>
      </div>

      {trend.rulesNote ? (
        <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
          <p className={`${CAPTION} font-semibold`}>{trend.rulesNote}</p>
        </div>
      ) : null}

      {trend.columns.length === 0 ? (
        <div className="border-t border-slate-100 px-5 py-8 text-center">
          <p className="text-sm font-bold text-slate-800">Nothing in {trend.plan.title} has begun yet.</p>
          <p className={`mx-auto mt-1 max-w-md leading-5 ${CAPTION}`}>
            Each {pieceWord} appears here on the day it starts, beside the total it adds to.
          </p>
        </div>
      ) : (
        <>
          <div className="border-t border-slate-100">
            <KpiSection
              description={`All five measures, ${pieceWord} by ${pieceWord}, and the total they add up to in the last column.`}
              title={single ? `${single.repName} · ${pieceWord} by ${pieceWord}` : `Team · ${pieceWord} by ${pieceWord}`}
            >
              <TeamMatrix trend={trend} />
            </KpiSection>
          </div>

          {single ? null : (
            <div className="border-t border-slate-100">
              <KpiSection
                description={`Each rep on one measure at a time, ${pieceWord} by ${pieceWord}. AM, PM and pharmacy are read apart, never averaged.`}
                title={`Each rep · ${KPI_TREND_METRIC_LABEL[metric]}`}
              >
                <div className="border-b border-slate-100 px-4 py-3 sm:px-5">
                  <Switch
                    current={metric}
                    hrefs={metricHrefs}
                    labels={KPI_TREND_METRIC_LABEL}
                    options={KPI_TREND_METRICS}
                    title="Measure"
                  />
                </div>
                <RepMatrix metric={metric} trend={trend} />
              </KpiSection>
            </div>
          )}

          <div className="border-t border-slate-100 px-4 py-3 sm:px-5">
            <p className={`leading-4 ${CAPTION}`}>
              Each {pieceWord} is scored exactly as the Summary tab scores that {pieceWord} on its own.{" "}
              {totalExplained(trend)} Call rates stop at yesterday while a {pieceWord} is running; coverage and frequency
              already count today&apos;s visits.
            </p>
          </div>
        </>
      )}
    </>
  );
}
