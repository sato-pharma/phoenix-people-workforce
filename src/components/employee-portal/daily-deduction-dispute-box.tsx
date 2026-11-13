"use client";

import Link from "next/link";
import { useState } from "react";
import { MessageSquare, Send } from "lucide-react";

import { Button } from "@/components/ui/button";
import { phxFieldClassName } from "@/components/ui/form-tokens";
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
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    const body = draft.trim();
    if (!body) {
      setError("Write why you dispute it first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/daily-deductions/disputes", {
        body: JSON.stringify({ body, lineId }),
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
      setDraft("");
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
            If this is wrong, say why. If the dispute is accepted, the deduction is cancelled and those days are never
            charged; if it is rejected, the deduction is taken at month end.
          </p>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input
              className={`${phxFieldClassName} flex-1`}
              maxLength={2000}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="Why is this deduction wrong?"
              value={draft}
            />
            <Button className="h-10 gap-2" disabled={saving} onClick={() => void send()} type="button">
              {saving ? (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/70 border-t-transparent" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              Dispute
            </Button>
          </div>
        </>
      )}
      {error ? <p className="mt-2 text-xs font-semibold text-rose-600">{error}</p> : null}
    </div>
  );
}
