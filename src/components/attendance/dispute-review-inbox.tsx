"use client";

import { useState } from "react";

import type { PendingDispute } from "@/lib/attendance/digest-service.ts";

// Square edges (owner rule 2026-09-04) and no horizontal scroll at any width: each
// dispute is a stacked block rather than a table, so nothing needs a min-width and
// nothing is clipped on a phone.
//
// The evidence panel is the point of this screen. The 2026-07 module showed a
// reviewer "late 207 min, 419.35 EGP" and nothing else, and four wrong deductions
// were approved on 2026-08-05 because the CRM entry explaining the day never
// reached the page. Here it is on the row, above the buttons.

type Props = {
  initialDisputes: PendingDispute[];
  initialError: string | null;
};

const EVIDENCE_LABEL: Record<string, string> = {
  approvedLeave: "Approved vacation / leave",
  approvedExcuse: "Approved excuse",
  crmActivity: "CRM activity",
  weeklyPlan: "Weekly plan",
  firstPunch: "First punch",
  lastPunch: "Last punch",
};

export function DisputeReviewInbox({ initialDisputes, initialError }: Props) {
  const [disputes, setDisputes] = useState<PendingDispute[]>(initialDisputes);
  const [error, setError] = useState<string | null>(initialError);
  const [busyLineId, setBusyLineId] = useState<number | null>(null);
  const [notesByLine, setNotesByLine] = useState<Record<number, string>>({});

  async function decide(lineId: number, uphold: boolean) {
    setBusyLineId(lineId);
    setError(null);
    try {
      const response = await fetch(`/api/attendance/disputes/${lineId}/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ uphold, notes: notesByLine[lineId] ?? "" }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message ?? "Could not record that decision.");
      setDisputes((current) => current.filter((dispute) => dispute.lineId !== lineId));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not record that decision.");
    } finally {
      setBusyLineId(null);
    }
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <header>
        <h1 className="text-lg font-black uppercase tracking-[0.12em] text-slate-800">Attendance disputes</h1>
        <p className="mt-1 text-sm text-slate-600">
          A disputed day never settles on its own. Until it is decided here it stays out of payroll and arrives in the
          month-end Deductions queue as pending.
        </p>
      </header>

      {error ? (
        <p className="border-l-2 border-red-600 bg-red-50 px-4 py-3 text-sm font-semibold text-red-800">{error}</p>
      ) : null}

      {disputes.length === 0 ? (
        <p className="border border-slate-200 bg-white px-4 py-6 text-sm text-slate-600">Nothing waiting.</p>
      ) : null}

      {disputes.map((dispute) => {
        const evidence = Object.entries(dispute.evidence ?? {}).filter(([, value]) => String(value ?? "").trim());
        return (
          <section key={dispute.lineId} className="border border-slate-300 bg-white">
            <header className="border-b border-slate-200 px-4 py-3">
              <h2 className="text-sm font-black uppercase tracking-[0.12em] text-slate-700">
                {dispute.employeeHrId} · {dispute.workDate}
              </h2>
              <p className="mt-1 text-xs font-semibold text-slate-500">
                {dispute.deductionDays} day ·{" "}
                {dispute.deductionValue === null
                  ? "amount not yet calculated (no salary on file)"
                  : `${dispute.deductionValue.toFixed(2)} EGP`}{" "}
                · {dispute.reason}
              </p>
            </header>

            <div className="px-4 py-3">
              <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">What they said</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-slate-800" dir="auto">
                {dispute.disputeReason ?? "(no reason given)"}
              </p>
            </div>

            {evidence.length ? (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">On record for this day</p>
                <dl className="mt-2 flex flex-col gap-1">
                  {evidence.map(([key, value]) => (
                    <div className="flex flex-wrap gap-x-2 text-sm" key={key}>
                      <dt className="font-semibold text-slate-600">{EVIDENCE_LABEL[key] ?? key}:</dt>
                      <dd className="text-slate-800" dir="auto">
                        {String(value)}
                      </dd>
                    </div>
                  ))}
                </dl>
              </div>
            ) : (
              <div className="border-t border-slate-200 bg-slate-50 px-4 py-3">
                <p className="text-sm text-slate-600">
                  Nothing on record contradicts this charge — no approved leave, excuse, or CRM activity for the day.
                </p>
              </div>
            )}

            <div className="border-t border-slate-200 px-4 py-3">
              <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-600" htmlFor={`note-${dispute.lineId}`}>
                Note to the employee (optional)
              </label>
              <textarea
                className="mt-2 w-full border border-slate-300 bg-white p-2 text-sm text-slate-800"
                dir="auto"
                id={`note-${dispute.lineId}`}
                onChange={(event) =>
                  setNotesByLine((current) => ({ ...current, [dispute.lineId]: event.target.value }))
                }
                rows={2}
                value={notesByLine[dispute.lineId] ?? ""}
              />
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className="border border-emerald-700 bg-emerald-700 px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-white disabled:opacity-50"
                  disabled={busyLineId === dispute.lineId}
                  onClick={() => decide(dispute.lineId, true)}
                  type="button"
                >
                  Accept — no deduction
                </button>
                <button
                  className="border border-slate-400 bg-white px-3 py-2 text-xs font-black uppercase tracking-[0.12em] text-slate-700 disabled:opacity-50"
                  disabled={busyLineId === dispute.lineId}
                  onClick={() => decide(dispute.lineId, false)}
                  type="button"
                >
                  Reject — the day stands
                </button>
              </div>
            </div>
          </section>
        );
      })}
    </div>
  );
}
