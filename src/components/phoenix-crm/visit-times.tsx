"use client";

/**
 * "Show visit times" — the toggle on every plan board, and what it shows (owner, 2026-11-05). The rules are in
 * `src/lib/phoenix-crm/visit-times-rules.ts`.
 *
 *   - ONE switch for the person at this browser: turned on while planning one day, it stays on for the next day,
 *     the next half and the next visit to the board. Kept in this browser only — a convenience, never a record —
 *     and OFF by default, so every board reads exactly as it did until he turns it on.
 *   - A manager's card gains three lines: the days and hours the rep saved when he validated the place, the
 *     rep's last visit with its time and whether the manager was on it, and the manager's own last visit.
 *   - The rep's own day gains the time on his "Last seen" line (`visitMomentText`, format.ts).
 */

import { useSyncExternalStore } from "react";

import { crmUrl, useCrmGet } from "@/components/phoenix-crm/api";
import { visitMomentText } from "@/components/phoenix-crm/format";
import { weekTimingsText } from "@/lib/phoenix-crm/timings";
import type { CustomerVisitTimes, CustomerVisitTimesView } from "@/lib/phoenix-crm/visit-times-rules";
import { cn } from "@/lib/utils";

const STORAGE_KEY = "phoenix-crm:show-visit-times";
const listeners = new Set<() => void>();
let current: boolean | null = null;

function read(): boolean {
  if (current !== null) return current;
  try {
    current = window.localStorage.getItem(STORAGE_KEY) === "1";
  } catch {
    current = false;
  }
  return current;
}

function write(next: boolean) {
  current = next;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0");
  } catch {
    // A private window or blocked storage: the switch still works for this visit.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether visit times are shown, and the way to change it. Off on the server and on the first render. */
export function useShowVisitTimes(): [boolean, (next: boolean) => void] {
  const on = useSyncExternalStore(subscribe, read, () => false);
  return [on, write];
}

/** The switch itself — square, like every control here. */
export function VisitTimesToggle({ className }: { className?: string }) {
  const [on, setOn] = useShowVisitTimes();
  return (
    <button
      aria-checked={on}
      className={cn(
        "inline-flex min-h-10 max-w-full items-center gap-2 border px-3 text-left text-xs font-black md:min-h-9",
        on ? "border-orange-600 bg-orange-50 text-orange-900" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
        className,
      )}
      onClick={() => setOn(!on)}
      role="switch"
      type="button"
    >
      <span aria-hidden className={cn("relative inline-block h-4 w-7 shrink-0 border", on ? "border-orange-600 bg-orange-600" : "border-slate-400 bg-slate-200")}>
        <span className={cn("absolute top-0 h-full w-3 border bg-white", on ? "right-0 border-orange-600" : "left-0 border-slate-400")} />
      </span>
      <span className="break-words">Show visit times</span>
    </button>
  );
}

/** The visit times of the customers of these territories (and his own list), read only while the switch is on. */
export function useCustomerVisitTimes(input: { seats: ReadonlyArray<string>; own?: boolean; date: string; test: boolean; on: boolean }) {
  const seats = [...new Set(input.seats)].sort().join(",");
  return useCrmGet<CustomerVisitTimesView>(
    input.on && seats ? crmUrl("/api/phoenix-crm/manager-plans/customers/visit-times", { seats, own: input.own, date: input.date, test: input.test }) : null,
    "times",
  );
}

const NONE = "none in the last 26 weeks";

/**
 * The lines under a customer on a manager's card. `view` null: still loading. `ownList`: a customer of his own
 * list, who has no rep and no saved hours.
 */
export function CustomerVisitTimesLines({
  customerKey,
  error,
  ownList = false,
  today,
  view,
}: {
  customerKey: string;
  error?: string | null;
  ownList?: boolean;
  today: string;
  view: CustomerVisitTimesView | null;
}) {
  if (error) return <span className="mt-1 block break-words text-xs font-semibold text-rose-700">Visit times could not load.</span>;
  if (!view) return <span className="mt-1 block text-xs font-semibold text-slate-500">Loading visit times</span>;
  const times: CustomerVisitTimes = view.customers[customerKey] ?? (ownList ? { hours: [], you: null } : { hours: [], rep: null, you: null });
  const hours = times.hours
    .map((place) => {
      const text = weekTimingsText(place.timings, view.ramadan);
      return text ? (times.hours.length > 1 && place.label ? `${place.label}: ${text}` : text) : null;
    })
    .filter((text): text is string => text !== null);
  return (
    <span className="mt-1.5 grid min-w-0 gap-0.5 border-t border-slate-200 pt-1.5 text-xs font-semibold leading-5 text-slate-700">
      {!ownList ? (
        <span className="block break-words">
          <span className="font-black text-slate-900">Hours: </span>
          {hours.length > 0 ? hours.join(" | ") : "not saved yet"}
          {hours.length > 0 && view.ramadan ? " (Ramadan)" : ""}
        </span>
      ) : null}
      {times.rep !== undefined ? (
        <span className="block break-words">
          <span className="font-black text-slate-900">Rep&apos;s last visit: </span>
          {times.rep ? (
            <>
              {visitMomentText(times.rep, today, { saved: true })}
              <span className={cn("font-black", times.rep.withYou ? "text-emerald-700" : "text-slate-500")}>{times.rep.withYou ? " · with you" : " · without you"}</span>
            </>
          ) : (
            NONE
          )}
        </span>
      ) : null}
      <span className="block break-words">
        <span className="font-black text-slate-900">Your last visit: </span>
        {times.you ? `${visitMomentText(times.you, today)} · ${times.you.how === "with_rep" ? "with the rep" : "single visit"}` : NONE}
      </span>
    </span>
  );
}
