"use client";

import { useCallback, useEffect, useState } from "react";

import { Switch } from "@/components/ui/switch";
import type { LateExpensesOverview } from "@/lib/automated-payroll/late-expenses";
import { cn } from "@/lib/utils";

import { formatPayrollDay, formatPayrollMoney } from "./format";

type Props = {
  month: number;
  year: number;
  /**
   * The step below has unsaved edits. Flipping the switch reloads the step, which would drop them, so
   * the switch waits until the step is saved.
   */
  stepDirty: boolean;
  /** Called after the switch changes, so the wizard reloads the Expenses step with or without the trips. */
  onChanged: () => void;
};

type LateTrip = LateExpensesOverview["trips"][number];

const money = formatPayrollMoney;

/** "3 Sep 2026", or "3 Sep 2026 → 4 Sep 2026" for an overnight trip — the module's one way of writing a day. */
function tripDates(trip: LateTrip): string {
  const start = (trip.expenseDate ?? "").slice(0, 10);
  const end = (trip.toDate ?? "").slice(0, 10);
  if (start && end && start !== end) return `${formatPayrollDay(start)} → ${formatPayrollDay(end)}`;
  return start || end ? formatPayrollDay(start || end) : "—";
}

function route(trip: LateTrip): string {
  const from = trip.fromLocation || "—";
  const to = trip.toLocation || "—";
  return `${from} → ${to}`;
}

/**
 * Approved, not yet in a run (REC-029; owner's decision: "Switch, starts OFF").
 *
 * An outstation trip approved after its payout month was published is read by no run, so it paid nobody.
 * This panel lists every such trip from September 2026 on, and holds the switch: OFF lists them only;
 * ON adds them to this run's Expenses step for the people in this run. Which trips qualify, and how a
 * carried trip is paid exactly once, lives in `src/lib/automated-payroll/late-expenses.ts`, never here.
 */
