"use client";

/**
 * Phoenix CRM — Place checks: one place on a phone, closed until it is opened.
 *
 * 🔴 WHY IT EXISTS. Measured at 375 px in the preview of the rebuild (23 Nov 2026): the Super Admin's
 * page was 50,990 px long, the first Approve sat 2,432 px down, and one polyclinic with its seated
 * customers ran 14,000 px. Paging by ten did not shorten it, because every card drew its photographs,
 * its evidence and its controls whole. A phone card is now who and what, in a few lines; a press opens
 * the same evidence and the same controls under it. Nothing is drawn a second way: what is inside is
 * exactly what the card always held, so there is still one way to decide.
 *
 * A closed card's photographs are not fetched (they are `loading="lazy"` and not on screen), so a phone
 * reads ten places without downloading thirty pictures.
 *
 * The desktop table never uses this: it is drawn only inside `CrmCardsOnPhone`.
 */

import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

export function PhoneFold({ children, summary }: { children: ReactNode; summary: ReactNode }) {
  return (
    <details className="group min-w-0" data-phone-fold>
      <summary className="flex min-h-11 min-w-0 cursor-pointer list-none items-start justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <div className="min-w-0 flex-1">{summary}</div>
        <span className="inline-flex min-h-11 shrink-0 items-center gap-1 text-xs font-black text-orange-700">
          <span className="group-open:hidden">Open</span>
          <span className="hidden group-open:inline">Close</span>
          <ChevronDown aria-hidden className="h-4 w-4 transition-transform group-open:rotate-180" />
        </span>
      </summary>
      {children}
    </details>
  );
}
