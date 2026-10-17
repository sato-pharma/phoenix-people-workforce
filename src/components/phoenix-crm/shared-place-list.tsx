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
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
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
import { adviseOnBuilding } from "@/lib/phoenix-crm/place-check-advice";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { cn } from "@/lib/utils";
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

/**
 * Where the building stands, in one pill. A manager's board never says a decision waits on anybody, or
 * that somebody rejected it (owner, 2026-10-13) — it says what is true of the building.
 */
function VenueStatus({ mode, row }: { mode: PlaceCheckNotesMode; row: SharedPlaceBoardRow }) {
  if (row.status === "held") return <CrmPill tone="warn">{mode === "team" ? "Being checked" : "Waiting for you"}</CrmPill>;
  if (row.status === "retired") return <CrmPill tone="bad">{mode === "team" ? "No longer in use" : "Rejected"}</CrmPill>;
  return <CrmPill tone="good">In use</CrmPill>;
}

/**
 * The building, read first and read whole (owner, 2026-10-17: "every polyclinic should crystal clear
 * show me the name of the polyclinic and its data"): its name large, what kind of building it is and
 * where it stands, who captured it and when, and where it is.
 */
function VenueHeader({ mode, row }: { mode: PlaceCheckNotesMode; row: SharedPlaceBoardRow }) {
  const where = [row.address, row.brickName, row.areaName].filter(Boolean).join(" · ");
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <h3 className="break-words text-lg font-black leading-tight text-slate-950" dir="auto">
        {row.name}
      </h3>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <CrmPill>{row.kindLabel}</CrmPill>
        <VenueStatus mode={mode} row={row} />
        <CrmPill tone={row.seated === 0 ? "neutral" : "info"}>
          {row.seated === 0 ? "Nobody seated yet" : `${row.seated} ${row.seated === 1 ? "customer seated" : "customers seated"}`}
        </CrmPill>
        {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
      <p className="break-words text-sm font-semibold text-slate-700">
        {row.repName} · {row.territory} · Captured {row.capturedAtText}
      </p>
      {where ? (
        <p className="break-words text-sm text-slate-500" dir="auto">
          {where}
        </p>
      ) : null}
    </div>
  );
}

/** A photograph's own heading — drawn on the phone, where no table header names the column. */
function PhotoHeading({ children }: { children: string }) {
  return <p className="break-words text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{children}</p>;
}

