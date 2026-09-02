"use client";

import { useState } from "react";
import { AlertTriangle, Check, X } from "lucide-react";

export type AdminPrivateCalendarDispute = {
  adminDecisionNote: string | null;
  adminHrId: string | null;
  claimSourceText: string;
  claimText: string;
  createdAt: string;
  decidedAt: string | null;
  disputeDate: string;
  displayedSummary: string;
  employeeHrId: string;
  employeeName: string | null;
  id: string;
  itemSource: string | null;
  itemSourceRecordId: string | null;
  status: "pending_review" | "accepted" | "rejected";
};

// DATE-ONLY (a calendar-item date, a `date` column), which `new Date` parses as UTC midnight. UTC here
// is CORRECT and must stay: it is what stops the calendar day being shifted by a zone offset. Not an
// instant — do not "fix" this one to Cairo.
function formatDate(iso: string) {
  const date = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en", { day: "2-digit", month: "short", timeZone: "UTC", year: "numeric" }).format(date);
}

export function PrivateCalendarDisputesWorkspace({
  initialDisputes,
  initialError,
}: {
  initialDisputes: AdminPrivateCalendarDispute[];
  initialError: string | null;
}) {
  const [disputes, setDisputes] = useState(initialDisputes);
  const [error, setError] = useState(initialError);
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [noteById, setNoteById] = useState<Record<string, string>>({});
  const [submittingId, setSubmittingId] = useState<string | null>(null);

  async function decide(disputeId: string, decision: "accept" | "reject") {
    const note = (noteById[disputeId] ?? "").trim();
    if (!note) {
      setError("A decision note is required.");
      return;
    }
    setError(null);
    setSubmittingId(disputeId);
    try {
      const response = await fetch(`/api/private-calendar/disputes/${disputeId}/decide`, {
        body: JSON.stringify({ decision, note }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) throw new Error(payload.message || "Unable to decide this dispute.");
      setDisputes((current) => current.filter((dispute) => dispute.id !== disputeId));
      setDecidingId(null);
    } catch (decideError) {
      setError(decideError instanceof Error ? decideError.message : "Unable to decide this dispute.");
    } finally {
      setSubmittingId(null);
    }
  }

  return (
    <section className="border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 bg-slate-900 px-5 py-3">
        <h2 className="text-xs font-black uppercase tracking-[0.14em] text-white">
          {disputes.length} review request{disputes.length === 1 ? "" : "s"} pending
        </h2>
      </div>

      {error ? (
        <div className="flex items-center gap-2 border-b border-red-200 bg-red-50 px-5 py-3 text-sm font-semibold text-red-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          {error}
        </div>
      ) : null}

      {disputes.length === 0 ? (
        <div className="p-10 text-center">
          <p className="text-sm font-bold text-slate-500">No review requests are waiting.</p>
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          {disputes.map((dispute) => (
            <div className="px-5 py-4" key={dispute.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="whitespace-nowrap font-mono text-phx-xs font-semibold text-slate-500">{formatDate(dispute.disputeDate)}</span>
                <span className="whitespace-nowrap rounded-sm bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-700">
                  {dispute.employeeName ?? dispute.employeeHrId} ({dispute.employeeHrId})
                </span>
                {dispute.itemSource ? (
                  <span className="whitespace-nowrap rounded-sm bg-indigo-100 px-2 py-0.5 text-phx-xs font-semibold text-indigo-700">
                    {dispute.itemSource}
                  </span>
                ) : (
                  <span className="whitespace-nowrap rounded-sm bg-slate-100 px-2 py-0.5 text-phx-xs font-semibold text-slate-500">
                    whole day
                  </span>
                )}
              </div>

              <div className="mt-3 grid gap-3 md:grid-cols-3">
                <div>
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Currently shown</p>
                  <p className="mt-1 text-sm font-semibold text-slate-700">{dispute.displayedSummary}</p>
                </div>
                <div>
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Employee claim</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{dispute.claimText}</p>
                </div>
                <div>
                  <p className="text-phx-xs font-black uppercase tracking-[0.1em] text-slate-400">Where to verify</p>
                  <p className="mt-1 text-sm font-semibold text-slate-900">{dispute.claimSourceText}</p>
                </div>
              </div>

              {decidingId === dispute.id ? (
                <div className="mt-3 rounded-sm border border-slate-200 bg-slate-50 p-3">
                  <textarea
                    className="w-full rounded-sm border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-orange-400 focus:outline-none"
                    onChange={(event) => setNoteById((current) => ({ ...current, [dispute.id]: event.target.value }))}
                    placeholder="Decision note (required — what you found when you checked)"
                    rows={2}
                    value={noteById[dispute.id] ?? ""}
                  />
                  <div className="mt-2 flex items-center gap-2">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-sm bg-emerald-600 px-3 py-1.5 text-xs font-black text-white transition hover:bg-emerald-700 disabled:opacity-50"
                      disabled={submittingId === dispute.id}
                      onClick={() => decide(dispute.id, "accept")}
                      type="button"
                    >
                      <Check className="h-3.5 w-3.5" />
                      Accept
                    </button>
                    <button
                      className="inline-flex items-center gap-1.5 rounded-sm bg-red-600 px-3 py-1.5 text-xs font-black text-white transition hover:bg-red-700 disabled:opacity-50"
                      disabled={submittingId === dispute.id}
                      onClick={() => decide(dispute.id, "reject")}
                      type="button"
                    >
                      <X className="h-3.5 w-3.5" />
                      Reject
                    </button>
                    <button
                      className="rounded-sm border border-slate-300 px-3 py-1.5 text-xs font-black text-slate-600 transition hover:bg-slate-100"
                      onClick={() => setDecidingId(null)}
                      type="button"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <button
                  className="mt-3 rounded-sm border border-slate-300 px-3 py-1.5 text-xs font-black text-slate-700 transition hover:bg-slate-100"
                  onClick={() => setDecidingId(dispute.id)}
                  type="button"
                >
                  Review
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
