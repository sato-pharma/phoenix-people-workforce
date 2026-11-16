"use client";

import Link from "next/link";
import { useState } from "react";
import { Loader2, MessageSquare, Send } from "lucide-react";

import {
  EMPTY_EXPLAIN_DRAFT,
  ExplainReasonFields,
  explainDraftProblem,
  type ExplainReasonDraft,
} from "@/components/disputes/explain-reason-fields";
import { FormActions } from "@/components/ui/form-kit";
import { phxButtonAccentClassName } from "@/components/ui/form-tokens";
import { cn } from "@/lib/utils";

/** What the page knows about a dispute already raised on this line. */
export type DailyLineDisputeState = { id: string; status: "open" | "accepted" | "rejected" } | null;

const STATUS_WORDS: Record<"open" | "accepted" | "rejected", string> = {
  accepted: "Accepted — this deduction is cancelled and those days are not charged.",
  open: "Sent to HR — waiting for an answer.",
  rejected: "Not accepted — the deduction stands.",
};

function disputeHref(id: string) {
  return `/employee-portals/disputes?kind=daily&case=${encodeURIComponent(id)}`;
}

/**
 * The Dispute box under one released daily deduction (owner, 2026-11-13: the Deductions page showed
 * these with no Dispute button). It reads and writes nothing itself beyond the one opening: the
 * conversation after it lives in the Dispute Center, which the link opens. Same words, same field and
 * same button as the monthly ledger's box below it.
 */
export function DailyDeductionDisputeBox({ dispute, lineId }: { dispute: DailyLineDisputeState; lineId: string }) {
  const [state, setState] = useState<DailyLineDisputeState>(dispute);
  const [draft, setDraft] = useState<ExplainReasonDraft>(EMPTY_EXPLAIN_DRAFT);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const problem = explainDraftProblem(draft);
    if (problem) {
      setError(problem);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/daily-deductions/disputes", {
        body: JSON.stringify({ explanation: draft, lineId }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => ({}))) as {
        dispute?: { id: string };
        message?: string;
        success?: boolean;
      };
      if (!response.ok || !payload.success || !payload.dispute) {
        throw new Error(payload.message || "Your dispute could not be sent.");
      }
      setState({ id: payload.dispute.id, status: "open" });
      setDraft(EMPTY_EXPLAIN_DRAFT);
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : "Your dispute could not be sent.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mt-3 border-t border-slate-100 pt-3">
      <p className="flex items-center gap-2 text-xs font-black uppercase tracking-[0.14em] text-slate-400">
        <MessageSquare className="h-4 w-4" />
        {state ? "Your dispute" : "Dispute this deduction"}
      </p>
      {state ? (
        <div className="mt-1.5 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
          <p
            className={cn(
              "text-xs font-semibold",
              state.status === "accepted" ? "text-emerald-700" : state.status === "rejected" ? "text-rose-700" : "text-slate-700",
            )}
          >
            {STATUS_WORDS[state.status]}
          </p>
          <Link
            className="shrink-0 text-xs font-black uppercase tracking-[0.08em] text-orange-600 hover:text-orange-700"
            href={disputeHref(state.id)}
          >
            Open the conversation
          </Link>
        </div>
      ) : (
        <>
          <p className="mt-1.5 text-xs text-slate-600">
            Choose why those days have no record and who can confirm it. If HR accepts it, the deduction is cancelled
            and those days are never charged; if not, the deduction is taken at month end.
          </p>
          <div className="mt-4">
            <ExplainReasonFields name={`explain-daily-${lineId}`} onChange={setDraft} value={draft} />
          </div>
          <FormActions
            className="mt-5 pt-4"
            right={
              <button className={phxButtonAccentClassName} disabled={saving || !draft.reasonCode} onClick={() => void send()} type="button">
                {saving ? <Loader2 aria-hidden className="h-4 w-4 animate-spin" /> : <Send aria-hidden className="h-4 w-4" />}
                Send explanation
              </button>
            }
          />
        </>
      )}
      {error ? <p className="mt-2 text-xs font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}
