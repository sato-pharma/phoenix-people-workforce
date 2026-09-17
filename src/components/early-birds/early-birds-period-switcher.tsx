import Link from "next/link";
import { CalendarRange, ChevronLeft, ChevronRight } from "lucide-react";

import type { EarlyBirdsPeriod } from "@/lib/early-birds/period";
import { formatPeriodChip } from "./early-birds-format";
import { earlyBirdsHref } from "./early-birds-links";

// WHICH fortnight you are looking at.
//
// The `?period=` parameter has been honoured by both pages since the module shipped — there was
// simply never a control that set it, so every viewer was pinned to the live fortnight and a rep
// asking "how did I do last time" had no way to answer. This is that control.
//
// Links, not a <select>, for the same reason the district chips are links: the server re-resolves
// and re-authorises on every switch, and a bookmarked or shared URL lands on the same board the
// person who sent it was reading.
//
// The list is bounded at BOTH ends by listSelectableEarlyBirdsPeriods: never a future fortnight
// (there is nothing to show and "0 days remaining" would read as a result), and never one from
// before the module existed (an empty ranking looks exactly like a real ranking of nobody).

function chipClass(active: boolean): string {
  return `max-w-full shrink-0 break-words border px-2 py-1 text-phx-xs font-bold ${
    active
      ? "border-orange-300 bg-orange-50 text-orange-700"
      : "border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:text-orange-600"
  }`;
}

/** Prev/next as a link, or an inert chip at the ends of the range. Never a dead link. */
function StepLink({
  period,
  basePath,
  district,
  repHrId,
  direction,
}: {
  period: EarlyBirdsPeriod | null;
  basePath: string;
  district?: string | null;
  repHrId?: string | null;
  direction: "previous" | "next";
}) {
  const Icon = direction === "previous" ? ChevronLeft : ChevronRight;
  const label = direction === "previous" ? "Previous fortnight" : "Next fortnight";

  if (!period) {
    return (
      <span
        aria-disabled="true"
        className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-slate-100 bg-slate-50 text-slate-300"
        title={direction === "previous" ? "No earlier fortnight" : "This is the current fortnight"}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
    );
  }

  return (
    <Link
      aria-label={`${label} — ${period.label}`}
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center border border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:text-orange-600"
      href={earlyBirdsHref(basePath, { district, period: period.periodKey, rep: repHrId })}
      title={period.label}
    >
      <Icon className="h-3.5 w-3.5" />
    </Link>
  );
}

export function EarlyBirdsPeriodSwitcher({
  periods,
  selectedPeriodKey,
  livePeriodKey,
  basePath,
  district,
  repHrId,
}: {
  /** Newest first, already clamped to the selectable range by the page. */
  periods: EarlyBirdsPeriod[];
  selectedPeriodKey: string;
  /** The fortnight that is running right now — marked, never just implied by being first. */
  livePeriodKey: string;
  basePath: string;
  district?: string | null;
  repHrId?: string | null;
}) {
  if (periods.length === 0) return null;

  const index = periods.findIndex((period) => period.periodKey === selectedPeriodKey);
  const selectedIndex = index >= 0 ? index : 0;
  // `periods` runs newest -> oldest, so the NEXT fortnight is the PREVIOUS array entry.
  const olderPeriod = periods[selectedIndex + 1] ?? null;
  const newerPeriod = selectedIndex > 0 ? periods[selectedIndex - 1] : null;

  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2"
      role="navigation"
      aria-label="Fortnight"
    >
      <span className="inline-flex shrink-0 items-center gap-1.5 text-phx-3xs font-black uppercase tracking-[0.16em] text-slate-400">
        <CalendarRange className="h-3 w-3 shrink-0" />
        Fortnight
      </span>

      <div className="flex shrink-0 items-center gap-1">
        <StepLink basePath={basePath} direction="previous" district={district} period={olderPeriod} repHrId={repHrId} />
        <StepLink basePath={basePath} direction="next" district={district} period={newerPeriod} repHrId={repHrId} />
      </div>

      <div className="flex min-w-0 flex-wrap gap-1.5">
        {periods.map((period) => {
          const active = period.periodKey === selectedPeriodKey;
          const live = period.periodKey === livePeriodKey;
          return (
            <Link
              key={period.periodKey}
              aria-current={active ? "true" : undefined}
              className={chipClass(active)}
              href={earlyBirdsHref(basePath, { district, period: period.periodKey, rep: repHrId })}
              // The chip is short ("Sep 1-15"); the full label is never lost, it is the tooltip and
              // it is the board heading the click lands on.
              title={period.label}
            >
              {formatPeriodChip(period)}
              {live ? (
                <span className="ml-1 text-phx-3xs font-black uppercase tracking-[0.12em] text-emerald-600">
                  Live
                </span>
              ) : null}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
