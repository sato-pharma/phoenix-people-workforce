"use client";

/**
 * Phoenix CRM — settling one location-integrity case, on the board itself.
 *
 * For a fortnight the board could only be READ: its own header said so, and said why — "the table has
 * no resolution column, so the only way to clear a flag today is to delete the row". The columns exist
 * now (migration 20261009190708) and this is the only thing that writes them.
 *
 * 🔴 IT IS THE SUPER ADMIN'S BUTTON ALONE (owner, 2026-10-09: keep the signboard cases to the Super
 * Admin). The SFE Manager reads the same board and this component is not rendered for him — and that
 * is only the second gate: the route asks `phoenix_crm.update` and the service refuses anyone else
 * before it reads a row, so a mistake here cannot become a settled case.
 *
 * 🔴 A NOTE IS REQUIRED TO SETTLE, AND NOT TO REOPEN. Closing a case about a named person is the
 * decision that has to be answerable months later; deciding to look at it again is not, and asking
 * for a reason would be a reason not to look.
 *
 * NOTHING IS DELETED and nobody is told. The row keeps its flags, its signals and its evidence; the
 * rep is never told he was flagged, so he cannot be told a flag about him was closed either.
 *
 * The skin is the system's: `crmTextareaClassName` is `phxTextareaClassName`, and the buttons are
 * `CrmButton` — no border, radius, height or focus ring is written here (the one form design, owner
 * 2026-10-06).
 *
 * 🔴 IT LIVES HERE AND NOT IN `src/components/phoenix-crm/`, WHICH IS THE REP'S OWN BUNDLE. Every
 * file under that directory is swept by the blind-half guard and may not so much as say "integrity":
 * the rep is never told the judging exists. For the same reason the two routes it calls are under
 * `/api/admin/`, leaving the rep's `/api/phoenix-crm/` address space with nothing to probe.
 */

import { useState } from "react";

import { crmPost, useCrmAction } from "@/components/phoenix-crm/api";
import { usePlaceCheckDone } from "@/components/phoenix-crm/place-check-done";
import { CrmButton, CrmField, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { INTEGRITY_SETTLE_PRESETS } from "@/lib/crm-integrity/integrity-settle-presets";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
import { cn } from "@/lib/utils";
import { INTEGRITY_NOTE_LIMIT, INTEGRITY_NOTE_REQUIRED, type IntegritySettlement } from "@/lib/phoenix-crm/integrity-settlement";

// Africa/Cairo, human-readable — never raw UTC (owner standing rule). The formatter is the shared
// one and NOT `new Intl.DateTimeFormat("en-GB", …)`: CLDR 42 renamed the en-GB September
// abbreviation "Sep" → "Sept", so a client component that asks the reader's own ICU build for a
// short month renders bytes the server never sent — React hydration error #418, and only ever in
// September. `stableEnGbFormatter` serves the month from the shipped table instead.
function cairo(value: string): string {
  return stableEnGbFormatter({
    timeZone: "Africa/Cairo",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export function IntegritySettleControl({
  caseId,
  presets = false,
  settlement,
  startOpen = false,
}: {
  caseId: string;
  /**
   * The one-by-one review (owner, 2026-10-18): the board's ready-made reasons as one-tap choices that
   * fill the note, which can still be edited before Settle it. Off on the board, which keeps its look.
   */
  presets?: boolean;
  settlement: IntegritySettlement | null;
  /** The review opens straight on the note, since settling is the one thing its footer is for. */
  startOpen?: boolean;
}) {
  // After the save: the page reads itself again, and inside the review the review is told so it can move on.
  const done = usePlaceCheckDone();
  const action = useCrmAction();
  const [open, setOpen] = useState(startOpen);
  const [note, setNote] = useState("");
  // The note is required by the service, and saying so before the round trip is kinder than a
  // refusal — but the service is still the authority on it, not this line.
  const [missing, setMissing] = useState(false);

  async function settle(): Promise<void> {
    if (note.trim() === "") {
      setMissing(true);
      return;
    }
    const saved = await action.run("settle", () =>
      crmPost<{ caseId: string }>("/api/admin/phoenix-crm/integrity/settle", { caseId, note }, "settled"),
    );
    if (!saved) return;
    setOpen(false);
    setNote("");
    done("settled");
  }

  async function reopen(): Promise<void> {
    const saved = await action.run("reopen", () =>
      crmPost<{ caseId: string }>("/api/admin/phoenix-crm/integrity/reopen", { caseId }, "settled"),
    );
    if (!saved) return;
    done("reopened");
  }

  if (settlement) {
    return (
      <div className="mt-3 min-w-0 space-y-2 border-t border-slate-100 pt-3">
        <p className="break-words text-xs text-slate-500">
          Settled by {settlement.byName} on {cairo(settlement.at)}
        </p>
        <p className="break-words text-sm text-slate-700" dir="auto">
          {settlement.note}
        </p>
        {action.error ? <CrmNote tone="bad">{action.error}</CrmNote> : null}
        <CrmButton busy={action.busy === "reopen"} onClick={reopen} size="sm" variant="secondary">
          Look at it again
        </CrmButton>
      </div>
    );
  }

  if (!open) {
    return (
      <div className="mt-3 min-w-0 border-t border-slate-100 pt-3">
        <CrmButton onClick={() => setOpen(true)} size="sm" variant="secondary">
          Settle this case
        </CrmButton>
      </div>
    );
  }

  return (
    <div className={cn("min-w-0 space-y-2", startOpen ? null : "mt-3 border-t border-slate-100 pt-3")}>
      {presets ? (
        <div aria-label="Ready-made reasons" className="flex min-w-0 flex-wrap gap-1.5" role="group">
          {INTEGRITY_SETTLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              aria-pressed={note === preset.note}
              className={cn(
                "min-h-9 min-w-0 rounded-none border px-2.5 py-1 text-left text-xs font-black",
                note === preset.note ? "border-orange-500 bg-orange-50 text-orange-800" : "border-slate-200 bg-white text-slate-600 hover:border-slate-300",
              )}
              onClick={() => {
                setNote(preset.note);
                setMissing(false);
              }}
              type="button"
            >
              <span className="break-words">{preset.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      <CrmField
        error={missing && note.trim() === "" ? INTEGRITY_NOTE_REQUIRED : undefined}
        hint="Kept on the record for ever, and never shown to the rep."
        htmlFor={`settle-note-${caseId}`}
        label="Why is this settled"
      >
        <textarea
          className={crmTextareaClassName}
          id={`settle-note-${caseId}`}
          maxLength={INTEGRITY_NOTE_LIMIT}
          onChange={(event) => {
            setNote(event.target.value);
            if (event.target.value.trim() !== "") setMissing(false);
          }}
          rows={3}
          value={note}
        />
      </CrmField>
      {action.error ? <CrmNote tone="bad">{action.error}</CrmNote> : null}
      <div className="flex min-w-0 flex-wrap gap-2">
        <CrmButton busy={action.busy === "settle"} onClick={settle} size="sm" variant="primary">
          Settle it
        </CrmButton>
        <CrmButton
          onClick={() => {
            setOpen(false);
            setNote("");
            setMissing(false);
            action.clearError();
          }}
          size="sm"
          variant="ghost"
        >
          Cancel
        </CrmButton>
      </div>
    </div>
  );
}
