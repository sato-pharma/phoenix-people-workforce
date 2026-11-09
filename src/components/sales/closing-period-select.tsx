"use client";

import { CalendarDays, ChevronDown } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { describePeriodSelection, periodLabel } from "@/lib/sales/monthly-closing-period-merge";
import { cn } from "@/lib/utils";
import { phxFieldClassName } from "@/components/ui/form-tokens";

// The month picker shared by Monthly Closing and its Performance Review.
//
// Two modes, because the reader wants two different things and one control cannot imply both:
//
//   ONE MONTH      — the closing's daily use. Picking a month replaces the selection and closes.
//   SEVERAL MONTHS — tick a set and read them as one total. Every figure on the screen then covers
//                    the whole set, which is why the summary says so in words rather than showing a
//                    count badge: "3 months · July 2026 to September 2026" cannot be misread the way
//                    a bare "3" beside a month name can.
//
// Deliberately built on the same <details> shell, borders and orange accent as
// monthly-closing-filters.tsx — the owner's rule is that a new control matches its siblings rather
// than inventing a look.

export function ClosingPeriodSelect({
  availablePeriods,
  disabled = false,
  onChange,
  value,
}: {
  availablePeriods: string[];
  disabled?: boolean;
  onChange: (periods: string[]) => void;
  value: string[];
}) {
  const holder = useRef<HTMLDetailsElement>(null);
  // State holds only what the reader CHOSE. The mode itself is derived, because a selection that
  // already carries several months can only be represented one way — radio buttons over a set are
  // not a mode, they are a broken control. Deriving it also keeps the two in step for free: there is
  // no window in which the stored mode disagrees with the selection it is supposed to describe.
  //
  // Synchronising this with an effect is a lint ERROR in this repo, and rightly so — it would
  // cascade a second render on every selection change to reach the value that was already knowable.
  const [multiChosen, setMultiChosen] = useState(false);
  const multi = multiChosen || value.length > 1;

  // Close on an outside click. Without this the panel stays open over the closing table, and the
  // table's own sticky headers then sit under a menu the reader has already finished with.
  useEffect(() => {
    function onDocumentClick(event: MouseEvent) {
      const node = holder.current;
      if (!node || !node.open) return;
      if (event.target instanceof Node && node.contains(event.target)) return;
      node.open = false;
    }
    document.addEventListener("click", onDocumentClick);
    return () => document.removeEventListener("click", onDocumentClick);
  }, []);

  const ordered = Array.from(new Set(availablePeriods.filter(Boolean))).sort().reverse();
  const selected = new Set(value);
  const summary = value.length > 0 ? describePeriodSelection(value) : "No validated data";

  function pickOne(period: string) {
    onChange([period]);
    if (holder.current) holder.current.open = false;
  }

  function toggle(period: string) {
    const next = selected.has(period) ? value.filter((entry) => entry !== period) : [...value, period];
    // Never let the set empty out. An empty selection has no meaning here — the screen would have to
    // invent a month to show, and the reader would not know which one it picked.
    if (next.length === 0) return;
    onChange(Array.from(new Set(next)).sort());
  }

  return (
    <details className="group relative" ref={holder}>
      <summary
        className={cn(
          "flex h-10 cursor-pointer list-none items-center gap-2 border border-phx-line bg-white px-3 text-sm font-semibold text-phx-ink transition hover:border-phx-accent-line [&::-webkit-details-marker]:hidden",
          disabled && "pointer-events-none opacity-50",
        )}
      >
        <CalendarDays className="h-4 w-4 text-slate-400" />
        <span className="whitespace-nowrap">{summary}</span>
        <ChevronDown className="h-4 w-4 text-slate-400 transition group-open:rotate-180" />
      </summary>

      {/* z-50 for the same reason the filter panels use it: the closing matrix's sticky headers sit
          at z-40 and would otherwise paint over this panel and swallow its clicks. */}
      <div className="absolute left-0 z-50 mt-1 max-h-80 w-72 overflow-auto border border-phx-line bg-white p-2 shadow-[0_18px_42px_rgba(15,23,42,0.16)]">
        <div className="mb-2 grid grid-cols-2 gap-1 border-b border-slate-100 pb-2">
          <button
            className={cn(
              "h-8 border text-xs font-bold transition",
              multi
                ? "border-phx-line bg-white text-slate-600 hover:border-phx-accent-line"
                : "border-phx-accent bg-phx-accent text-white",
            )}
            onClick={() => {
              setMultiChosen(false);
              // Collapsing to one month keeps the LATEST of what was ticked — the month the reader
              // is most likely to have meant, and never a silent jump to something unselected.
              if (value.length > 1) onChange([value[value.length - 1]]);
            }}
            type="button"
          >
            One month
          </button>
          <button
            className={cn(
              "h-8 border text-xs font-bold transition",
              multi
                ? "border-phx-accent bg-phx-accent text-white"
                : "border-phx-line bg-white text-slate-600 hover:border-phx-accent-line",
            )}
            onClick={() => setMultiChosen(true)}
            type="button"
          >
            Several months
          </button>
        </div>

        {ordered.length === 0 ? (
          <p className="px-2 py-3 text-xs text-slate-400">No closed month has been validated yet.</p>
        ) : (
          <>
            {multi ? (
              <div className="mb-2 flex items-center justify-between px-1">
                <span className="text-phx-sm font-bold uppercase tracking-[0.16em] text-slate-500">
                  {value.length} of {ordered.length}
                </span>
                <span className="flex gap-3">
                  <button
                    className="text-xs font-bold text-phx-accent hover:underline"
                    onClick={() => onChange([...ordered].sort())}
                    type="button"
                  >
                    All
                  </button>
                  <button
                    className="text-xs font-bold text-slate-500 hover:underline"
                    onClick={() => onChange([ordered[0]])}
                    type="button"
                  >
                    Latest only
                  </button>
                </span>
              </div>
            ) : null}

            {ordered.map((period) => (
              <label
                className="flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm text-slate-700 transition hover:bg-orange-50/60"
                key={period}
              >
                <input
                  checked={selected.has(period)}
                  className={cn(phxFieldClassName, "h-4 w-4 accent-phx-accent")}
                  name={multi ? undefined : "closing-period"}
                  onChange={() => (multi ? toggle(period) : pickOne(period))}
                  type={multi ? "checkbox" : "radio"}
                />
                <span className="whitespace-nowrap">{periodLabel(period)}</span>
              </label>
            ))}
          </>
        )}
      </div>
    </details>
  );
}