/** The sign on the building's own door, large, with what the reader saw on it. */
function SignPhoto({ headed, row }: { headed: boolean; row: SharedPlaceBoardRow }) {
  return (
    <div className="min-w-0 space-y-1.5">
      {headed ? <PhotoHeading>The sign on the building</PhotoHeading> : null}
      <CrmPhotoThumb alt={`Sign photo for ${row.name}`} className="h-64 w-full" lazy path={row.photoPath} rotatable />
      {row.signboard ? (
        <CrmPill tone={row.signboard.verdict === "match" ? "good" : row.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
          {signboardText(row.signboard)}
        </CrmPill>
      ) : (
        <p className="break-words text-xs text-slate-500">The sign has not been read yet.</p>
      )}
      {row.signboard?.signText ? (
        <p className="break-words text-xs text-slate-700" dir="auto">
          Read on it: {row.signboard.signText}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The ONE timetable photographed inside for everybody seated there, large, with what the reader found on
 * it. The building is read once and every customer is judged against that one reading, so the text is
 * the same on every customer's row; it is taken from the first that carries it. A building with
 * customers seated in it and no timetable on file is the fault the owner named first ("no timetables"),
 * so that empty frame says so in rose rather than in grey.
 */
function TimetablePhoto({ customers, headed, row }: { customers: VenueGroup["customers"]; headed: boolean; row: SharedPlaceBoardRow }) {
  const read = customers.find((customer) => customer.timetable?.scheduleText)?.timetable?.scheduleText ?? null;
  return (
    <div className="min-w-0 space-y-1.5">
      {headed ? <PhotoHeading>The timetable inside</PhotoHeading> : null}
      {row.schedulePhotoPath ? (
        <>
          <CrmPhotoThumb alt={`Timetable photo for ${row.name}`} className="h-64 w-full" lazy path={row.schedulePhotoPath} rotatable />
          {row.schedulePhotoCapturedAtText ? <p className="break-words text-xs text-slate-500">Photographed {row.schedulePhotoCapturedAtText}</p> : null}
          {read ? (
            <p className="break-words text-xs text-slate-700" dir="auto">
              Read on it: {read}
            </p>
          ) : null}
        </>
      ) : (
        <div
          className={cn(
            "flex h-64 w-full items-center justify-center border border-dashed px-4 text-center text-sm font-black",
            row.seated > 0 ? "border-rose-300 bg-rose-50 text-rose-800" : "border-slate-300 bg-slate-50 text-slate-500",
          )}
        >
          <span className="break-words">
            {row.seated > 0
              ? `No timetable on file, and ${row.seated === 1 ? "1 customer is" : `${row.seated} customers are`} seated here.`
              : "No timetable yet. The first customer seated here brings it."}
          </span>
        </div>
      )}
    </div>
  );
}

function Where({ row }: { row: SharedPlaceBoardRow }) {
  const readings = [readingText("Photo", row.photo), readingText("Capture location", row.pin)].filter((line): line is string => line !== null);
  return (
    <div className="min-w-0 space-y-1 text-sm text-slate-700">
      {readings.map((line) => (
        <p key={line} className="break-words text-xs text-slate-500">
          {line}
        </p>
      ))}
      <a className="inline-block text-xs font-black text-orange-700 underline underline-offset-2" href={row.mapsLink} rel="noreferrer" target="_blank">
        Open the building in Google Maps
      </a>
      <p className="break-words border-t border-slate-100 pt-1 text-xs text-slate-500">
        This building is not looked up in Google: the check reads a customer&apos;s own name, and a polyclinic has none.
      </p>
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
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => adviseOnBuilding(row).refusal ?? "");
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
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the Super Admin's board only. */}
      {mode === "team" ? null : <SystemAdvice advice={adviseOnBuilding(row)} />}
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
 * The polyclinics and centres, each as ONE group: the building's name and where it is, the sign on its
 * door and its timetable side by side and large enough to read (owner, 2026-10-17: "every polyclinic
 * should crystal clear show me the name of the polyclinic and its data and the customer the rep added to
 * this polyclinic and the captured timetable crystal clear"), then the customers seated in it with what
 * that timetable says about each. The customers are drawn by `SeatedCustomers`, directly under their
 * building, so a polyclinic is never read apart from the people behind its door.
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
      {bulk ? (
        <BulkDecideBar
          actions={VENUE_ACTIONS}
          adviceOf={(row) => (row.restorable ? null : adviseOnBuilding(row).kind)}
          nameOf={(row) => row.name}
          picks={picks}
        />
      ) : null}
      <CrmCardsOnPhone>
        {groups.map(({ customers, total, venue: row }) => (
          <div key={row.sharedPlaceId} className="space-y-3 border-t-4 border-slate-200 first:border-t-0">
            <div className="space-y-4 px-4 pt-4">
              <div className="flex min-w-0 items-start gap-3">
                {bulk ? <BulkPick picks={picks} row={row} /> : null}
                <VenueHeader mode={mode} row={row} />
              </div>
              <div className="grid min-w-0 gap-4 sm:grid-cols-2">
                <SignPhoto headed row={row} />
                <TimetablePhoto customers={customers} headed row={row} />
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
      <CrmTable columns={["27%", "27%", "18%", "28%"]}>
        <thead>
          <tr>
            <th className={crmThClassName}>The sign on the building</th>
            <th className={crmThClassName}>The timetable inside</th>
            <th className={crmThClassName}>Where it was captured</th>
            <th className={crmThClassName}>{mode === "team" ? "Your comment" : "Decision"}</th>
          </tr>
        </thead>
        {groups.map(({ customers, total, venue: row }) => (
          <tbody key={row.sharedPlaceId} className="border-t-4 border-slate-200 first-of-type:border-t-0">
            <tr>
              <td className={cn(crmTdClassName, "border-b-0 bg-white pb-1 pt-4")} colSpan={4}>
                <div className="flex min-w-0 items-start gap-3">
                  {bulk ? <BulkPick picks={picks} row={row} /> : null}
                  <VenueHeader mode={mode} row={row} />
                </div>
              </td>
            </tr>
            <tr>
              <td className={crmTdClassName}>
                <SignPhoto headed={false} row={row} />
              </td>
              <td className={crmTdClassName}>
                <TimetablePhoto customers={customers} headed={false} row={row} />
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
