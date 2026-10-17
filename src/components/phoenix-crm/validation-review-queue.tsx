"use client";

/**
 * Phoenix CRM — the Super Admin's queue of places the Google Maps check could not confirm.
 *
 * Owner, 2026-10-03: "held for review and only system admin can approve or reject". Each row is one
 * place the rep captured at the door: his photo, where his phone put him, and every listing Google
 * returned for the customer's name — the same evidence the system judged on. Approve validates the
 * customer in the rep's own name; Reject retires the place and sends him back to To validate. Either
 * way the rep reads it as the system's answer: nothing he receives names who decided.
 *
 * Desktop draws the module's own `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { BulkDecideBar, BulkPick, useRowPicks, type BulkAction } from "@/components/phoenix-crm/place-check-bulk";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import { CrmButton, CrmCardsOnPhone, CrmNote, CrmPill, CrmTable, crmTdClassName, crmTextareaClassName, crmThClassName } from "@/components/phoenix-crm/ui";
import { adviseOnReview } from "@/lib/phoenix-crm/place-check-advice";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { VALIDATION_NOTE_LABEL, VALIDATION_REASON_REQUIRED, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex, ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

const REASON_TEXT: Record<NonNullable<ValidationReviewRow["reason"]>, string> = {
  no_confident_listing: "Google has no listing the system is sure is this customer.",
  lookup_failed: "Google Maps could not be asked at the time (no answer).",
  listing_far: "Google's pin for this customer is over 1 km from them: the hospital may have moved, or the pin is old.",
  listing_off:
    "The rep was refused once for standing away from this customer's Google pin, and captured the same place again — so it is here instead of being refused a second time. Both their readings are precise; the distance to each listing is below.",
  refused_by_admin: "The system did not question this one — it was refused here, by hand. The reason is the note.",
  sign_other_name: "The signboard in the photo names somebody else — not this customer, and not their place. What the system read is below.",
  sign_no_name:
    "No name the system could judge on: the photo shows no signboard at all, or a PM customer's signboard names no person. What the system read is below.",
  schedule_other_name:
    "This customer is seated in a polyclinic or centre, so their evidence is the timetable hanging inside it rather than a signboard — and the timetable the system read does not name them. What it read is below.",
  schedule_missing:
    "This customer is seated in a polyclinic or centre, and the photo holds no timetable the system could read. Neither Google nor the signboard is asked about a seating: both would be answered about the building.",
};

/** A signboard hold is not a Google question, and a timetable hold is neither — each is headed for what it is. */
function evidenceHeading(row: ValidationReviewRow): string {
  if (row.photoKind === "schedule") return "What the timetable says";
  return row.reason === "sign_other_name" || row.reason === "sign_no_name" ? "What the signboard says" : "What Google Maps returned";
}

/**
 * The photograph, large — the full width of its column and 20rem tall, shown whole and turnable. It was
 * a 128-pixel square in a 14% column (owner, 2026-10-17: "I must be able to see the photos").
 */
const PHOTO_CLASS = "h-80 w-full";

/** What the photo IS, so a blind reader is not told a timetable is a signboard. */
function photoAlt(row: ValidationReviewRow): string {
  return `${row.photoKind === "schedule" ? "Timetable" : "Signboard"} photo for ${row.customerName}`;
}

function readingText(label: string, reading: ValidationReviewRow["pin"]): string | null {
  if (!reading) return null;
  const accuracy = reading.accuracyMeters === null ? "accuracy unknown" : `within ${Math.round(reading.accuracyMeters)} m`;
  return `${label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} (${accuracy})`;
}

