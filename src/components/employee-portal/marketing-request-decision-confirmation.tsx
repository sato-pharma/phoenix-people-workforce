"use client";

import { useState } from "react";
import Link from "next/link";

import type {
  MarketingRequestDecision,
  MarketingRequestDecisionSummary,
} from "@/lib/marketing-requests/service";

function decisionLabel(decision: MarketingRequestDecision) {
  if (decision === "approve") return "Approve";
  if (decision === "reject") return "Reject";
  return "Return";
}

export function MarketingRequestDecisionConfirmation({
  detailsHref = "/employee-portals/marketing-requests",
  summary,
}: {
  detailsHref?: string;
  summary: MarketingRequestDecisionSummary;
}) {
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const needsReason = summary.decision === "reject" || summary.decision === "return";
  const actionLabel = summary.decisionLabels?.[summary.decision] ?? decisionLabel(summary.decision);
  const rejectBlocked = summary.decision === "reject" && summary.allowReject === false;

  async function submitDecision() {
    setError(null);
    setSuccess(null);
    const decisionComment = comment.trim();
    if (needsReason && !decisionComment) {
      setError(`${actionLabel} reason is required.`);
      return;
    }

    setIsPending(true);
    try {
      const response = await fetch(`/api/marketing-requests/${encodeURIComponent(summary.requestId)}/decision`, {
        body: JSON.stringify({
          comment: needsReason ? decisionComment : null,
          decision: summary.decision,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof payload.message === "string" ? payload.message : "Marketing request decision failed.");
      }
      setSuccess(`Marketing request ${summary.decision === "approve" ? "approved" : summary.decision === "reject" ? "rejected" : "returned"} successfully.`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Marketing request decision failed.");
    } finally {
      setIsPending(false);
    }
  }

  return (
    <section className="mx-auto flex min-h-screen w-full max-w-3xl flex-col justify-center px-4 py-10">
      <div className="border border-slate-200 bg-white p-6 shadow-sm">
        <p className="text-xs font-black uppercase tracking-[0.16em] text-orange-600">Phoenix Marketing Workflow</p>
        <h1 className="mt-2 text-2xl font-black text-slate-950">{actionLabel} marketing request</h1>
        <p className="mt-2 text-sm font-medium text-slate-600">
          Confirm inside Phoenix. Telegram and email only opened this page and cannot record decisions directly.
        </p>

        <div className="mt-6 grid gap-3 border-y border-slate-200 py-5 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-bold uppercase text-slate-500">Request</p>
            <p className="mt-1 font-bold text-slate-950">{summary.requestCode}</p>
            <p className="text-slate-500">{summary.requestType}</p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-slate-500">Requester</p>
            <p className="mt-1 font-bold text-slate-950">{summary.requesterName}</p>
            <p className="text-slate-500">{summary.requesterHrId}</p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-slate-500">Current step</p>
            <p className="mt-1 font-bold text-slate-950">{summary.currentStepName}</p>
            <p className="text-slate-500">Assigned to {summary.assignedApproverHrId}</p>
          </div>
          <div>
            <p className="text-xs font-bold uppercase text-slate-500">Status</p>
            <p className="mt-1 font-bold text-slate-950">{summary.status.replace(/_/g, " ")}</p>
            <p className="text-slate-500">Pay date {summary.payDate}</p>
          </div>
        </div>

        {needsReason ? (
          <label className="mt-5 block">
            <span className="text-sm font-bold text-slate-800">{actionLabel} reason</span>
            <textarea
              className="mt-2 min-h-28 w-full border border-slate-300 px-3 py-2 text-sm outline-none focus:border-orange-500"
              disabled={isPending || Boolean(success)}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Write the reason that will be saved in Phoenix audit history."
              value={comment}
            />
          </label>
        ) : null}

        {error ? <p className="mt-4 border border-rose-200 bg-rose-50 p-3 text-sm font-bold text-rose-700">{error}</p> : null}
        {success ? <p className="mt-4 border border-emerald-200 bg-emerald-50 p-3 text-sm font-bold text-emerald-700">{success}</p> : null}

        {rejectBlocked ? (
          <p className="mt-6 border border-amber-200 bg-amber-50 p-3 text-sm font-bold text-amber-700">
            This step cannot reject the request. Use Return with a note to send it back for changes.
          </p>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-3">
          {rejectBlocked ? null : (
            <button
              className={summary.decision === "approve"
                ? "bg-emerald-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50"
                : "bg-rose-600 px-4 py-2 text-sm font-black text-white disabled:opacity-50"}
              disabled={isPending || Boolean(success)}
              onClick={() => void submitDecision()}
              type="button"
            >
              {isPending ? "Submitting..." : `${actionLabel} in Phoenix`}
            </button>
          )}
          <Link className="border border-slate-300 px-4 py-2 text-sm font-black text-slate-700" href={detailsHref}>
            View details
          </Link>
        </div>
      </div>
    </section>
  );
}
