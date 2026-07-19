"use client";

import { useState } from "react";
import { CheckCircle2, Gavel, XCircle } from "lucide-react";

import { AdminCallout, AdminInsightChip, AdminPageHero, AdminTableShell } from "@/components/admin/admin-design-system";
import { Button } from "@/components/ui/button";
import type { OpenDisputeView } from "@/lib/attendance/digest-read";

type Props = {
  initialDisputes: OpenDisputeView[];
  initialError: string | null;
};

// iso is a plain YYYY-MM-DD calendar date (no real instant semantics) — anchor
// construction and display to explicit UTC so this never depends on the runtime's
// implicit default (matches the pattern used elsewhere for date-only values).
function formatDate(iso: string) {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

export function DisputeReviewInbox({ initialDisputes, initialError }: Props) {
  const [disputes, setDisputes] = useState(initialDisputes);
  const [error, setError] = useState<string | null>(initialError);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyLineId, setBusyLineId] = useState<number | null>(null);
  const [notesByLine, setNotesByLine] = useState<Record<number, string>>({});

  async function review(dispute: OpenDisputeView, decision: "upheld" | "rejected") {
    setBusyLineId(dispute.id);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/attendance/disputes/${dispute.id}/review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision, digestId: dispute.digestId, notes: notesByLine[dispute.id]?.trim() || null }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.message ?? "Dispute review failed.");
      setDisputes((current) => current.filter((entry) => entry.id !== dispute.id));
      setNotice(`Dispute ${decision} for ${dispute.employeeHrId} (${formatDate(dispute.workDate)}).`);
    } catch (reviewError) {
      setError(reviewError instanceof Error ? reviewError.message : "Dispute review failed.");
    } finally {
      setBusyLineId(null);
    }
  }

  return (
    <div className="space-y-5">
      <AdminPageHero
        badges={<AdminInsightChip tone="orange">{disputes.length} open</AdminInsightChip>}
        description="Attendance settlement disputes awaiting HR Manager or System Admin review. Either reviewer may act — first decision wins."
        eyebrow="Attendance"
        icon={<Gavel className="h-3.5 w-3.5" />}
        title="Dispute Review"
      />

      {error ? <AdminCallout tone="danger">{error}</AdminCallout> : null}
      {notice ? <AdminCallout tone="neutral">{notice}</AdminCallout> : null}

      <AdminTableShell description="Unresolved at the day-24 payroll cut-off defaults to salary." title="Open Disputes">
        {disputes.length === 0 ? (
          <div className="p-8 text-center text-sm font-semibold text-slate-500">No open disputes.</div>
        ) : (
          <div className="divide-y divide-slate-100">
            {disputes.map((dispute) => (
              <div className="space-y-3 p-4" key={dispute.id}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-black text-slate-950">{dispute.employeeHrId} — {formatDate(dispute.workDate)}</p>
                    <p className="text-xs font-semibold text-slate-500">
                      Week {dispute.weekIndex} &middot; {dispute.cycleKey} &middot; {dispute.status.replace("_", " ")} &middot;{" "}
                      {dispute.deductionDays} day(s) &middot; {dispute.deductionValue.toFixed(2)} EGP
                    </p>
                  </div>
                </div>
                <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                  <p className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Employee&apos;s reason</p>
                  <p className="mt-1">{dispute.disputeReason ?? "—"}</p>
                  {dispute.disputeAttachmentUrl ? (
                    <a className="mt-1 inline-block text-xs font-bold text-orange-600 underline" href={dispute.disputeAttachmentUrl} rel="noreferrer" target="_blank">
                      View attachment
                    </a>
                  ) : null}
                </div>
                <label className="block space-y-1.5">
                  <span className="text-[11px] font-black uppercase tracking-[0.14em] text-slate-500">Reviewer note (optional)</span>
                  <textarea
                    className="h-16 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-900 shadow-inner outline-none focus:border-orange-300 focus:ring-2 focus:ring-orange-100"
                    value={notesByLine[dispute.id] ?? ""}
                    onChange={(event) => setNotesByLine({ ...notesByLine, [dispute.id]: event.target.value })}
                  />
                </label>
                <div className="flex gap-2">
                  <Button disabled={busyLineId !== null} type="button" onClick={() => review(dispute, "upheld")}>
                    <CheckCircle2 className="h-4 w-4" />
                    {busyLineId === dispute.id ? "…" : "Uphold (no deduction)"}
                  </Button>
                  <Button disabled={busyLineId !== null} type="button" variant="secondary" onClick={() => review(dispute, "rejected")}>
                    <XCircle className="h-4 w-4" />
                    Reject (apply deduction)
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminTableShell>
    </div>
  );
}
