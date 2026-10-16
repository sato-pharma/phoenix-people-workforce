"use client";

/**
 * The bar directly under her identity strip: the ONE way into her pendings on the left, the Hired
 * card's window on the right.
 *
 * WHY THESE TWO AND NOTHING ELSE. Both are his rulings on this page. "the needs attentions button is
 * fair enough make it show all pendings when clicked on and remove the upper part" (2026-10-13), so
 * the pendings are one press away and nothing stands open above the figures; and the Hired window
 * sits on this bar because the Hired card is the one PERIOD figure on the page and the bar is the
 * only row with room beside it (he picked it there on 2026-10-16, after "this wrongly placed").
 *
 * THE SECOND COUNT IS GONE AND STAYS GONE. A "5 figures to action" badge stood beside the button
 * until he ticked it as a duplicate ("remove duplicates", 2026-10-16). What this bar adds instead is
 * not a second total but a PART of the one total — how many of the pendings are already past their
 * due date — in rose, because rose is the page's one colour for "a problem", and only when there is
 * one. Zero overdue draws nothing at all: an "0 overdue" chip is noise she would learn to skip.
 *
 * The bar's left edge is `pageHeaderRailClassName`, the 3px fading orange rail every admin page
 * header already carries, so it reads as the page's own header row rather than a new strip.
 */

import { TriangleAlert } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { adminControlDepthClassName, pageHeaderRailClassName } from "@/components/admin/admin-design-tokens";
import { phxFieldClassName } from "@/components/ui/form-tokens";

import { TA_CAPS_CLASS, TaChip } from "./panel";

/**
 * The Hired card's window, as a from/to pair.
 *
 * The generic page's picker, for the same reason it exists there: the count is made on the SERVER
 * over every hire the seat can see, so changing the window has to reach the server. The query string
 * also makes a chosen range shareable and survivable across a reload, and "This month" is the
 * absence of both params.
 */
export function HiredWindowPicker({ window: current }: { window: { fromIso: string; toIso: string } }) {
  // The caller gives this a `key` built from the resolved window, so a window the server normalised
  // REMOUNTS it and the boxes re-seed from what was actually counted. Syncing props into state with
  // an effect would do the same job and is a lint ERROR in this repo.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [from, setFrom] = useState(current.fromIso);
  const [to, setTo] = useState(current.toIso);

  function apply(next: { from: string; to: string } | null) {
    const params = new URLSearchParams(searchParams?.toString() ?? "");
    if (next) {
      params.set("hiredFrom", next.from);
      params.set("hiredTo", next.to);
    } else {
      params.delete("hiredFrom");
      params.delete("hiredTo");
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const isDefault = !searchParams?.get("hiredFrom") && !searchParams?.get("hiredTo");
  const changed = from !== current.fromIso || to !== current.toIso;

  return (
    <div
      aria-label="Window the Hired figure counts"
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 @min-[720px]:ml-auto"
      role="group"
    >
      {/* Its own line on a phone, so the two dates stay side by side on the next one rather than
          splitting "to" from its date. */}
      <span className={`${TA_CAPS_CLASS} basis-full text-slate-500 @min-[480px]:basis-auto`}>Hired between</span>
      {/* The pair is ONE unit: on a phone the two boxes share the row's width; from 480px they take
          their fixed width back. */}
      <span className="flex w-full items-center gap-2 @min-[480px]:w-auto">
        <span className="block min-w-0 flex-1 @min-[480px]:w-36 @min-[480px]:flex-none">
          <input
            aria-label="Hired from"
            className={phxFieldClassName}
            onChange={(event) => setFrom(event.target.value)}
            type="date"
            value={from}
          />
        </span>
        <span aria-hidden="true" className="shrink-0 text-[10px] font-black uppercase text-slate-400">
          to
        </span>
        <span className="block min-w-0 flex-1 @min-[480px]:w-36 @min-[480px]:flex-none">
          <input
            aria-label="Hired to"
            className={phxFieldClassName}
            onChange={(event) => setTo(event.target.value)}
            type="date"
            value={to}
          />
        </span>
      </span>
      <button
        className={`border px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${adminControlDepthClassName} ${
          changed
            ? "border-orange-500 bg-orange-500 text-white hover:bg-orange-600"
            : "border-orange-300 bg-orange-50 text-orange-700 hover:bg-orange-100"
        }`}
        onClick={() => apply({ from, to })}
        type="button"
      >
        Apply
      </button>
      {isDefault ? null : (
        <button
          className={`border border-slate-200 bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-slate-600 transition-colors hover:bg-slate-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${adminControlDepthClassName}`}
          onClick={() => apply(null)}
          type="button"
        >
          This month
        </button>
      )}
    </div>
  );
}

export function TaCommandRail({
  hiredWindow,
  onToggle,
  open,
  overdueCount,
  panelId,
  pendingCount,
}: {
  /** Null when the recruiting figures did not load: no Hired card, so no window to pick. */
  hiredWindow: { fromIso: string; toIso: string } | null;
  onToggle: () => void;
  open: boolean;
  /** How many of the pendings are past their due date — a part of `pendingCount`, never added to it. */
  overdueCount: number;
  panelId: string;
  pendingCount: number;
}) {
  return (
    <div className="@container relative border-b border-slate-200/70 bg-white px-5 py-3">
      <span aria-hidden="true" className={pageHeaderRailClassName} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <button
            aria-controls={panelId}
            aria-expanded={open}
            className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap border px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 ${adminControlDepthClassName} ${
              open
                ? "border-orange-300 bg-orange-50 text-orange-700"
                : "border-slate-200 bg-white text-slate-600 hover:border-orange-200 hover:bg-orange-50/40"
            }`}
            onClick={onToggle}
            type="button"
          >
            <TriangleAlert aria-hidden="true" className="h-3.5 w-3.5" />
            Needs attention
            <span
              className={`min-w-5 border px-1 text-center tabular-nums ${
                pendingCount > 0
                  ? "border-orange-500 bg-orange-500 text-white"
                  : "border-slate-200 bg-slate-50 text-slate-500"
              }`}
            >
              {pendingCount.toLocaleString("en-US")}
            </span>
          </button>
          {overdueCount > 0 ? <TaChip tone="rose">{overdueCount.toLocaleString("en-US")} overdue</TaChip> : null}
        </div>
        {hiredWindow ? (
          <HiredWindowPicker key={`${hiredWindow.fromIso}|${hiredWindow.toIso}`} window={hiredWindow} />
        ) : null}
      </div>
    </div>
  );
}
