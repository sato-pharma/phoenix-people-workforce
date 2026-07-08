"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

import type { VacationEvidenceReview, VacationEvidenceReviewStatus, VacationEvidenceType } from "@/lib/vacation/types";

type Props = {
  evidenceType: VacationEvidenceType;
  existingReview: VacationEvidenceReview | null;
  requestId: string;
};

const STATUS_LABEL: Record<VacationEvidenceReviewStatus, string> = {
  accepted: "Accepted",
  needs_follow_up: "Needs follow-up",
  pending: "Pending",
  rejected: "Rejected",
};

// Lets HR accept/reject the sick/compensatory evidence attachment right here on the Approvals Hub
// request page — the same window used for Approve/Reject/Acknowledge — instead of requiring a
// separate trip to the Vacation Report to review evidence before coming back to decide.
export function VacationEvidenceReviewActions({ evidenceType, existingReview, requestId }: Props) {
  const router = useRouter();
  const [status, setStatus] = useState<VacationEvidenceReviewStatus>(existingReview?.status ?? "pending");
  const [note, setNote] = useState(existingReview?.reviewNote ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(next: "accepted" | "needs_follow_up" | "rejected") {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/vacations/requests/${encodeURIComponent(requestId)}/evidence-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ evidenceType, reviewNote: note.trim() || null, status: next }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        message?: string;
        review?: { status: VacationEvidenceReviewStatus };
        success?: boolean;
      };
      if (!res.ok || !data.success) {
        setError(data.message || "Evidence review failed.");
        return;
      }
      setStatus(data.review?.status ?? next);
      router.refresh();
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2">
      <p className="text-[11px] font-bold uppercase tracking-wide text-slate-500">
        Evidence review — <span className="text-slate-700">{STATUS_LABEL[status]}</span>
      </p>
      <textarea
        className="w-full border border-slate-300 px-3 py-2 text-sm focus:border-orange-500 focus:outline-none"
        onChange={(event) => setNote(event.target.value)}
        placeholder="HR review note"
        rows={2}
        value={note}
      />
      {error ? <p className="text-sm font-semibold text-rose-600">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <button
          className="bg-emerald-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-emerald-700 disabled:opacity-60"
          disabled={busy}
          onClick={() => submit("accepted")}
          type="button"
        >
          Accept
        </button>
        <button
          className="bg-amber-500 px-3 py-1.5 text-xs font-bold text-white hover:bg-amber-600 disabled:opacity-60"
          disabled={busy}
          onClick={() => submit("needs_follow_up")}
          type="button"
        >
          Needs follow-up
        </button>
        <button
          className="bg-rose-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-rose-700 disabled:opacity-60"
          disabled={busy}
          onClick={() => submit("rejected")}
          type="button"
        >
          Reject
        </button>
      </div>
    </div>
  );
}
