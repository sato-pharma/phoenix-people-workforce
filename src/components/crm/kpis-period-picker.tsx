"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { KPI_TABS, type KpiTab } from "@/lib/crm/kpis-tabs";

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
 * ## The selects are native and full size
 *
 * The owner's fits-the-screen rule forbids a horizontal scroll at any width, and a native `<select>`
 * is the one control it names as unshrinkable — iOS zooms the page when a select's text is under
 * 16px. So these stay at `text-base` and the layout wraps around them instead.
 */

const LABEL_CLASS = "text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500";
const SELECT_CLASS =
  "w-full border border-slate-300 bg-white px-3 py-2 text-base font-semibold text-slate-900 disabled:opacity-60";

export type KpiPickerOption = { label: string; value: string };

export function KpisPeriodPicker({
  basePath,
  month,
  monthOptions,
  period,
  periodOptions,
  tab,
}: {
  basePath: string;
  month: string;
  monthOptions: readonly KpiPickerOption[];
  period: string;
  periodOptions: readonly KpiPickerOption[];
  tab: KpiTab;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const apply = (next: { month?: string; period?: string }) => {
    const query = new URLSearchParams();
    const nextMonth = next.month ?? month;
    query.set("month", nextMonth);
    // Changing the MONTH drops the period back to the whole month. A week key means "week 3 of the
    // month I am looking at", so carrying `w3` across a month change silently re-points it at a
    // different seven days — and week 5 does not exist in every month at all.
    const nextPeriod = next.month != null ? "month" : (next.period ?? period);
    if (nextPeriod && nextPeriod !== "month") query.set("period", nextPeriod);
    // The tab is preserved: a manager comparing weeks on the Coverage tab means "this week's
    // coverage", not "take me back to Summary".
    if (tab !== "summary" && (KPI_TABS as readonly string[]).includes(tab)) query.set("tab", tab);
    startTransition(() => router.push(`${basePath}?${query.toString()}`));
  };

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="block">
        <span className={LABEL_CLASS}>Month</span>
        <select
          className={`mt-1 ${SELECT_CLASS}`}
          disabled={pending}
          onChange={(event) => apply({ month: event.target.value })}
          value={month}
        >
          {monthOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className={LABEL_CLASS}>Period</span>
        <select
          className={`mt-1 ${SELECT_CLASS}`}
          disabled={pending}
          onChange={(event) => apply({ period: event.target.value })}
          value={period}
        >
          {periodOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
