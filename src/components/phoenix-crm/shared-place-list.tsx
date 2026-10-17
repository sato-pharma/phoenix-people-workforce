"use client";

/**
 * Phoenix CRM — the polyclinics and centres, and the administrator's decision on each.
 *
 * Owner, 2026-10-09 in chat (Arabic): "من حق الادمنستريتور ان هو يراجع الجدول ويبص" — the
 * administrator has the right to review the schedule and look. This is that review for the VENUE: the
 * live photo of the sign on the building, the two readings taken at its door, where it resolved to,
 * who captured it and when, and how many customers are seated behind it.
 *
 * 🔴 NO GOOGLE COLUMN, DELIBERATELY. The listing check compares a listing against the name on a
 * customer's LIST row, and a venue has no list name at all — so there is nothing to compare and
 * nothing is shown. The owner was asked this directly the same day and answered that the live photo
 * and the location are the gate: "even if no Google check, he must validate by a live photo and
 * location." This section is the human gate behind them.
 *
 * Rejecting one is the heavy decision on this page, so what it costs is written above the button
 * rather than after it: the venue is retired, every customer seated in it is retired with it, and each
 * of them goes back to To validate. The rep is told what is wrong with the photo from the same closed
 * list every other refusal uses, and never that a person looked at him.
 *
 * Desktop draws the module's `CrmTable` (`table-fixed` with a colgroup, never a min-width in a
 * scroller); a phone draws the same rows as cards. Square corners throughout.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

import { crmPost, messageOf } from "@/components/phoenix-crm/api";
import { BulkDecideBar, BulkPick, useRowPicks, type BulkAction } from "@/components/phoenix-crm/place-check-bulk";
import { PlaceCheckNotes, type PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { RefusalNoteHint, RefusalReasonField } from "@/components/phoenix-crm/refusal-reason-field";
import { SeatedCustomers } from "@/components/phoenix-crm/shared-place-customers";
import {
  CrmButton,
  CrmCardsOnPhone,
  CrmNote,
  CrmPill,
  CrmTable,
  crmTdClassName,
  crmTextareaClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import {
  VALIDATION_NOTE_LABEL,
  VALIDATION_REASON_REQUIRED,
  type ValidationRefusalReason,
} from "@/lib/phoenix-crm/validation-feedback";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { PlaceNoteIndex, SharedPlaceBoardRow } from "@/lib/phoenix-crm/view-types";

/** What the system read on the sign of the BUILDING. A verdict on the venue's own name, never on a person's. */
const SIGNBOARD_TEXT: Record<string, string> = {
  match: "The sign names this polyclinic",
  other_name: "The sign names something else",
  no_name: "No name to judge on the sign",
  unjudged: "The sign could not be read",
};

/**
 * The four answers `unjudged` can mean since 2026-10-09 — a frame still waiting for another attempt,
 * one that has had every attempt it gets, a verdict two readings disagreed about, and a place there
 * was nothing to compare. A reason not named here falls back to the verdict's sentence, so a reason
 * added later can never surface as a code on this board.
 */
const SIGNBOARD_UNJUDGED_TEXT: Record<string, string> = {
  name_unusable: "Nothing on a sign to compare",
  unconfirmed: "Two readings of the sign disagreed",
  unreadable: "The sign could not be read yet",
  unreadable_final: "The sign could not be read",
};

function signboardText(signboard: NonNullable<SharedPlaceBoardRow["signboard"]>): string {
  if (signboard.verdict !== "unjudged") return SIGNBOARD_TEXT[signboard.verdict] ?? SIGNBOARD_TEXT.unjudged;
  return SIGNBOARD_UNJUDGED_TEXT[signboard.reason ?? ""] ?? SIGNBOARD_TEXT.unjudged;
}

function readingText(label: string, reading: SharedPlaceBoardRow["pin"]): string | null {
  if (!reading) return null;
  const accuracy = reading.accuracyMeters === null ? "accuracy unknown" : `within ${Math.round(reading.accuracyMeters)} m`;
  return `${label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} (${accuracy})`;
}

/** Which of the two layouts a venue control is drawn in — the phone block and the table are BOTH in the page, so an id must say which. */
type VenueScope = "cards" | "table";

function Venue({ mode, row }: { mode: PlaceCheckNotesMode; row: SharedPlaceBoardRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.name}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{row.kindLabel}</p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      <p className="break-words text-xs text-slate-500">Captured {row.capturedAtText}</p>
      <div className="flex min-w-0 flex-wrap gap-1">
        <CrmPill tone={row.seated === 0 ? "neutral" : "info"}>
          {row.seated === 0 ? "Nobody seated yet" : `${row.seated} ${row.seated === 1 ? "customer seated" : "customers seated"}`}
        </CrmPill>
        {row.status === "held" ? <CrmPill tone="warn">{mode === "team" ? "Being checked" : "Waiting for you"}</CrmPill> : null}
        {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
    </div>
  );
}

