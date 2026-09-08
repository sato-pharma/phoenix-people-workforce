"use client";

import { useMemo, useState } from "react";

import type { DigestRow } from "@/lib/attendance/digest-service.ts";

// House rules this component is built to, not decorated with:
//   • Square edges everywhere — owner rule 2026-09-04. No rounded-* classes.
//   • Never a horizontal scroll, mobile AND desktop. There is no table here at all:
//     a day is a stacked block, so 375px needs no min-width and nothing is clipped.
//   • Text wraps; it is never truncated with an ellipsis.

type Props = {
  initialDigests: DigestRow[];
  initialError: string | null;
  showAmounts: boolean;
};

const STATUS_LABEL: Record<string, string> = {
  late: "Arrived late",
  short_hours: "Short hours",
  early_leave: "Left early",
  missing_punch: "Missing punch",
};

function formatDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    weekday: "long",
    // A date-only value: UTC is what STOPS the calendar day shifting, it is not a bug.
    timeZone: "UTC",
  }).format(date);
}

/**
 * How a money figure is shown.
 *
 * NULL is "we cannot price this day yet", never 0.00. The day is still chargeable —
 * it becomes a real month-end candidate — so printing zero would tell someone a day
 * costs them nothing when it does not.
 */
function money(value: number | null, currency = "EGP"): string {
  return value === null ? "Amount not yet calculated" : `${value.toFixed(2)} ${currency}`;
}

export function WeeklyDigestPortal({ initialDigests, initialError, showAmounts }: Props) {
  const [digests, setDigests] = useState<DigestRow[]>(initialDigests);
  const [error, setError] = useState<string | null>(initialError);
  const [busyLineId, setBusyLineId] = useState<number | null>(null);
  const [disputeFor, setDisputeFor] = useState<number | null>(null);
  const [disputeReason, setDisputeReason] = useState("");

  const open = useMemo(() => digests.filter((digest) => digest.status === "open"), [digests]);
  const settled = useMemo(() => digests.filter((digest) => digest.status !== "open"), [digests]);

  async function refresh() {
    const response = await fetch("/api/attendance/digests");
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(payload?.message ?? "Could not reload your attendance.");
      return;
    }
    setDigests(payload.digests ?? []);
  }

  async function confirm(digestId: number, lineId: number) {
    setBusyLineId(lineId);
    setError(null);
    try {
      const response = await fetch(`/api/attendance/digests/${digestId}/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineIds: [lineId] }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "Could not confirm that day.");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not confirm that day.");
    } finally {
      setBusyLineId(null);
    }
  }

  async function dispute(digestId: number, lineId: number) {
    if (!disputeReason.trim()) {
      setError("Tell us why this day is wrong.");
      return;
    }
    setBusyLineId(lineId);
    setError(null);
    try {
      const response = await fetch(`/api/attendance/digests/${digestId}/dispute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lineId, reason: disputeReason.trim() }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "Could not record that dispute.");
      setDisputeFor(null);
      setDisputeReason("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record that dispute.");
    } finally {
      setBusyLineId(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-6">
      {error ? (
        <p className="border-l-2 border-red-600 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</p>
      ) : null}

      {open.length === 0 && settled.length === 0 ? (
        <p className="border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">
          Nothing to confirm. A week with no flagged days does not produce a notice at all.
        </p>
      ) : null}

      {open.map((digest) => (
          <section key={digest.id} className="border border-slate-300 bg-white">
            <header className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-700">
                {digest.weekStart} to {digest.weekEnd}
              </h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                {digest.lines.length} {digest.lines.length === 1 ? "day" : "days"} to answer
                {showAmounts ? ` · estimated ${money(digest.totalDeductionValue, digest.currency)}` : ""}
              </p>
              {showAmounts && digest.hasUnpricedDay ? (
                <p className="mt-1 text-xs font-semibold text-slate-500">
                  One or more days cannot be priced yet, so there is no week total. The days themselves still count.
                </p>
              ) : null}
              {/* No countdown. Nothing was sent to you, so nothing runs out. */}
              {digest.dryRun ? (
                <p className="mt-1 text-xs font-bold text-slate-500">
                  Trial run — nothing is deducted from this week.
                </p>
              ) : null}
            </header>

            <ul className="divide-y divide-slate-200">
              {digest.lines.map((line) => {
                const answered = line.action !== "pending";
                const contradicting = [line.evidence?.approvedLeave, line.evidence?.crmActivity, line.evidence?.approvedExcuse]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li key={line.id} className="px-4 py-4">
                    <p className="text-sm font-bold text-slate-800">{formatDay(line.workDate)}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {STATUS_LABEL[line.status] ?? line.status}
                      {line.reason ? ` — ${line.reason}` : ""}
                    </p>
                    {showAmounts ? (
                      <p className="mt-1 text-sm font-semibold text-slate-700">
                        {line.deductionValue === null ? money(null) : `Estimated ${money(line.deductionValue)}`}
                      </p>
                    ) : null}
                    {contradicting ? (
                      <p className="mt-1 text-xs font-semibold text-emerald-700">On record for this day: {contradicting}</p>
                    ) : null}

                    {answered ? (
                      <p className="mt-3 text-xs font-black uppercase tracking-[0.12em] text-slate-500">
                        {line.action === "disputed" ? "Disputed — waiting for a decision" : "Answered"}
                      </p>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        <button
                          className="border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                          disabled={busyLineId === line.id}
                          onClick={() => confirm(digest.id, line.id)}
                          type="button"
                        >
                          That is correct
                        </button>
                        <button
                          className="border border-slate-400 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
                          disabled={busyLineId === line.id}
                          onClick={() => {
                            setDisputeFor(disputeFor === line.id ? null : line.id);
                            setDisputeReason("");
                          }}
                          type="button"
                        >
                          This is wrong
                        </button>
                      </div>
                    )}

                    {disputeFor === line.id ? (
                      <div className="mt-3 border border-slate-300 bg-slate-50 p-3">
                        <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-600" htmlFor={`reason-${line.id}`}>
                          What actually happened?
                        </label>
                        <textarea
                          className="mt-2 w-full border border-slate-300 bg-white p-2 text-sm text-slate-800"
                          dir="auto"
                          id={`reason-${line.id}`}
                          onChange={(event) => setDisputeReason(event.target.value)}
                          rows={3}
                          value={disputeReason}
                        />
                        <button
                          className="mt-2 border border-slate-800 bg-slate-800 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                          disabled={busyLineId === line.id}
                          onClick={() => dispute(digest.id, line.id)}
                          type="button"
                        >
                          Send dispute
                        </button>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

      {settled.length ? (
        <section className="border border-slate-200 bg-white">
          <header className="border-b border-slate-200 px-4 py-3">
            <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-500">Earlier weeks</h2>
          </header>
          <ul className="divide-y divide-slate-200">
            {settled.map((digest) => (
              <li key={digest.id} className="px-4 py-3">
                <p className="text-sm font-semibold text-slate-700">
                  {digest.weekStart} to {digest.weekEnd}
                </p>
                <p className="text-xs text-slate-500">
                  {digest.lines.length} {digest.lines.length === 1 ? "day" : "days"}
                  {showAmounts ? ` · ${money(digest.totalDeductionValue, digest.currency)}` : ""}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
