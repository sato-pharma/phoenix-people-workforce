"use client";

// Business Review — the period filter.
//
// A plain GET form, deliberately. Every apply is a real navigation, so the page's server-side role
// gate re-runs on the new window instead of a client fetch quietly reusing the gate that passed for
// the previous one. It matches the house filter pattern in Sales & Marketing Intelligence.
//
// TWO MONTH SELECTS, NOT `type="month"`. The picker offers only months the data actually holds, so
// a manager cannot pick a window that turns out to be blank, and the cache cannot be asked for an
// unbounded number of windows. A hand-typed or bookmarked URL outside the list still has to degrade
// safely — that is `resolveReviewWindow`'s job on the server, and it says what it changed.

import { periodLabel } from "@/lib/business-review/period-format";

type Props = {
  /** Where the form submits — the page's own path. */
  action: string;
  /** Every month the review can be asked about, ascending. */
  available: string[];
  from: string;
  to: string;
  /** Params that must survive the navigation (the line switcher, mainly). */
  hidden?: Record<string, string>;
};

const FIELD =
  "h-9 rounded-lg border border-border bg-card px-2 text-sm font-semibold text-foreground " +
  "outline-none focus:border-primary";

export function ReviewPeriodFilter({ action, available, from, to, hidden }: Props) {
  // Nothing to pick from means the engine returned no validated closing at all. Say that here
  // rather than rendering two empty dropdowns that look broken.
  if (available.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
        No closed months are available to review yet.
      </p>
    );
  }

  return (
    <form method="get" action={action} className="flex flex-wrap items-center gap-2">
      {Object.entries(hidden ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <label className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <span className="whitespace-nowrap">From</span>
        <select name="from" defaultValue={from} className={FIELD}>
          {available.map((p) => (
            <option key={p} value={p}>
              {periodLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <span className="whitespace-nowrap">To</span>
        <select name="to" defaultValue={to} className={FIELD}>
          {available.map((p) => (
            <option key={p} value={p}>
              {periodLabel(p)}
            </option>
          ))}
        </select>
      </label>
      <button
        type="submit"
        className="h-9 whitespace-nowrap rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground transition-opacity hover:opacity-90"
      >
        Apply
      </button>
      <a
        href={action}
        className="h-9 whitespace-nowrap rounded-lg border border-border bg-card px-3 py-[7px] text-sm font-semibold text-muted-foreground transition-colors hover:bg-bg-muted hover:text-foreground"
      >
        Reset
      </a>
    </form>
  );
}