export function LateExpensesPanel({ month, year, stepDirty, onChanged }: Props) {
  const [on, setOn] = useState(false);
  const [trips, setTrips] = useState<LateTrip[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = new URLSearchParams({ month: String(month), year: String(year) });
      const res = await fetch(`/api/automated-payroll/late-expenses?${query.toString()}`);
      const data = await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}).`);
      });
      if (!res.ok) throw new Error(data.error ?? "Failed to load the approved expenses not yet in a run.");
      setOn(data.setting?.carryLateExpenses === true);
      setTrips((data.trips ?? []) as LateTrip[]);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Failed to load the approved expenses not yet in a run.");
    } finally {
      setLoading(false);
    }
  }, [month, year]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const flip = async (next: boolean) => {
    if (busy || stepDirty) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/automated-payroll/settings/carry-late-expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ on: next }),
      });
      const data = await res.json().catch(() => {
        throw new Error(`The server did not answer properly (${res.status}). Reload to see where the switch stands.`);
      });
      // A refusal (409 while a run is in Part 2 or confirmed) says why, in its own words.
      if (!res.ok) throw new Error(data.error ?? "Failed to change the switch.");
      setOn(data.setting?.carryLateExpenses === true);
      onChanged();
    } catch (flipError) {
      setError(flipError instanceof Error ? flipError.message : "Failed to change the switch.");
    } finally {
      setBusy(false);
    }
  };

  const total = trips.reduce((sum, trip) => sum + trip.amount, 0);

  return (
    <div className="flex flex-col gap-3 border border-slate-200 bg-white p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-base font-black tracking-tight text-slate-900">Approved, not yet in a run</h3>
          <p className="mt-0.5 text-sm text-slate-500">
            Outstation trips approved after their payout month was already paid. No run reads that month again, so
            they are listed here. Being listed does not prove a trip was never paid: one marked for a check by hand
            may have been paid by a typed amount, and is never added to a run. Changing the switch clears the saved
            Expenses figures of every open run and reopens its Expenses step.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={on}
            label="Add these trips to this run's Expenses step"
            onChange={(checked) => void flip(checked)}
          />
          <span className="text-sm font-semibold text-slate-800">
            {busy ? "Saving…" : on ? "ON — added to this run's Expenses step" : "OFF — listed only"}
          </span>
        </div>
      </div>

      {error ? <div className="border border-rose-200 bg-rose-50 px-4 py-2.5 text-sm text-rose-700">{error}</div> : null}
      {stepDirty ? (
        <div className="border-l-4 border-amber-400 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          Save the changes on the step below first — changing the switch reloads it.
        </div>
      ) : null}
      {on ? (
        <div className="border-l-4 border-slate-300 bg-slate-50 px-4 py-2.5 text-sm text-slate-600">
          Trips of people in this run are in the Expenses step below, marked as carried from their month. A trip is
          recorded as paid only when the confirmed Expenses figure covers it exactly; anyone else&apos;s stays on this
          list, and so does a trip marked as a likely duplicate or as needing a check by hand.
        </div>
      ) : null}

      {loading ? (
        <div className="text-sm text-slate-500">Loading approved expenses…</div>
      ) : trips.length > 0 ? (
        <>
          {/* Desktop: a fixed table that fits its width — names and routes wrap, never scroll. */}
          <table className="hidden w-full table-fixed border border-slate-200 text-sm md:table">
            <colgroup>
              <col className="w-[26%]" />
              <col className="w-[16%]" />
              <col />
              <col className="w-[16%]" />
              <col className="w-[14%]" />
            </colgroup>
            <thead className="bg-slate-900">
              <tr>
                {["Employee", "Trip date", "Route", "Payout month", "Amount"].map((label) => (
                  <th
                    key={label}
                    className={cn(
                      "px-3 py-2 text-left text-phx-xs font-bold uppercase tracking-wide text-slate-300",
                      label === "Amount" && "text-right",
                    )}
                  >
                    {label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {trips.map((trip, index) => (
                <tr key={trip.id} className={cn("border-b border-slate-200 align-top", index % 2 ? "bg-slate-50/60" : "bg-white")}>
                  <td className="break-words px-3 py-2 font-semibold text-slate-900">{trip.name}</td>
                  <td className="break-words px-3 py-2 text-slate-700">{tripDates(trip)}</td>
                  <td className="break-words px-3 py-2 text-slate-700">{route(trip)}</td>
                  <td className="break-words px-3 py-2 text-slate-700">
                    {trip.payoutLabel}
                    {trip.duplicateOf ? <span className="mt-1 block text-xs font-semibold text-amber-800">{trip.duplicateOf}</span> : null}
                    {trip.needsChecking ? (
                      <span className="mt-1 block text-xs text-slate-700">
                        <span className="font-black uppercase tracking-wide text-slate-900">Needs checking by hand · </span>
                        {trip.needsChecking}
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold tabular-nums text-slate-900">{money(trip.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Mobile: cards, as every admin table does on a phone. */}
          <div className="flex flex-col gap-2 md:hidden">
            {trips.map((trip) => (
              <div key={trip.id} className="border border-slate-200 bg-white">
                <div className="border-b border-slate-200 bg-slate-900 px-3 py-2">
                  <span className="break-words text-sm font-black tracking-tight text-white">{trip.name}</span>
                </div>
                <dl className="grid grid-cols-2 gap-x-3 gap-y-2 p-3 text-sm">
                  <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Trip date</dt>
                  <dd className="break-words text-slate-800">{tripDates(trip)}</dd>
                  <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Route</dt>
                  <dd className="break-words text-slate-800">{route(trip)}</dd>
                  <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Payout month</dt>
                  <dd className="break-words text-slate-800">
                    {trip.payoutLabel}
                    {trip.duplicateOf ? <span className="mt-1 block text-xs font-semibold text-amber-800">{trip.duplicateOf}</span> : null}
                    {trip.needsChecking ? (
                      <span className="mt-1 block text-xs text-slate-700">
                        <span className="font-black uppercase tracking-wide text-slate-900">Needs checking by hand · </span>
                        {trip.needsChecking}
                      </span>
                    ) : null}
                  </dd>
                  <dt className="text-[11px] font-black uppercase tracking-wide text-slate-500">Amount</dt>
                  <dd className="font-semibold tabular-nums text-slate-900">{money(trip.amount)}</dd>
                </dl>
              </div>
            ))}
          </div>

          {/* The total, one line under the table or the cards. */}
          <div className="flex items-center justify-between gap-3 border border-slate-200 bg-slate-50 px-3 py-2 text-sm">
            <span className="text-[11px] font-black uppercase tracking-wide text-slate-500">
              Total · {trips.length} trip{trips.length === 1 ? "" : "s"}
            </span>
            <span className="font-black tabular-nums text-slate-900">{money(total)}</span>
          </div>
        </>
      ) : error ? null : (
        <div className="text-sm text-slate-400">No approved trip is waiting from a month already paid.</div>
      )}
    </div>
  );
}
