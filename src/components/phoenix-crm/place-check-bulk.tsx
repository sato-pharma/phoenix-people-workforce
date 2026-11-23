"use client";

/**
 * Phoenix CRM — Place checks: ticking several rows and answering them in one go.
 *
 * Owner, 2026-10-15: "also make me able to multiple select and response". Every section of the page
 * was one row at a time — a reason, a note and a button per place — and the queue is worked through in
 * sittings of dozens.
 *
 * 🔴 A BULK ANSWER IS THE SAME ANSWER, N TIMES — never a second decision path. Each action runs the
 * per-row request the page already makes, one after another, and the reason and note are typed ONCE and
 * sent with each: so the rep is told exactly what a one-row refusal tells him, the audit rows are the
 * same rows, and nothing new reaches the database. They run SEQUENTIALLY on purpose — every rejection
 * retires a place and re-measures that customer's visits, and firing twenty of those at once is how one
 * of them comes back a timeout with no way to say which.
 *
 * 🔴 A ROW THAT FALLS OUT OF THE LIST FALLS OUT OF THE SELECTION. `useRowPicks` intersects what is
 * ticked with what is on screen at every render, so changing a filter — or a row settling under you —
 * can never decide a place you cannot see.
 *
 * 🔴 AND IT IS THE DECIDERS' ALONE — the Super Admin and the SFE Manager — like every control it
 * repeats: a district manager's board passes `mode === "team"` and renders none of this (his screen says
 * nothing about who decides).
 */

