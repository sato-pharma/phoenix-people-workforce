"use client";

import { Pencil } from "lucide-react";
import { useId, useState } from "react";

import { approvalActionClassName } from "@/components/approvals-hub/approval-action-kit";
import { CrmField, CrmNote, crmInputClassName, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { AMOUNTS_REASON_MAX, amountsDraft, amountsOpen, currentParts, draftParts, typedPart } from "@/lib/outstation/approvals/amounts-plan";
import type { DeskClaim, DeskDecisionOutcome } from "@/lib/outstation/approvals/types";
import { EXPENSE_PART_KEYS, EXPENSE_PART_LABEL, partsTotal, sameParts } from "@/lib/outstation/hr-amounts";
import { cn } from "@/lib/utils";

import { egp } from "./desk-parts";

export { amountsOpen };

/** A claim whose amounts were saved, before and after — what the workspace moves its tiles by. */
export type OnEdited = (before: DeskClaim | null, after: DeskClaim) => void;

const ROUTE = "/api/admin/outstation/approvals/amounts";

/** One line of the parts: the part, what was claimed, what it pays — fixed shares, so it fits a phone. */
const ROW = "grid min-w-0 grid-cols-[minmax(0,1fr)_30%_34%] items-center gap-x-2 py-1.5 [&>*]:min-w-0";

/**
 * The amounts box on the opened trip — the Super Admin's own figures, part by part (owner, 24 Nov
 * 2026: "i want to be able to edit in expense value"; asked which edit: "All of these" — each part,
 * on a waiting and a decided claim, any figure, above the claim too, until a payroll takes it).
 *
 * Closed, it is one line: what the trip pays and, when the figures were edited, that they were and
 * why. Open, each part stands beside what the employee claimed, the new total follows the typing,
 * and "Save amounts" needs a reason. Saving is its own press: it decides nothing, and the employee
 * is not told (as with a reduced amount). The server re-reads the claim and judges it again
 * (approvals/amounts.ts); a claim that moved meanwhile comes back with its new figures.
 */
export function DeskAmounts({ claim, disabled, onSaved }: { claim: DeskClaim; disabled: boolean; onSaved: (after: DeskClaim) => void }) {
  const id = useId();
  const parts = claim.parts;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => (parts ? amountsDraft(parts) : null));
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ message: string; tone: "bad" | "good" } | null>(null);
  // The claim read again (after a save, or a change somewhere else): the boxes open on its figures.
  const [seenRevision, setSeenRevision] = useState(claim.revision);
  if (seenRevision !== claim.revision) {
    setSeenRevision(claim.revision);
    if (!open && parts) setDraft(amountsDraft(parts));
  }

  if (!parts || !draft) return null;
  const now = currentParts(parts);
  const typed = draftParts(draft);
  const total = typed ? partsTotal(typed) : null;
  const unchanged = typed !== null && sameParts(typed, now);
  const aboveClaim = total !== null && total > parts.claimedTotal + 0.004;
  const canSave = !disabled && !saving && typed !== null && !unchanged && reason.trim().length > 0;

  const close = () => {
    setOpen(false);
    setDraft(amountsDraft(parts));
    setReason("");
  };

  const save = async () => {
    if (!typed || !canSave) return;
    setSaving(true);
    setNote(null);
    try {
      const response = await fetch(ROUTE, {
        body: JSON.stringify({ parts: typed, reason: reason.trim(), requestId: claim.requestId, revision: claim.revision }),
        headers: { accept: "application/json", "content-type": "application/json" },
        method: "POST",
      });
      const body = (await response.json().catch(() => null)) as { message?: string; outcome?: DeskDecisionOutcome } | null;
      const outcome = body?.outcome;
      if (!response.ok || !outcome) {
        setNote({ message: body?.message || "The amounts were not saved. Nothing changed.", tone: "bad" });
        return;
      }
      if (outcome.claim) onSaved(outcome.claim);
      if (outcome.code === "saved") {
        setNote({ message: `Saved. The trip now pays ${egp(outcome.claim?.payable ?? total ?? 0)}.`, tone: "good" });
        setOpen(false);
        setReason("");
        return;
      }
      setNote({ message: outcome.message || "The amounts were not saved. Nothing changed.", tone: "bad" });
    } catch {
      setNote({ message: "Could not reach the server, so it is not known whether the amounts were saved. Read the trip again.", tone: "bad" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="min-w-0 border border-slate-200 bg-white" data-trip-sheet="amounts">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-slate-200 px-4 py-2">
        <h3 className="min-w-0 break-words text-sm font-black text-slate-950">
          <span aria-hidden className="mr-2 inline-block h-2 w-2 bg-orange-500 align-middle" />
          Amounts
        </h3>
        {!open ? (
          <button className={approvalActionClassName("neutral", "regular")} data-amounts-open disabled={disabled} onClick={() => setOpen(true)} type="button">
            <Pencil aria-hidden className="h-4 w-4" />
            Edit amounts
          </button>
        ) : null}
      </div>
      <div className="grid min-w-0 gap-3 px-4 py-3">
        {note ? <CrmNote tone={note.tone === "bad" ? "bad" : "good"}>{note.message}</CrmNote> : null}
        {parts.edited && !open ? (
          <p className="min-w-0 break-words border-l-[3px] border-l-orange-400 bg-slate-50 px-3 py-2 text-sm text-slate-800" data-amounts-edited>
            <span className="block text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">
              Edited from the claim of {egp(parts.claimedTotal)}
            </span>
            <bdi dir="auto">{parts.edited.reason || "No reason was kept."}</bdi>
          </p>
        ) : null}

        {/* Rows, not a table: three short facts per part fit a phone as they stand (the trip sheet's
            own grids, desk-days.tsx), so there is no second phone layout to keep in step. */}
        <div className="grid min-w-0 text-sm" data-amounts-parts role="group" aria-label="Amounts by part">
          <div aria-hidden className={cn(ROW, "border-b border-slate-200 text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500")}>
            <span>Part</span>
            <span className="text-right">Claimed</span>
            <span className="text-right">{open ? "Pay" : "Pays"}</span>
          </div>
          {EXPENSE_PART_KEYS.map((key) => {
            const inputId = `${id}-${key}`;
            const bad = open && typedPart(draft[key]) === null;
            return (
              <div className={cn(ROW, "border-b border-slate-100")} data-amounts-part={key} key={key}>
                <span className="break-words font-bold text-slate-800">
                  {open ? <label htmlFor={inputId}>{EXPENSE_PART_LABEL[key]}</label> : EXPENSE_PART_LABEL[key]}
                </span>
                <span className="break-words text-right tabular-nums text-slate-500">
                  <span className="sr-only">Claimed </span>
                  {egp(parts.claimed[key])}
                </span>
                <span className="text-right">
                  {open ? (
                    <input
                      aria-invalid={bad || undefined}
                      autoComplete="off"
                      className={cn(crmInputClassName, "text-right tabular-nums")}
                      id={inputId}
                      inputMode="decimal"
                      onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
                      value={draft[key]}
                    />
                  ) : (
                    <span className={cn("break-words font-black tabular-nums", now[key] !== parts.claimed[key] ? "text-orange-700" : "text-slate-950")}>
                      <span className="sr-only">Pays </span>
                      {egp(now[key])}
                    </span>
                  )}
                </span>
              </div>
            );
          })}
          <div className={ROW}>
            <span className="font-black text-slate-950">Total</span>
            <span className="break-words text-right tabular-nums text-slate-500">
              <span className="sr-only">Claimed </span>
              {egp(parts.claimedTotal)}
            </span>
            <span className="break-words text-right font-black tabular-nums text-slate-950" data-amounts-total>
              {open ? (total === null ? "Type a figure in each part" : egp(total)) : egp(partsTotal(now))}
            </span>
          </div>
        </div>

        {open ? (
          <>
            {aboveClaim ? (
              <p className="min-w-0 break-words text-xs font-bold text-amber-800" data-amounts-above>
                This pays {egp((total ?? 0) - parts.claimedTotal)} more than the employee claimed.
              </p>
            ) : null}
            <CrmField hint="Kept on the claim and in the record. The employee is not told." htmlFor={`${id}-reason`} label="Reason">
              <textarea
                className={cn(crmTextareaClassName, "min-h-16")}
                dir="auto"
                id={`${id}-reason`}
                maxLength={AMOUNTS_REASON_MAX}
                onChange={(event) => setReason(event.target.value)}
                value={reason}
              />
            </CrmField>
            <div className="flex min-w-0 flex-wrap gap-2">
              <button className={approvalActionClassName("confirm", "regular")} data-amounts-save disabled={!canSave} onClick={() => void save()} type="button">
                {saving ? "Saving" : total !== null && !unchanged ? `Save amounts · ${egp(total)}` : "Save amounts"}
              </button>
              <button className={approvalActionClassName("neutral", "regular")} disabled={saving} onClick={close} type="button">
                Cancel
              </button>
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}