function Who({ row }: { row: ValidationReviewRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">
        {[row.listType, row.speciality, row.kind === "added_place" ? "Another clinic" : null].filter(Boolean).join(" · ")}
      </p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      <p className="break-words text-xs text-slate-500">Captured {row.createdAtText}</p>
      {/* A door signboard hold the system is still re-reading (owner, 2026-10-17); it may still be decided now. */}
      {row.systemStillReading ? <CrmPill tone="info">The system is still reading this sign</CrmPill> : null}
      {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
    </div>
  );
}

function Evidence({ row }: { row: ValidationReviewRow }) {
  const readings = [readingText("Photo", row.photo), readingText("Capture location", row.pin)].filter((line): line is string => line !== null);
  return (
    <div className="min-w-0 space-y-2 text-sm text-slate-700">
      <div className="space-y-0.5">
        {row.placeLabel ? (
          <p className="break-words font-semibold" dir="auto">
            {row.placeLabel}
          </p>
        ) : null}
        {row.sharedPlaceName ? (
          <p className="break-words text-xs font-black text-slate-700" dir="auto">
            Seated in {row.sharedPlaceName}
          </p>
        ) : null}
        {row.address ? <p className="break-words text-xs text-slate-500">{row.address}</p> : null}
        {row.brickName || row.areaName ? (
          <p className="break-words text-xs text-slate-500">{[row.brickName, row.areaName].filter(Boolean).join(" · ")}</p>
        ) : null}
        {/* A seating has no reading of its own — its point is the building's, captured once at its own
            door — so `readings` is legitimately empty here and the absence is said in words. */}
        {row.photoKind === "schedule" && readings.length === 0 ? (
          <p className="break-words text-xs text-slate-500">
            No reading of its own: the location is the building&rsquo;s, captured once when the rep validated it at the door.
          </p>
        ) : null}
        {readings.map((line) => (
          <p key={line} className="break-words text-xs text-slate-500">
            {line}
          </p>
        ))}
        <a className="text-xs font-black text-orange-700 underline underline-offset-2" href={row.mapsLink} rel="noreferrer" target="_blank">
          {row.photoKind === "schedule" ? "Open the building in Google Maps" : "Open where they stood in Google Maps"}
        </a>
      </div>
      <div className="border-t border-slate-100 pt-2">
        <p className="text-xs font-black uppercase tracking-[0.12em] text-slate-500">{evidenceHeading(row)}</p>
        {row.reason ? <p className="mt-1 break-words text-xs text-slate-600">{REASON_TEXT[row.reason]}</p> : null}
        {row.signText ? (
          <p className="mt-1 break-words text-sm font-semibold text-slate-800" dir="auto">
            {row.signText}
          </p>
        ) : null}
        {row.signNames.length > 0 ? (
          <p className="mt-0.5 break-words text-xs text-slate-500">
            Names read: <span dir="auto">{row.signNames.join(" · ")}</span>
          </p>
        ) : null}
        {row.otherSigns.length > 0 ? (
          <p className="mt-0.5 break-words text-xs text-slate-500">
            Also in the photo: <span dir="auto">{row.otherSigns.join(" · ")}</span>
          </p>
        ) : null}
        {row.hoursRead ? (
          <p className="mt-0.5 break-words text-xs text-slate-500">
            Hours read: <span dir="auto">{row.hoursRead}</span>
          </p>
        ) : null}
        {row.query ? (
          <p className="mt-0.5 break-words text-xs text-slate-500">
            Searched for <span dir="auto">{row.query}</span>
          </p>
        ) : null}
        {/* 🔴 A TIMETABLE ROW NEVER FALLS THROUGH TO GOOGLE. No listing was ever asked for on a
            seating, so "No listing came back." would report a question nobody put. */}
        {row.photoKind === "schedule" || row.signText !== null || row.signNames.length > 0 || row.reason === "sign_no_name" ? null : row.listings
            .length === 0 ? (
          <p className="mt-1 text-xs text-slate-500">No listing came back.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {row.listings.map((listing) => (
              <li key={listing.placeId || listing.name} className="break-words text-xs text-slate-700">
                <span dir="auto">{listing.name}</span>
                <span className="text-slate-500"> · {listing.distanceMeters.toLocaleString("en-GB")} m from them</span>
                {listing.mapsUri ? (
                  <>
                    {" · "}
                    <a className="font-black text-orange-700 underline underline-offset-2" href={listing.mapsUri} rel="noreferrer" target="_blank">
                      open
                    </a>
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Taking a rejection back (owner, 2026-10-03: "add the option to approve after reject"). Offered only
 * while the place is still retired and nothing newer has been said about it — the same test the
 * database makes. The note is OPTIONAL since 2026-10-15, as it is everywhere on this page.
 */
function Restore({ row }: { row: ValidationReviewRow }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function restore() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/restore", { reviewId: row.reviewId, note }, "restored");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-2">
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`restore-note-${row.reviewId}`}>
        Why it is accepted after all — optional (kept on the record, never shown to the rep)
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`restore-note-${row.reviewId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <CrmButton disabled={saving} onClick={() => void restore()} variant="primary">
        {saving ? "Bringing it back…" : "Approve it after all"}
      </CrmButton>
      <p className="break-words text-xs text-slate-500">
        The place comes back and the customer is validated again in {row.repName}&rsquo;s own name. Their visits are measured against it again.
      </p>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * Taking an APPROVAL back (owner, 2026-10-15: "make admin able to reject validation even if approved
 * before"). The mirror of `Restore` above, offered only while the place that approval let stand is
 * still active — the same test the database makes.
 *
 * 🔴 IT POSTS THE SAME DECISION THE PENDING ROW POSTS, to the same route: the database lets a REJECT
 * through on an approved review since migration 20261015212903, so this is one reject path and one
 * audit shape, and the review row KEEPS the evidence the system originally held it on. The other way
 * round — refusing the same place from "Validations the system did not question" — overwrites that
 * evidence with `refused_by_admin`, which is exactly why this control exists here.
 */
function RejectAfterApproval({ row }: { row: ValidationReviewRow }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => adviseOnReview(row).refusal ?? "");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function reject() {
    if (saving || reason === "") return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews",
        { reviewId: row.reviewId, decision: "reject", note, refusalReason: reason },
        "decided",
      );
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2 border-t border-slate-100 pt-2">
      <RefusalReasonField
        disabled={saving}
        id={`reject-again-reason-${row.reviewId}`}
        kind={row.photoKind}
        onChange={setReason}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`reject-again-note-${row.reviewId}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`reject-again-note-${row.reviewId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      <CrmButton disabled={saving || reason === ""} onClick={() => void reject()} variant="danger">
        {saving ? "Rejecting…" : "Reject it after all"}
      </CrmButton>
      <p className="break-words text-xs text-slate-500">
        This retires the place the approval let stand; when it is the customer&rsquo;s only one, they go back to To validate and{" "}
        {row.repName} is told what is wrong with the photo — never that anybody looked.
      </p>
      {reason === "" ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED}</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * A settled row, as the DISTRICT MANAGER reads it (owner, 2026-10-13).
 *
 * 🔴 IT NAMES NOBODY AND CARRIES NO NOTE. `decidedByName` is the Super Admin, and the decision note is
 * his own record of why — the owner's instruction was that the manager's screen does not show that the
 * final call is the administrator's, so neither appears here. What DOES appear is the one sentence the
 * rep himself was told about his photograph, because that is the thing the manager has to follow up.
 * There is no "approve it after all" either: taking a decision back is not his.
 */
function Settled({ row }: { row: ValidationReviewRow }) {
  if (row.status === "pending") return null;
  return (
    <div className="min-w-0 space-y-1">
      <CrmPill tone={row.status === "approved" ? "good" : "warn"}>{row.status === "approved" ? "Validated" : "Sent back"}</CrmPill>
      {row.decidedAtText ? <p className="break-words text-xs text-slate-500">{row.decidedAtText}</p> : null}
      {row.refusalLabel ? <p className="break-words text-xs font-semibold text-slate-700">The rep was told: {row.refusalLabel}</p> : null}
    </div>
  );
}

function Decision({ row }: { row: ValidationReviewRow }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => adviseOnReview(row).refusal ?? "");
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  if (row.status !== "pending") {
    return (
      <div className="space-y-1">
        <CrmPill tone={row.status === "approved" ? "good" : "warn"}>{row.status === "approved" ? "Approved" : "Rejected"}</CrmPill>
        <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
        {row.refusalLabel ? <p className="break-words text-xs font-semibold text-slate-700">The rep was told: {row.refusalLabel}</p> : null}
        {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
        {row.restorable ? <Restore row={row} /> : null}
        {row.refusable ? <RejectAfterApproval row={row} /> : null}
      </div>
    );
  }

  async function decide(decision: "approve" | "reject") {
    if (saving) return;
    setSaving(decision);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews",
        { reviewId: row.reviewId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
        "decided",
      );
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  return (
    <div className="space-y-2">
      <RefusalReasonField
        disabled={saving !== null}
        id={`review-reason-${row.reviewId}`}
        kind={row.photoKind}
        onChange={setReason}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`review-note-${row.reviewId}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={`review-note-${row.reviewId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton disabled={saving !== null} onClick={() => void decide("approve")} variant="primary">
          {saving === "approve" ? "Approving…" : "Approve"}
        </CrmButton>
        <CrmButton disabled={saving !== null || reason === ""} onClick={() => void decide("reject")} variant="danger">
          {saving === "reject" ? "Rejecting…" : "Reject"}
        </CrmButton>
      </div>
      {reason === "" ? <p className="break-words text-xs text-slate-500">{VALIDATION_REASON_REQUIRED} Approve needs no reason.</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * The last column, both modes in one place so the two can never disagree about what a manager sees:
 * the Super Admin keeps every control he has had since 2026-10-03 and reads what the manager wrote
 * under it; the manager gets the settled state, his comments and his two recommendation buttons, and
 * no decision control of any kind.
 */
function LastColumn({ mode, noteIndex, row }: { mode: PlaceCheckNotesMode; noteIndex: PlaceNoteIndex; row: ValidationReviewRow }) {
  const key = placeNoteSubjectKey("place", row.placeId);
  return (
    <div className="min-w-0 space-y-2">
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the Super Admin's board only. */}
      {mode === "team" ? null : <SystemAdvice advice={adviseOnReview(row)} />}
      {mode === "team" ? <Settled row={row} /> : <Decision row={row} />}
      <PlaceCheckNotes
        integrity={noteIndex.integrity[key] ?? []}
        mode={mode}
        notes={noteIndex.notes[key] ?? []}
        recommendations={noteIndex.recommendations[key] ?? []}
        subjectId={row.placeId}
        subjectKind="place"
      />
    </div>
  );
}

/**
 * Answering several rows at once (owner, 2026-10-15: "also make me able to multiple select and
 * response"). Each action is the request the row's own buttons make, so there is no second decision
 * path — see `place-check-bulk.tsx`.
 *
 * 🔴 WHICH ACTIONS A SECTION OFFERS IS WHAT THE SECTION HOLDS: `waiting` answers pending rows, and
 * `decided` takes a settled decision BACK — each action filtered to the rows the server says it can
 * still reach (`refusable` / `restorable`), with the count it will answer in the button.
 */
const bulkDecide = (row: ValidationReviewRow, decision: "approve" | "reject", note: string, reason: string) =>
  crmPost<unknown>(
    "/api/phoenix-crm/validation-reviews",
    { reviewId: row.reviewId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
    "decided",
  );

const WAITING_ACTIONS: ReadonlyArray<BulkAction<ValidationReviewRow>> = [
  {
    key: "approve",
    label: "Approve",
    busyLabel: "Approving",
    variant: "primary",
    needsReason: false,
    takes: (row) => row.status === "pending",
    run: (row, answer) => bulkDecide(row, "approve", answer.note, ""),
  },
  {
    key: "reject",
    label: "Reject",
    busyLabel: "Rejecting",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This retires ${count === 1 ? "that place" : `those ${count} places`}; each customer left without one goes back to To validate, told what is wrong with the photo and nothing else.`,
    takes: (row) => row.status === "pending",
    run: (row, answer) => bulkDecide(row, "reject", answer.note, answer.reason),
  },
];

const DECIDED_ACTIONS: ReadonlyArray<BulkAction<ValidationReviewRow>> = [
  {
    key: "reject-after-all",
    label: "Reject after all",
    busyLabel: "Rejecting",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This takes back ${count === 1 ? "an approval" : `${count} approvals`} and retires the place each one let stand; a customer left without one goes back to To validate.`,
    takes: (row) => row.refusable,
    run: (row, answer) => bulkDecide(row, "reject", answer.note, answer.reason),
  },
  {
    key: "approve-after-all",
    label: "Approve after all",
    busyLabel: "Bringing back",
    variant: "primary",
    needsReason: false,
    takes: (row) => row.restorable,
    run: (row, answer) => crmPost<unknown>("/api/phoenix-crm/validation-reviews/restore", { reviewId: row.reviewId, note: answer.note }, "restored"),
  },
];

export function ValidationReviewQueue({
  mode,
  noteIndex,
  rows,
  section,
}: {
  mode: PlaceCheckNotesMode;
  noteIndex: PlaceNoteIndex;
  rows: ValidationReviewRow[];
  /** Which set this is drawing — it decides what a bulk answer can be. */
  section: "waiting" | "decided";
}) {
  const bulk = mode === "company";
  const canPick = (row: ValidationReviewRow) => (section === "waiting" ? row.status === "pending" : row.refusable || row.restorable);
  const picks = useRowPicks<ValidationReviewRow>(bulk ? rows : [], (row) => row.reviewId, canPick);
  // 🔴 THE PICK-LIST FOLLOWS THE PHOTOGRAPHS IN THE PICK. All timetables → the timetable reasons; a
  // mixed pick takes the signboard list, whose reasons are all sayable about a building's sign.
  const kind = picks.picked.length > 0 && picks.picked.every((row) => row.photoKind === "schedule") ? "schedule" : "signboard";

  return (
    <>
      {bulk ? (
        <BulkDecideBar
          actions={section === "waiting" ? WAITING_ACTIONS : DECIDED_ACTIONS}
          // Only the waiting rows: a settled row's quick pick would tick rows no action can answer.
          adviceOf={section === "waiting" ? (row) => adviseOnReview(row).kind : undefined}
          kind={kind}
          nameOf={(row) => row.customerName}
          picks={picks}
        />
      ) : null}
      <CrmCardsOnPhone>
        {rows.map((row) => (
          <div key={row.reviewId} className="space-y-3 px-4 py-4">
            {bulk && canPick(row) ? <BulkPick picks={picks} row={row} /> : null}
            <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy path={row.photoPath} rotatable />
            <Who row={row} />
            <Evidence row={row} />
            <LastColumn mode={mode} noteIndex={noteIndex} row={row} />
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["30%", "18%", "28%", "24%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Photo</th>
            <th className={crmThClassName}>Customer and rep</th>
            <th className={crmThClassName}>Where they stood, and Google</th>
            <th className={crmThClassName}>{mode === "team" ? "Your comment" : "Decision"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.reviewId} className="even:bg-slate-50/60">
              <td className={crmTdClassName}>
                <div className="min-w-0 space-y-2">
                  <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy path={row.photoPath} rotatable />
                  {bulk && canPick(row) ? <BulkPick picks={picks} row={row} /> : null}
                </div>
              </td>
              <td className={crmTdClassName}>
                <Who row={row} />
              </td>
              <td className={crmTdClassName}>
                <Evidence row={row} />
              </td>
              <td className={crmTdClassName}>
                <LastColumn mode={mode} noteIndex={noteIndex} row={row} />
              </td>
            </tr>
          ))}
        </tbody>
      </CrmTable>
    </>
  );
}
