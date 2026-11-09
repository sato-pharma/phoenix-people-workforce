"use client";

import { cn } from "@/lib/utils";
import { MONTH_CHIP_LEGEND, monthChips } from "@/lib/sales/territory/drilldown-words";
import type { TerritoryPharmacy } from "@/lib/sales/territory/types";

/**
 * One chip per month of the window, shared by the desktop and the mobile tree so the two never
 * drift. The year sits on the first chip and on each January (a window can cross a year, and a bare
 * "Jan" is then ambiguous); the old chips cut the month to three letters and kept the year in a hover
 * title a phone cannot show. Each chip is spoken as "Jul 2026: bought", so the colour is never the
 * only signal. Square, flat, 11px — the page's floor.
 */
export function MonthChipRow({ pharmacy, className }: { pharmacy: TerritoryPharmacy; className?: string }) {
  const chips = monthChips(pharmacy.months);
  return (
    <ul aria-label={`Months ${pharmacy.clientName} bought`} className={cn("flex flex-wrap gap-1", className)}>
      {chips.map((chip, index) => {
        const bought = pharmacy.months[index]?.hasSales ?? false;
        return (
          <li
            aria-label={chip.spoken}
            className={cn(
              "border px-1.5 py-0.5 text-phx-xs font-bold tabular-nums",
              bought
                ? "border-orange-300 bg-orange-50 text-orange-800"
                : "border-slate-200 bg-white text-slate-500",
            )}
            key={chip.period}
          >
            {chip.label}
          </li>
        );
      })}
    </ul>
  );
}

/** Said once over a brick's pharmacy cards, so the chips' two colours are never left to be guessed. */
export function MonthChipLegend({ className }: { className?: string }) {
  return (
    <p className={cn("flex flex-wrap items-center gap-x-3 gap-y-1 text-phx-xs text-slate-600", className)}>
      <span aria-hidden className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 border border-orange-300 bg-orange-50" />
        Bought
      </span>
      <span aria-hidden className="inline-flex items-center gap-1">
        <span className="inline-block h-2.5 w-2.5 border border-slate-200 bg-white" />
        No purchase
      </span>
      <span className="sr-only">{MONTH_CHIP_LEGEND}</span>
    </p>
  );
}
