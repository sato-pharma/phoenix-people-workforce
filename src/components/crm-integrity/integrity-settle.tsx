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
import { useRouter } from "next/navigation";

import { crmPost, useCrmAction } from "@/components/phoenix-crm/api";
import { CrmButton, CrmField, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import { stableEnGbFormatter } from "@/lib/format/cairo-datetime";
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
  settlement,
}: {
  caseId: string;
  settlement: IntegritySettlement | null;
}) {
  const router = useRouter();
  const action = useCrmAction();
  const [open, setOpen] = useState(false);
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
    router.refresh();
  }

  async function reopen(): Promise<void> {
    const saved = await action.run("reopen", () =>
      crmPost<{ caseId: string }>("/api/admin/phoenix-crm/integrity/reopen", { caseId }, "settled"),
    );
    if (!saved) return;
    router.refresh();
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
    <div className="mt-3 min-w-0 space-y-2 border-t border-slate-100 pt-3">
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
