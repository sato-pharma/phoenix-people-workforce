"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { buildKpisQuery, KPI_CUSTOM_PERIOD_VALUE, type KpiFilterState } from "@/lib/crm/kpis-filters";
import { type KpiTab } from "@/lib/crm/kpis-tabs";
import { phxSelectClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/**
 * The KPIs board's month and period pickers.
 *
 * ## Why the options arrive as plain data
 *
 * Both lists are built on the server and passed in. Computing them here would mean importing
 * `repsPlansWeeks` from crm/reps-plans.ts, and that module's dependency chain reaches the Supabase
 * admin client and `node:crypto` — which webpack cannot bundle for the browser, so the page 500s at
 * runtime while `tsc` stays perfectly happy. That is not hypothetical: it happened on 2026-09-01 on
 * the Reps Weekly Plans filter. The only runtime import here is from crm/kpis-tabs.ts, which is
 * dependency-free on purpose.
 *
 * ## The custom range
 *
 * Owner, 2026-09-04, asked for a period control covering "one week, two weeks, either either or",
 * and chose a free date pair over a fixed list of blocks. So the Period select carries the whole
 * month and its week blocks as before, plus CUSTOM RANGE — which reveals two date inputs and
 * navigates on `from..to`, the shape `repsPlansRange` has always parsed out of the URL and which
 * until now nothing offered a way to produce.
 *
 * BOTH DATES MUST BE SET BEFORE IT NAVIGATES. Pushing on the first change would score a range
 * ending on whatever the second input happened to hold, which for a freshly opened picker is the
 * window the manager is trying to leave. The inputs are clamped to the selected month, because the
 * board's other half — the doctor list — is read for one month, and a range reaching outside it
 * would print a window label the month label contradicts.
 *
 * ## The selects are native and full size
 *
 * The owner's fits-the-screen rule forbids a horizontal scroll at any width, and a native `<select>`
 * is the one control it names as unshrinkable — iOS zooms the page when a select's text is under
 * 16px. So these stay at `text-base` and the layout wraps around them instead. The date inputs are
 * held to the same size for the same reason.
 */

const LABEL_CLASS = "text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500";
const CONTROL_CLASS = cn(phxSelectClassName, "w-full px-3 py-2 text-base");

export type KpiPickerOption = { label: string; value: string };

export function KpisPeriodPicker({
  basePath,
  filters,
  month,
  monthEnd,
  monthOptions,
  monthStart,
  period,
  periodOptions,
  rangeFrom,
  rangeTo,
  rep,
  showPeriod = true,
  tab,
  trend,
  measure,
  view,
}: {
  basePath: string;
  /** Carried through every change — see the note on losing them below. */
  filters: KpiFilterState;
  month: string;
  /** The selected month's last day — the date inputs' `max`. */
  monthEnd: string;
  monthOptions: readonly KpiPickerOption[];
  /** The selected month's first day — the date inputs' `min`. */
  monthStart: string;
  period: string;
  periodOptions: readonly KpiPickerOption[];
  /** The window in force, so the date inputs open on what the board is already showing. */
  rangeFrom: string;
  rangeTo: string;
  /**
   * The rep whose doctor list is open on the Coverage tab. Carried like the filters, so moving to
   * another week keeps his list open for the new week; the server rebuilds it for the new window.
   */
  rep?: string | null;
  /**
   * False on the Weekly tab, which lays every week of the month out side by side — a Period box there
   * would pick one window out of a view whose point is all of them. The Month box stays: it chooses
   * which month's weeks (or which quarter or semester) the tab shows.
   */
  showPeriod?: boolean;
  tab: KpiTab;
  /** The Weekly tab's two switches, carried through a month change so the view stays as it was. */
  trend?: string | null;
  measure?: string | null;
  /** The call-rate report's Total / AM / PM view, carried through a month or period change. */
  view?: string | null;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  // A typed range reaches this component as `2026-09-03..2026-09-16`, which is not one of the
  // select's option values. Reading it back as "custom" is what keeps the select showing Custom
  // range after the navigation, instead of snapping back to Whole month.
  const isCustom = period.includes("..");
  const [showCustom, setShowCustom] = useState(isCustom);
  const [from, setFrom] = useState(rangeFrom);
  const [to, setTo] = useState(rangeTo);

  const push = (nextMonth: string, nextPeriod: string) => {
    // The tab AND every advanced filter are preserved. A manager comparing weeks on the Coverage
    // tab means "this week's coverage for the reps I filtered to", not "take me back to an
    // unfiltered Summary" — and a picker that silently widened the board while the chips still
    // said a filter was on would be the worst of the two possible bugs.
    startTransition(() =>
      router.push(
        `${basePath}?${buildKpisQuery({ month: nextMonth, period: nextPeriod, rep, tab, filters, trend, measure, view })}`,
      ),
    );
  };

  const applyMonth = (nextMonth: string) => {
    // Changing the MONTH drops the period back to the whole month. A week key means "week 3 of the
    // month I am looking at", so carrying `w3` across a month change silently re-points it at a
    // different seven days — and week 5 does not exist in every month at all. A typed range is
    // worse still: its dates name days the new month does not contain.
    setShowCustom(false);
    push(nextMonth, "month");
  };

  const applyPeriod = (nextPeriod: string) => {
    if (nextPeriod === KPI_CUSTOM_PERIOD_VALUE) {
      // Reveal the inputs and wait. There is no range to apply yet, and navigating now would score
      // whatever the two inputs were seeded with — the window the manager is trying to leave.
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    push(month, nextPeriod);
  };

  const applyRange = (nextFrom: string, nextTo: string) => {
    setFrom(nextFrom);
    setTo(nextTo);
    // Half a range is not a window. An empty input, or a backwards pair, leaves the board on what it
    // is already showing rather than navigating it to an empty one.
    if (!nextFrom || !nextTo || nextFrom > nextTo) return;
    push(month, `${nextFrom}..${nextTo}`);
  };

  const customOpen = showCustom || isCustom;

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className={LABEL_CLASS}>Month</span>
          <select
            className={`mt-1 ${CONTROL_CLASS}`}
            disabled={pending}
            onChange={(event) => applyMonth(event.target.value)}
            value={month}
          >
            {monthOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {showPeriod ? (
          <label className="block">
            <span className={LABEL_CLASS}>Period</span>
            <select
              className={`mt-1 ${CONTROL_CLASS}`}
              disabled={pending}
              onChange={(event) => applyPeriod(event.target.value)}
              value={customOpen ? KPI_CUSTOM_PERIOD_VALUE : period}
            >
              {periodOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="min-w-0">
            <span className={LABEL_CLASS}>Period</span>
            <p className="mt-1 border border-slate-200 bg-slate-50 px-3 py-2 text-phx-sm font-semibold leading-5 text-slate-600">
              Laid out below, week by week or month by month.
            </p>
          </div>
        )}
      </div>

      {showPeriod && customOpen ? (
        <div className="grid gap-3 border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2">
          <label className="block">
            <span className={LABEL_CLASS}>From</span>
            <input
              className={`mt-1 ${CONTROL_CLASS}`}
              disabled={pending}
              max={monthEnd}
              min={monthStart}
              onChange={(event) => applyRange(event.target.value, to)}
              type="date"
              value={from}
            />
          </label>
          <label className="block">
            <span className={LABEL_CLASS}>To</span>
            <input
              className={`mt-1 ${CONTROL_CLASS}`}
              disabled={pending}
              max={monthEnd}
              min={monthStart}
              onChange={(event) => applyRange(from, event.target.value)}
              type="date"
              value={to}
            />
          </label>
          <p className="text-phx-sm font-semibold text-slate-500 sm:col-span-2">
            Coverage and frequency are measured against every doctor planned inside these dates, and the call rate
            against the Sat–Wed working days they contain.
          </p>
        </div>
      ) : null}
    </div>
  );
}