function Where({ row }: { row: SharedPlaceBoardRow }) {
  const readings = [readingText("Photo", row.photo), readingText("Capture location", row.pin)].filter((line): line is string => line !== null);
  return (
    <div className="min-w-0 space-y-0.5 text-sm text-slate-700">
      {row.address ? <p className="break-words text-xs text-slate-500">{row.address}</p> : null}
      {row.brickName || row.areaName ? (
        <p className="break-words text-xs text-slate-500">{[row.brickName, row.areaName].filter(Boolean).join(" · ")}</p>
      ) : null}
      {readings.map((line) => (
        <p key={line} className="break-words text-xs text-slate-500">
          {line}
        </p>
      ))}
      <a className="inline-block text-xs font-black text-orange-700 underline underline-offset-2" href={row.mapsLink} rel="noreferrer" target="_blank">
        Open the building in Google Maps
      </a>
      <div className="space-y-0.5 border-t border-slate-100 pt-1">
        {row.signboard ? (
          <CrmPill tone={row.signboard.verdict === "match" ? "good" : row.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
            {signboardText(row.signboard)}
          </CrmPill>
        ) : (
          <p className="text-xs text-slate-500">The sign has not been read yet.</p>
        )}
        {row.signboard?.signText ? (
          <p className="break-words text-xs text-slate-700" dir="auto">
            {row.signboard.signText}
          </p>
        ) : null}
        <p className="break-words text-xs text-slate-500">
          This building is not looked up in Google: the check reads a customer&apos;s own name, and a polyclinic has none.
        </p>
      </div>
    </div>
  );
}

/** What rejecting this venue costs, in plain words — read before the button, not after. */
function Cost({ row }: { row: SharedPlaceBoardRow }) {
  const lines = [
    row.seated === 0
      ? "Nobody is seated in it yet, so no customer is affected."
      : `${row.seated === 1 ? "The 1 customer seated in it is retired with it and goes" : `All ${row.seated} customers seated in it are retired with it and go`} back to To validate.`,
    "The rep captures it again from their own list, and is told what is wrong with the photo and nothing else.",
  ];
  return (
    <ul className="space-y-0.5">
      {lines.map((line) => (
        <li key={line} className="break-words text-xs text-slate-600">
          {line}
        </li>
      ))}
    </ul>
  );
}

/**
 * Approving a venue after rejecting it (owner, 2026-10-15: "make me able to approve validation after
 * rejection"). The mirror of the rejected place's `Approve it after all`, and until this existed it
 * was the one decision on this page with no undo anywhere: 35 buildings on production were retired
 * with every doctor behind each one sent back to To validate, and the row was not even drawn.
 *
 * What comes back is the DATABASE's rule, not this screen's: the venue, the places that rejection
 * retired, and each of those customers confirmed only under the three holds approving a held venue
 * already keeps. So the sentence under the button states what will happen and promises nothing the
 * server might not do — a customer whose timetable still cannot answer for him stays under To
 * validate, and the answer says so by name.
 */
function RestoreVenue({ row, scope }: { row: SharedPlaceBoardRow; scope: VenueScope }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function restore() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/shared-place/restore", { sharedPlaceId: row.sharedPlaceId, note }, "restored");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <div className="min-w-0 space-y-2">
      <CrmPill tone="bad">Rejected</CrmPill>
      <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
      {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
      <p className="break-words text-xs text-slate-600">
        Bringing it back makes the building live again and gives every customer it retired their place back. One whose timetable still cannot
        answer for them stays under To validate.
      </p>
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`restore-venue-note-${scope}-${row.sharedPlaceId}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`restore-venue-note-${scope}-${row.sharedPlaceId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <CrmButton busy={saving} disabled={saving} onClick={() => void restore()} variant="primary">
        {saving ? "Bringing it back" : "Approve it after all"}
      </CrmButton>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

function Decision({ row, scope }: { row: SharedPlaceBoardRow; scope: VenueScope }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [reason, setReason] = useState<ValidationRefusalReason | "">("");
  const [saving, setSaving] = useState<"approve" | "reject" | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  async function decide(decision: "approve" | "reject") {
    if (saving) return;
    setSaving(decision);
    setProblem(null);
    try {
      await crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews/shared-place",
        { sharedPlaceId: row.sharedPlaceId, decision, note, ...(decision === "reject" ? { refusalReason: reason } : {}) },
        "decided",
      );
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(null);
    }
  }

  // 🔴 A REJECTED VENUE IS DECIDED, NOT GONE (owner, 2026-10-15: "make me able to approve validation
  // after rejection"). Its row shows what was said about it and ONE control — the undo — never the
  // approve/reject pair again: rejecting a retired venue is what the database refuses, and the Cost
  // lines below describe a cost that has already been paid.
  if (row.restorable) {
    return <RestoreVenue row={row} scope={scope} />;
  }

  return (
    <div className="space-y-2">
      {row.decidedAtText ? (
        <div className="space-y-0.5">
          <CrmPill tone="good">Approved</CrmPill>
          <p className="break-words text-xs text-slate-500">{[row.decidedByName, row.decidedAtText].filter(Boolean).join(" · ")}</p>
          {row.decisionNote ? <p className="break-words text-xs text-slate-600">{row.decisionNote}</p> : null}
        </div>
      ) : null}
      <Cost row={row} />
      <RefusalReasonField
        disabled={saving !== null}
        id={`shared-place-reason-${scope}-${row.sharedPlaceId}`}
        onChange={setReason}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`shared-place-note-${scope}-${row.sharedPlaceId}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving !== null}
        id={`shared-place-note-${scope}-${row.sharedPlaceId}`}
        maxLength={500}
        onChange={(event) => setNote(event.target.value)}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
        <CrmButton disabled={saving !== null} onClick={() => void decide("approve")} variant="primary">
          {saving === "approve" ? "Approving…" : row.status === "held" ? "Approve" : "Keep it"}
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
 * The last column, both modes together.
 *
 * 🔴 A MANAGER GETS NO `Decision` AND NOT EVEN THE `Cost` WARNING INSIDE IT. Rejecting a venue retires
 * it, retires every customer seated in it and sends each of them back to To validate — the heaviest
 * decision on this page, and the Super Admin's alone. A manager reads the venue, comments on it and
 * recommends; whether it was already approved, and by whom, is not on his screen (owner, 2026-10-13).
 */
function LastColumn({ mode, noteIndex, row, scope }: { mode: PlaceCheckNotesMode; noteIndex: PlaceNoteIndex; row: SharedPlaceBoardRow; scope: VenueScope }) {
  const key = placeNoteSubjectKey("shared_place", row.sharedPlaceId);
  return (
    <div className="min-w-0 space-y-2">
      {mode === "team" ? null : <Decision row={row} scope={scope} />}
      <PlaceCheckNotes
        integrity={noteIndex.integrity[key] ?? []}
        mode={mode}
        notes={noteIndex.notes[key] ?? []}
        recommendations={noteIndex.recommendations[key] ?? []}
        subjectId={row.sharedPlaceId}
        subjectKind="shared_place"
      />
    </div>
  );
}

/**
 * Deciding several venues at once (owner, 2026-10-15: "also make me able to multiple select and
 * response") — the row's own request per venue, nothing new; see `place-check-bulk.tsx`. The warning
 * says what a bulk rejection costs, because here it reaches every customer seated behind each door.
 */
const VENUE_ACTIONS: ReadonlyArray<BulkAction<SharedPlaceBoardRow>> = [
  {
    key: "approve",
    label: "Approve",
    busyLabel: "Approving",
    variant: "primary",
    needsReason: false,
    takes: (row) => !row.restorable,
    run: (row, answer) =>
      crmPost<unknown>("/api/phoenix-crm/validation-reviews/shared-place", { sharedPlaceId: row.sharedPlaceId, decision: "approve", note: answer.note }, "decided"),
  },
  {
    key: "reject",
    label: "Reject",
    busyLabel: "Rejecting",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This retires ${count === 1 ? "that building" : `those ${count} buildings`} and everybody seated in ${count === 1 ? "it" : "them"}; each of those customers goes back to To validate and must capture the building again at its door.`,
    takes: (row) => !row.restorable,
    run: (row, answer) =>
      crmPost<unknown>(
        "/api/phoenix-crm/validation-reviews/shared-place",
        { sharedPlaceId: row.sharedPlaceId, decision: "reject", note: answer.note, refusalReason: answer.reason },
        "decided",
      ),
  },
  {
    key: "restore",
    label: "Approve after all",
    busyLabel: "Bringing back",
    variant: "primary",
    needsReason: false,
    takes: (row) => row.restorable,
    run: (row, answer) =>
      crmPost<unknown>("/api/phoenix-crm/validation-reviews/shared-place/restore", { sharedPlaceId: row.sharedPlaceId, note: answer.note }, "restored"),
  },
];

/**
 * The two photographs a building is judged on (owner, 2026-10-17: "showing the polyclinic itself photo
 * validation and the timetable"): the sign on its door, which names the BUILDING, and the one timetable
 * photographed inside it for everybody seated there. A building nobody has been seated in has no
 * timetable yet — the next customer to receive there is the rep who photographs it.
 */
function VenuePhotos({ row }: { row: SharedPlaceBoardRow }) {
  return (
    <div className="w-28 min-w-0 max-w-full shrink-0 space-y-3">
      <div className="min-w-0 space-y-1">
        <p className="break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">The sign on the building</p>
        <CrmPhotoThumb alt={`Sign photo for ${row.name}`} className="h-28 w-28" path={row.photoPath} />
      </div>
      <div className="min-w-0 space-y-1">
        <p className="break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">The timetable inside</p>
        {row.schedulePhotoPath ? (
          <>
            <CrmPhotoThumb alt={`Timetable photo for ${row.name}`} className="h-28 w-28" path={row.schedulePhotoPath} />
            {row.schedulePhotoCapturedAtText ? <p className="break-words text-xs text-slate-500">Photographed {row.schedulePhotoCapturedAtText}</p> : null}
          </>
        ) : (
          <p className="break-words text-xs text-slate-500">No timetable on file yet.</p>
        )}
      </div>
    </div>
  );
}

/**
 * The polyclinics and centres, each as ONE group: the building's own sign check, its timetable, and the
 * customers seated in it with what that timetable says about each (owner, 2026-10-17). The customers are
 * drawn by `SeatedCustomers`, directly under their building, so a polyclinic is never read apart from
 * the people behind its door.
 */
export function SharedPlaceList({
  groups,
  mode,
  noteIndex,
}: {
  groups: VenueGroup[];
  mode: PlaceCheckNotesMode;
  noteIndex: PlaceNoteIndex;
}) {
  const bulk = mode === "company";
  const rows = useMemo(() => groups.map((group) => group.venue), [groups]);
  const picks = useRowPicks<SharedPlaceBoardRow>(bulk ? rows : [], (row) => row.sharedPlaceId);
  return (
    <>
      {bulk ? <BulkDecideBar actions={VENUE_ACTIONS} nameOf={(row) => row.name} picks={picks} /> : null}
      <CrmCardsOnPhone>
        {groups.map(({ customers, total, venue: row }) => (
          <div key={row.sharedPlaceId} className="space-y-3 border-t-4 border-slate-200 first:border-t-0">
            <div className="space-y-3 px-4 pt-4">
              {bulk ? <BulkPick picks={picks} row={row} /> : null}
              <div className="flex min-w-0 gap-3">
                <VenuePhotos row={row} />
                <Venue mode={mode} row={row} />
              </div>
              <Where row={row} />
              <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="cards" />
            </div>
            <div className="border-t border-slate-100 bg-slate-50/60 pb-2">
              <SeatedCustomers customers={customers} layout="cards" mode={mode} noteIndex={noteIndex} total={total} venueTimetablePath={row.schedulePhotoPath} />
            </div>
          </div>
        ))}
      </CrmCardsOnPhone>
      <CrmTable columns={["20%", "22%", "30%", "28%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>Photos</th>
            <th className={crmThClassName}>The polyclinic</th>
            <th className={crmThClassName}>Where it was captured</th>
            <th className={crmThClassName}>{mode === "team" ? "Your comment" : "Decision"}</th>
          </tr>
        </thead>
        {groups.map(({ customers, total, venue: row }) => (
          <tbody key={row.sharedPlaceId} className="border-t-4 border-slate-200 first-of-type:border-t-0">
            <tr>
              <td className={crmTdClassName}>
                <div className="min-w-0 space-y-2">
                  <VenuePhotos row={row} />
                  {bulk ? <BulkPick picks={picks} row={row} /> : null}
                </div>
              </td>
              <td className={crmTdClassName}>
                <Venue mode={mode} row={row} />
              </td>
              <td className={crmTdClassName}>
                <Where row={row} />
              </td>
              <td className={crmTdClassName}>
                <LastColumn mode={mode} noteIndex={noteIndex} row={row} scope="table" />
              </td>
            </tr>
            <tr>
              <td className="border-b border-slate-200 bg-slate-50/60 p-0" colSpan={4}>
                <SeatedCustomers customers={customers} layout="table" mode={mode} noteIndex={noteIndex} total={total} venueTimetablePath={row.schedulePhotoPath} />
              </td>
            </tr>
          </tbody>
        ))}
      </CrmTable>
    </>
  );
}
