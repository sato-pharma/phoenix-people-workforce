"use client";

/**
 * Phoenix CRM — the visits this phone is holding, on the rep's Visits screen.
 *
 * 🔴 GOLDEN RULE #1. Everything here is about THE REP'S work and what they can do next. Not a word about a check, a
 * distance, a clock or lateness: the sentences are the constants in `visit-resend-rules.ts`, and the only other
 * words on this screen are the server's own, less any about where the rep stands (`heldRefusalSentence`).
 */

import { CrmBlock, CrmButton, CrmNote, CrmPill } from "@/components/phoenix-crm/ui";
import { forgetHeldVisit, reportVisitResend } from "@/components/phoenix-crm/visit-outbox-client";
import {
  heldRefusalSentence,
  VISIT_LOG_AGAIN,
  VISIT_REFUSED_TITLE,
  VISIT_REMOVE,
  VISIT_TOO_LATE_TITLE,
  VISIT_WAITING_LINE,
  VISIT_WAITING_PILL,
  type QueuedVisit,
} from "@/lib/phoenix-crm/visit-resend-rules";

export function VisitOutboxNote({
  entries,
  onLogAgain,
  ownerHrId,
}: {
  entries: readonly QueuedVisit[];
  onLogAgain: (entry: QueuedVisit) => void;
  ownerHrId: string;
}) {
  if (entries.length === 0) return null;

  const waiting = entries.filter((entry) => entry.status === "waiting");
  const stuck = entries.filter((entry) => entry.status !== "waiting");
  const sentenceOf = (entry: QueuedVisit) => (entry.status === "refused" ? heldRefusalSentence(entry.refusalMessage) : null);

  return (
    <CrmBlock className="border-b border-slate-100">
      <div className="grid min-w-0 gap-3">
        {waiting.length > 0 ? (
          <div className="grid min-w-0 gap-2">
            <ul className="grid min-w-0 gap-1.5">
              {waiting.map((entry) => (
                <li className="flex min-w-0 flex-wrap items-center justify-between gap-2 border border-slate-200 bg-white px-3 py-2.5" key={entry.visitId}>
                  <span className="min-w-[9rem] flex-1 break-words text-sm font-black text-slate-950">{entry.customerName}</span>
                  <CrmPill tone="orange">{VISIT_WAITING_PILL}</CrmPill>
                </li>
              ))}
            </ul>
            <p className="text-xs font-semibold text-slate-600">{VISIT_WAITING_LINE}</p>
          </div>
        ) : null}
        {stuck.map((entry) => (
          <CrmNote key={entry.visitId} title={entry.status === "refused" ? VISIT_REFUSED_TITLE : VISIT_TOO_LATE_TITLE} tone="warn">
            <p className="font-black">{entry.customerName}</p>
            {sentenceOf(entry) ? <p>{sentenceOf(entry)}</p> : null}
            <div className="mt-2 flex flex-wrap gap-2">
              <CrmButton onClick={() => onLogAgain(entry)} size="sm" variant="primary">
                {VISIT_LOG_AGAIN}
              </CrmButton>
              <CrmButton
                onClick={() => {
                  forgetHeldVisit(ownerHrId, entry.visitId);
                  reportVisitResend(entry, "removed");
                }}
                size="sm"
                variant="ghost"
              >
                {VISIT_REMOVE}
              </CrmButton>
            </div>
          </CrmNote>
        ))}
      </div>
    </CrmBlock>
  );
}
