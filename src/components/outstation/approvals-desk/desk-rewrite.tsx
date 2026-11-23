"use client";

import { LoaderCircle, PenLine, Undo2 } from "lucide-react";
import { useState } from "react";

import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { formatDateValue, formatNumberValue } from "@/lib/i18n/format";
import { tripDayCount } from "@/lib/outstation/approvals/desk-view";
import type { DeskClaim } from "@/lib/outstation/approvals/types";
import { displayPlace } from "@/lib/outstation/place-label";

import { PHONE_TARGET, egp, travelLabel } from "./desk-parts";

/**
 * Only the figures already on the screen are offered to the rewrite, so the note can cite the
 * deduction without anything being able to invent one.
 */
export function noteFacts(claim: DeskClaim, amountToPay: number | null): Array<{ label: string; value: string }> {
  const days = tripDayCount(claim);
  return [
    { label: "Claimed total", value: egp(claim.total) },
    ...(amountToPay !== null ? [{ label: "Approved amount", value: egp(amountToPay) }, { label: "Deduction", value: egp(Math.max(0, claim.total - amountToPay)) }] : []),
    { label: "Trip start", value: formatDateValue(claim.tripStart) },
    { label: "Trip end", value: formatDateValue(claim.tripEnd) },
    { label: "Trip length", value: `${formatNumberValue(days)} ${days === 1 ? "day" : "days"}` },
    { label: "From", value: displayPlace(claim.from) },
    { label: "To", value: displayPlace(claim.to) },
    ...(travelLabel(claim.transportation) ? [{ label: "Travelled by", value: travelLabel(claim.transportation) }] : []),
  ];
}

/**
 * "Rewrite formally" — turns the reason he typed, in any mix of Arabic and English, into the formal
 * sentence the employee reads. It changes the text in the box and nothing else: no decision is made
 * and nothing is saved until he presses Reject or Reduce himself. "Restore my wording" puts his own
 * text back.
 */
export function RewriteFormally({
  facts,
  onChange,
  outcome,
  value,
}: {
  facts: Array<{ label: string; value: string }>;
  onChange: (next: string) => void;
  outcome: "adjusted" | "rejected";
  value: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previous, setPrevious] = useState<string | null>(null);

  async function rewrite() {
    const draft = value.trim();
    if (!draft || busy) return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/admin/outstation/expenses/note-assist", {
        body: JSON.stringify({ draft, facts, outcome }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const payload = (await response.json().catch(() => null)) as { message?: string; note?: string } | null;
      if (!response.ok || typeof payload?.note !== "string" || !payload.note.trim()) {
        setError(payload?.message || "The reason could not be rewritten. Your own wording is still in the box.");
        return;
      }
      setPrevious(draft);
      onChange(payload.note.trim());
    } catch {
      setError("Could not reach the server. Your own wording is still in the box.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" data-rewrite-formally>
      <button className={approvalActionClassName("neutral", "dense", PHONE_TARGET)} disabled={busy || !value.trim()} onClick={() => void rewrite()} title="Rewrite this reason as a formal note for the employee" type="button">
        {busy ? <LoaderCircle aria-hidden className="h-3.5 w-3.5 shrink-0 animate-spin" /> : <PenLine aria-hidden className="h-3.5 w-3.5 shrink-0" />}
        {busy ? "Rewriting" : "Rewrite formally"}
      </button>
      {previous !== null ? (
        <button
          className={approvalActionClassName("neutral", "dense", PHONE_TARGET)}
          onClick={() => {
            onChange(previous);
            setPrevious(null);
          }}
          type="button"
        >
          <Undo2 aria-hidden className="h-3.5 w-3.5 shrink-0" /> Restore my wording
        </button>
      ) : null}
      {error ? (
        <p className="min-w-0 basis-full break-words text-xs font-semibold text-rose-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