import { useContext, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { messageOf } from "@/components/phoenix-crm/api";
import { bulkOutcomeSummary, isAlreadyDecided, markRowSaved, type PlaceCheckOutcome } from "@/components/phoenix-crm/place-check-done";
import { placeCheckReread } from "@/components/phoenix-crm/place-check-reread";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { CrmButton, CrmNote, crmTextareaClassName } from "@/components/phoenix-crm/ui";
import type { PlaceCheckAdviceKind } from "@/lib/phoenix-crm/place-check-advice";
import { cn } from "@/lib/utils";
import { VALIDATION_NOTE_LABEL, VALIDATION_REASON_REQUIRED, type ValidationPickKind, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import { type BulkAction, BulkPickLineSlot, type RowPicks, setBulkRunGoing, useBulkRunGoing } from "@/components/phoenix-crm/place-check-bulk-picks";

// The ticks, the run that holds the board and the pick line live in `place-check-bulk-picks.tsx` since the
// split of 23 Nov 2026 (no file of Place checks over 400 lines); every caller still imports them here.
export { type BulkAnswer, type BulkAction, type RowPicks, useRowPicks, holdBoardForBulkRun, useBulkRunGoing, BulkPickLineSlot, BulkPick } from "@/components/phoenix-crm/place-check-bulk-picks";

/**
 * The bar above a section: how many are ticked, the reason and note for all of them, and one button
 * per action carrying the number it will answer.
 */
export function BulkDecideBar<Row>({
  actions,
  adviceOf,
  kind = "signboard",
  nameOf,
  picks,
}: {
  actions: ReadonlyArray<BulkAction<Row>>;
  /**
   * The system's recommendation per row (owner, 2026-10-17), so the bar can tick every row it
   * recommends approving, or rejecting, in one press. Ticking decides nothing: the answer is still his
   * own press of an action button, with the reason he picks.
   */
  adviceOf?: (row: Row) => PlaceCheckAdviceKind | null;
  /** Which photo the selection is about, so the pick-list offers only reasons true of it. */
  kind?: ValidationPickKind;
  /** How a row names itself, so a failure says which place it was. */
  nameOf: (row: Row) => string;
  picks: RowPicks<Row>;
}) {
  const router = useRouter();
  // 🔴 EACH BAR ITS OWN FIELD IDS (17 Nov 2026): a page holds up to three bars at once, and three
  // `place-check-bulk-note` boxes sent every label's tap to the first one.
  const fieldId = useId();
  const reasonId = `place-check-bulk-reason-${fieldId}`;
  const noteId = `place-check-bulk-note-${fieldId}`;
  const anyRunGoing = useBulkRunGoing();
  const lineSlot = useContext(BulkPickLineSlot);
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ValidationRefusalReason | "">("");
  const [armed, setArmed] = useState<string | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [failures, setFailures] = useState<ReadonlyArray<{ name: string; problem: string }>>([]);
  const [summary, setSummary] = useState<string | null>(null);
  // Whether a phone has opened the line that stands in a title row (see `line` below).
  const [lineOpen, setLineOpen] = useState(false);

  const picked = picks.picked;
  const needsReason = actions.some((action) => action.needsReason);
  const busy = running !== null || anyRunGoing;

  // 🔴 A RUN DIES WITH ITS BAR (17 Nov 2026, the review of the audit fixes): leaving the page stops it
  // before its next row, frees the board's lock at once, and never refreshes the page he went to — the
  // same rule as the decisions' waiting re-read (`placeCheckReread.cancel`).
  const alive = useRef(true);
  const ownsRun = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (ownsRun.current) {
        ownsRun.current = false;
        setBulkRunGoing(false);
      }
    };
  }, []);

  async function run(action: BulkAction<Row>) {
    const targets = picked.filter(action.takes);
    if (busy || targets.length === 0) return;
    if (action.warning && armed !== action.key) {
      setArmed(action.key);
      return;
    }
    setArmed(null);
    setRunning(action.key);
    ownsRun.current = true;
    setBulkRunGoing(true);
    // A re-read still waiting from an earlier press would rebuild the rows under the run; this one reads
    // the page itself when it ends. 🔴 Its rows are owed from the first one (22 Nov 2026): leaving mid-run
    // never reaches that read, and the page he comes back to must still not show them waiting.
    placeCheckReread.cancel();
    placeCheckReread.owe();
    setDone(0);
    setFailures([]);
    setSummary(null);
    const failed: Array<{ name: string; problem: string }> = [];
    const landed: PlaceCheckOutcome[] = [];
    try {
      for (const row of targets) {
        if (!alive.current) break;
        const before = landed.length;
        try {
          landed.push(action.outcomeOf(await action.run(row, { note, reason }), row));
        } catch (error) {
          // 🔴 "ALREADY DECIDED" IS AN ANSWER IN A BULK RUN TOO (17 Nov 2026, the audit's wording): the
          // other decider, or his own earlier press, settled that row first. It was listed in red as "not
          // answered"; the decision he wanted is the one that stands, so it is counted as such.
          if (isAlreadyDecided(error)) landed.push("already");
          else failed.push({ name: nameOf(row), problem: messageOf(error) });
        }
        // The row's own control draws what was saved, at once, until the re-read hands the row back.
        if (landed.length > before) markRowSaved(row, landed[landed.length - 1]);
        setDone((current) => current + 1);
      }
    } finally {
      if (ownsRun.current) {
        ownsRun.current = false;
        setBulkRunGoing(false);
      }
    }
    if (!alive.current) return;
    setFailures(failed);
    setSummary(landed.length > 0 ? bulkOutcomeSummary(landed) : null);
    setRunning(null);
    // Whatever landed, the page is re-read: the rows that settled leave their section, and the ones
    // that failed stay where they are with their reason beside them. A re-read already waiting for the
    // decisions to pause is dropped first: this one reads the same page now.
    if (failed.length < targets.length) picks.clear();
    placeCheckReread.refreshNow(() => router.refresh());
  }

  if (picks.selectable === 0) return null;

  // How many rows on screen the system recommends each way — the counts on the two quick picks.
  const recommended = (want: PlaceCheckAdviceKind) => (adviceOf ? picks.rows.filter((row) => adviceOf(row) === want).length : 0);
  const toApprove = recommended("approve");
  const toReject = recommended("reject");

  // The bar's first line. In a section's title row it ends the row on a desktop and stands under the title on a phone.
  const inTitleRow = lineSlot !== undefined;
  // 🔴 ON A PHONE THE LINE IN A TITLE ROW IS ONE BUTTON UNTIL IT IS PRESSED (owner, 23 Nov 2026: "Fix speed
  // next"). Its label and its three quick picks wrapped into four rows there, most of a lane head 241 px
  // tall above the first waiting place (measured at 375 on the live page). A desktop draws the line whole,
  // as before; so does a phone once anything is ticked.
  const foldedOnPhone = inTitleRow && picked.length === 0 && !lineOpen;
  const line = (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-2", inTitleRow && "sm:justify-end")}>
      {inTitleRow && picked.length === 0 ? (
        <CrmButton aria-expanded={lineOpen} className="min-h-11 sm:hidden" data-pick-line-toggle disabled={busy} onClick={() => setLineOpen(!lineOpen)} size="sm">
          {lineOpen ? "Close picking" : `Answer several together (${picks.selectable})`}
        </CrmButton>
      ) : null}
      <div className={foldedOnPhone ? "hidden sm:contents" : "contents"} data-pick-line-body>
      <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">
        {picked.length === 0 ? `Pick rows to answer together (${picks.selectable} here)` : `${picked.length} picked`}
      </p>
      <CrmButton disabled={busy} onClick={() => picks.pickAll()} size="sm" variant="ghost">
        Pick all {picks.selectable}
      </CrmButton>
      {adviceOf && toApprove > 0 ? (
        <CrmButton disabled={busy} onClick={() => picks.pickWhere((row) => adviceOf(row) === "approve")} size="sm" variant="ghost">
          Pick the {toApprove} the system recommends approving
        </CrmButton>
      ) : null}
      {adviceOf && toReject > 0 ? (
        <CrmButton disabled={busy} onClick={() => picks.pickWhere((row) => adviceOf(row) === "reject")} size="sm" variant="ghost">
          Pick the {toReject} the system recommends rejecting
        </CrmButton>
      ) : null}
      {picked.length > 0 ? (
        <CrmButton disabled={busy} onClick={() => picks.clear()} size="sm" variant="ghost">
          Clear
        </CrmButton>
      ) : null}
      </div>
    </div>
  );
  // The SAME element, in the title row's slot when the section has one. A slot not on the page yet draws
  // nothing for that render.
  const lineInPlace = !inTitleRow ? line : lineSlot ? createPortal(line, lineSlot) : null;
  // With its line in the title row the box holds only what a pick opens and what the last run said: with
  // nothing ticked and nothing said there is no box, and the first waiting place stands under the title.
  const lastRunSaid = (summary !== null && running === null) || failures.length > 0;
  if (inTitleRow && picked.length === 0 && !lastRunSaid) return lineInPlace;

  return (
    <div className="min-w-0 space-y-2 border-b border-slate-200 bg-slate-50 px-4 py-3">
      {lineInPlace}

      {picked.length > 0 ? (
        <>
          {needsReason ? (
            <RefusalReasonField
              disabled={busy}
              id={reasonId}
              kind={kind}
              onChange={(next) => {
                setReason(next);
                setArmed(null);
              }}
              value={reason}
            />
          ) : null}
          <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={noteId}>
            {VALIDATION_NOTE_LABEL}
          </label>
          <textarea
            className={crmTextareaClassName}
            disabled={busy}
            id={noteId}
            maxLength={500}
            onChange={(event) => {
              setNote(event.target.value);
              setArmed(null);
            }}
            rows={2}
            value={note}
          />
          <RefusalNoteHint />
          <div className="grid gap-2 sm:grid-cols-2">
            {actions.map((action) => {
              const targets = picked.filter(action.takes);
              const held = action.needsReason && reason === "";
              return (
                <CrmButton
                  disabled={busy || targets.length === 0 || held}
                  key={action.key}
                  onClick={() => void run(action)}
                  variant={action.variant}
                >
                  {running === action.key
                    ? `${action.busyLabel} ${done} of ${targets.length}…`
                    : armed === action.key
                      ? `Yes, ${action.label.toLowerCase()} ${targets.length}`
                      : `${action.label} (${targets.length})`}
                </CrmButton>
              );
            })}
          </div>
          {actions.map((action) =>
            armed === action.key && action.warning ? (
              <CrmNote key={action.key} tone="warn">
                {action.warning(picked.filter(action.takes).length)}
              </CrmNote>
            ) : null,
          )}
          {needsReason && reason === "" ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED}</p> : null}
        </>
      ) : null}
      {/* What the last run did stays under the bar after it clears the ticks, the way a row's own control
          keeps its saved outcome; inside the picked block, a run that landed anything hid both lines. */}
      {summary !== null && running === null ? (
        <p className="break-words text-xs font-semibold text-slate-700" role="status">
          {summary}
        </p>
      ) : null}
      {failures.length > 0 ? (
        <CrmNote tone="bad">
          <span className="break-words">
            {failures.length === 1 ? "One was not answered" : `${failures.length} were not answered`}:{" "}
            {failures.map((failure) => `${failure.name} — ${failure.problem}`).join(" · ")}
          </span>
        </CrmNote>
      ) : null}
    </div>
  );
}
