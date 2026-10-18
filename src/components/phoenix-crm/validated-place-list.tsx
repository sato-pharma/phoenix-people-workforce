"use client";

/**
 * Phoenix CRM — validations the system never held, and the Super Admin's power to refuse one — or,
 * since 2026-10-17, to approve one the system could not read (`Approve`, below).
 *
 * The Google check covers AM customers only (`googleCheckApplies`), so a doctor's validation is never
 * held and never appears in the queue above; an AM one that matched its listing does not either. Before
 * this list there was no way to take one back — it had to be undone in SQL.
 *
 * Refusing writes the same review the automatic check would have written and runs the same reject, so
 * the rep reads the system's own wording ("The system could not confirm this place") and never that
 * a person looked at him. Since 2026-10-08 the Super Admin also picks WHAT IS WRONG WITH THE PHOTO from
 * a closed list, and that one sentence is the only thing the rep is told; the note beside it is kept on
 * the record, never shown to him, and OPTIONAL since 2026-10-15 ("admin comment is optional").
 *
 * 🔴 REFUSING A PLACE THAT WAS APPROVED IN THE QUEUE ABOVE IS BETTER DONE THERE. This path upserts the
 * review row's `google` column wholesale to `refused_by_admin`, so the evidence the system held it on
 * is lost; the queue's own "Reject it after all" keeps it. This control is for the places that never
 * reached the queue at all, which is what it was built for.
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
import { SystemAdvice } from "@/components/phoenix-crm/system-advice";
import {
  CrmButton,
  CrmCardsOnPhone,
  CrmEmpty,
  CrmNote,
  CrmPill,
  CrmSearchField,
  CrmShowMore,
  CrmTable,
  crmTdClassName,
  crmTextareaClassName,
  crmThClassName,
} from "@/components/phoenix-crm/ui";
import { adviseOnPlaceInUse } from "@/lib/phoenix-crm/place-check-advice";
import { placeNoteSubjectKey } from "@/lib/phoenix-crm/place-note-rules";
import { VALIDATION_NOTE_LABEL, type ValidationRefusalReason } from "@/lib/phoenix-crm/validation-feedback";
import type { PlaceNoteIndex, ValidatedPlaceRow } from "@/lib/phoenix-crm/view-types";

/**
 * The empty index, for the callers that use this list on its own and know nothing about comments. A
 * module-level constant rather than an inline `{}` default: a fresh object every render would remount
 * nothing here but would defeat any memo a later caller adds.
 */
const EMPTY_INDEX: PlaceNoteIndex = { integrity: {}, notes: {}, recommendations: {} };

/** What the system read on the signboard, in the Super Admin's words. A verdict, never a decision. */
const SIGNBOARD_TEXT: Record<NonNullable<ValidatedPlaceRow["signboard"]>["verdict"], string> = {
  match: "The signboard names this customer",
  other_name: "The signboard names somebody else",
  no_name: "No name to judge on the signboard",
  unjudged: "The signboard could not be read",
};

/**
 * 🔴 `unjudged` BECAME FOUR DIFFERENT ANSWERS ON 2026-10-09, AND ONE SENTENCE IS WRONG FOR THREE OF
 * THEM. "Could not be read" fits a frame still waiting for another attempt; it is misleading for a
 * verdict two readings disagreed about, it hides that a place has already had every attempt it gets,
 * and it says nothing about a place there was never anything to compare. A reason not named here
 * falls back to the verdict's own sentence, so a reason added later can never render as a code.
 */
const SIGNBOARD_UNJUDGED_TEXT: Record<string, string> = {
  name_unusable: "Nothing on a signboard to compare",
  unconfirmed: "Two readings of the sign disagreed",
  unreadable: "The signboard could not be read yet",
  unreadable_final: "The signboard could not be read",
};

function signboardText(signboard: NonNullable<ValidatedPlaceRow["signboard"]>): string {
  if (signboard.verdict !== "unjudged") return SIGNBOARD_TEXT[signboard.verdict];
  return SIGNBOARD_UNJUDGED_TEXT[signboard.reason ?? ""] ?? SIGNBOARD_TEXT.unjudged;
}

/**
 * What the system read on the TIMETABLE of a customer seated in a polyclinic (owner, 2026-10-09).
 * A seated place has no signboard of its own — the sign on the building names the venue — so the
 * evidence is the schedule hanging inside it, and these are the four things it can say.
 */
const SCHEDULE_TEXT: Record<NonNullable<ValidatedPlaceRow["schedule"]>["verdict"], string> = {
  match: "The timetable names this customer",
  other_name: "The timetable names somebody else",
  no_schedule: "No timetable in the photo",
  unjudged: "The timetable could not be read",
};

const PAGE = 25;

/**
 * The photograph, large: the full width of its column (a third of the table on a laptop, the whole card
 * on a phone) and 20rem tall, shown whole and turnable. It was a 128-pixel square, and at that size an
 * unreadable sign and an unreadable photo of a pavement look the same (owner, 2026-10-17: "I must be
 * able to see the photos").
 */
const PHOTO_CLASS = "h-80 w-full";

/** What the photo IS, so a blind reader is never told a timetable is a signboard. */
function photoAlt(row: ValidatedPlaceRow): string {
  return `${row.photoKind === "schedule" ? "Timetable" : "Signboard"} photo for ${row.customerName}`;
}

function readingText(label: string, reading: ValidatedPlaceRow["pin"]): string | null {
  if (!reading) return null;
  const accuracy = reading.accuracyMeters === null ? "accuracy unknown" : `within ${Math.round(reading.accuracyMeters)} m`;
  return `${label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} (${accuracy})`;
}

function Who({ row }: { row: ValidatedPlaceRow }) {
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{[row.listType, row.speciality].filter(Boolean).join(" · ")}</p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      <p className="break-words text-xs text-slate-500">Validated {row.validatedAtText}</p>
      <div className="flex min-w-0 flex-wrap gap-1">
        {row.reviewed ? null : <CrmPill tone="info">Never looked at</CrmPill>}
        {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
    </div>
  );
}

function Place({ row }: { row: ValidatedPlaceRow }) {
  // A SEATED customer has no reading of his own: his point is the polyclinic's, frozen when the venue
  // itself was validated, so `pin` and `photo` are both empty by construction and saying "no reading"
  // is the honest line rather than an empty space the reader has to interpret.
  const seated = row.photoKind === "schedule";
  const readings = [readingText("Photo", row.photo), readingText("Capture location", row.pin)].filter((line): line is string => line !== null);
  return (
    <div className="min-w-0 space-y-0.5 text-sm text-slate-700">
      {row.placeLabel ? (
        <p className="break-words font-semibold" dir="auto">
          {row.placeLabel}
        </p>
      ) : null}
      {seated && row.sharedPlaceName ? (
        <p className="break-words text-xs font-black text-slate-700" dir="auto">
          Seated in {row.sharedPlaceName}
        </p>
      ) : null}
      {row.address ? <p className="break-words text-xs text-slate-500">{row.address}</p> : null}
      {row.brickName || row.areaName ? <p className="break-words text-xs text-slate-500">{[row.brickName, row.areaName].filter(Boolean).join(" · ")}</p> : null}
      {seated ? (
        <p className="break-words text-xs text-slate-500">No reading of its own — the point is the polyclinic&apos;s, taken when it was validated.</p>
      ) : (
        readings.map((line) => (
          <p key={line} className="break-words text-xs text-slate-500">
            {line}
          </p>
        ))
      )}
      <a className="inline-block text-xs font-black text-orange-700 underline underline-offset-2" href={row.mapsLink} rel="noreferrer" target="_blank">
        {seated ? "Open the building in Google Maps" : "Open where they stood in Google Maps"}
      </a>
      <div className="space-y-0.5 border-t border-slate-100 pt-1">
        {seated ? (
          <>
            {row.schedule ? (
              <CrmPill tone={row.schedule.verdict === "match" ? "good" : row.schedule.verdict === "unjudged" ? "neutral" : "warn"}>
                {SCHEDULE_TEXT[row.schedule.verdict]}
              </CrmPill>
            ) : (
              <p className="text-xs text-slate-500">The timetable has not been read yet.</p>
            )}
            {row.schedule?.hoursRead ? (
              <p className="break-words text-xs text-slate-700" dir="auto">
                Hours read: {row.schedule.hoursRead}
              </p>
            ) : null}
            {row.schedule?.scheduleText ? (
              <p className="break-words text-xs text-slate-700" dir="auto">
                {row.schedule.scheduleText}
              </p>
            ) : null}
          </>
        ) : (
          <>
            {row.signboard ? (
              <CrmPill tone={row.signboard.verdict === "match" ? "good" : row.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
                {signboardText(row.signboard)}
              </CrmPill>
            ) : (
              <p className="text-xs text-slate-500">The signboard has not been read yet.</p>
            )}
            {row.signboard?.signText ? (
              <p className="break-words text-xs text-slate-700" dir="auto">
                {row.signboard.signText}
              </p>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** What refusing this row costs, in plain words — read before the button, not after. */
function Cost({ row }: { row: ValidatedPlaceRow }) {
  const lines = [
    row.otherPlaces === 0
      ? "They go back to To validate — this is the customer's only place."
      : `The customer keeps ${row.otherPlaces === 1 ? "their other place" : `their other ${row.otherPlaces} places`}, so they stay validated.`,
    row.visits === 0 ? "No visit is measured against it yet." : `${row.visits} ${row.visits === 1 ? "visit is" : "visits are"} measured against it, and ${row.visits === 1 ? "it loses its distance" : "they lose their distances"}.`,
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
 * 🔴 FOLDED UNTIL HE PRESSES IT (owner, 2026-10-17: "make me see what is the unreadable — the photos, I
 * must be able to see the photos"). The reason list, the note and the cost stood open on every row, so
 * the form was most of the row and the photograph a 113-pixel square beside it. Closed, a row is the
 * photo, who took it, what the reader saw, the system's advice and one button.
 */
function Refuse({ row }: { row: ValidatedPlaceRow }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  // Opens on the reason the system's own confident reading gives, and on nothing otherwise.
  const [reason, setReason] = useState<ValidationRefusalReason | "">(() => adviseOnPlaceInUse(row).refusal ?? "");
  const [armed, setArmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function refuse() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/refuse", { placeId: row.placeId, note, refusalReason: reason }, "refused");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
      setArmed(false);
    }
  }

  if (!open) {
    return (
      <CrmButton onClick={() => setOpen(true)} variant="danger">
        Refuse this validation
      </CrmButton>
    );
  }

  return (
    <div className="space-y-2">
      <Cost row={row} />
      <RefusalReasonField
        disabled={saving}
        id={`refuse-reason-${row.placeId}`}
        kind={row.photoKind}
        onChange={(next) => {
          setReason(next);
          setArmed(false);
        }}
        value={reason}
      />
      <label className="block text-xs font-black uppercase tracking-[0.12em] text-slate-500" htmlFor={`refuse-note-${row.placeId}`}>
        {VALIDATION_NOTE_LABEL}
      </label>
      <textarea
        className={crmTextareaClassName}
        disabled={saving}
        id={`refuse-note-${row.placeId}`}
        maxLength={500}
        onChange={(event) => {
          setNote(event.target.value);
          setArmed(false);
        }}
        rows={2}
        value={note}
      />
      <RefusalNoteHint />
      {armed ? (
        <div className="space-y-2">
          <CrmNote tone="warn">This retires the place and cannot be undone — they validate the customer again from their own list.</CrmNote>
          <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
            <CrmButton disabled={saving} onClick={() => void refuse()} variant="danger">
              {saving ? "Refusing…" : "Yes, refuse it"}
            </CrmButton>
            <CrmButton disabled={saving} onClick={() => setArmed(false)}>
              Keep it
            </CrmButton>
          </div>
        </div>
      ) : (
        <div className="grid gap-2 sm:grid-cols-2 md:grid-cols-1 xl:grid-cols-2">
          <CrmButton disabled={reason === ""} onClick={() => setArmed(true)} variant="danger">
            Refuse it
          </CrmButton>
          <CrmButton disabled={saving} onClick={() => setOpen(false)}>
            Cancel
          </CrmButton>
        </div>
      )}
      {reason === "" && !armed ? <p className="text-xs text-slate-500">Choose what is wrong with the photo first.</p> : null}
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * Confirm it himself (owner, 2026-10-17: *"make me able to approve"* — "I can read them. So why you
 * cannot?"). One press: the customer is already validated, so approving changes nothing the rep sees;
 * it records that the Super Admin looked and confirmed, and the place leaves Not confirmed.
 */
function Approve({ row }: { row: ValidatedPlaceRow }) {
  const router = useRouter();
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function approve() {
    if (saving) return;
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<unknown>("/api/phoenix-crm/validation-reviews/approve", { placeId: row.placeId, note: "" }, "approved");
      router.refresh();
    } catch (error) {
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      <CrmButton disabled={saving} onClick={() => void approve()} variant="primary">
        {saving ? "Approving…" : "Approve this validation"}
      </CrmButton>
      {problem ? <CrmNote tone="bad">{problem}</CrmNote> : null}
    </div>
  );
}

/**
 * `showSearch` is false when the board above owns the filtering (the Place checks page) — the list is
 * then handed rows that are already narrowed, and its own search box would be a second, confusing one.
 * It stays true by default so the component keeps its own search anywhere it is used on its own.
 */
/**
 * The last column, both modes together.
 *
 * 🔴 `Refuse` IS NOT RENDERED FOR A MANAGER, AND NEITHER IS ITS WARNING. Refusing a validation retires
 * the place and can send the customer back to To validate — it is a decision, and the decision is the
 * Super Admin's alone. A manager comments and recommends, and the owner's instruction on 2026-10-13 was
 * that his screen does not say who makes the call.
 */
function LastColumn({ mode, noteIndex, row }: { mode: PlaceCheckNotesMode; noteIndex: PlaceNoteIndex; row: ValidatedPlaceRow }) {
  const key = placeNoteSubjectKey("place", row.placeId);
  return (
    <div className="min-w-0 space-y-2">
      {/* The system's recommendation and its reason (owner, 2026-10-17) — the Super Admin's board only. */}
      {mode === "team" ? null : <SystemAdvice advice={adviseOnPlaceInUse(row)} />}
      {mode === "team" ? null : <Approve row={row} />}
      {mode === "team" ? null : <Refuse row={row} />}
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
 * Answering several at once (owner, 2026-10-15: "also make me able to multiple select and response";
 * Approve added 2026-10-17). Each runs the row's OWN request per place — same route, same reason, same
 * note — so there is no second decision path; see `place-check-bulk.tsx`.
 */
const IN_USE_ACTIONS: ReadonlyArray<BulkAction<ValidatedPlaceRow>> = [
  {
    key: "approve",
    label: "Approve",
    busyLabel: "Approving",
    variant: "primary",
    needsReason: false,
    takes: () => true,
    run: (row, answer) => crmPost<unknown>("/api/phoenix-crm/validation-reviews/approve", { placeId: row.placeId, note: answer.note }, "approved"),
  },
  {
    key: "refuse",
    label: "Refuse",
    busyLabel: "Refusing",
    variant: "danger",
    needsReason: true,
    warning: (count) =>
      `This retires ${count === 1 ? "that place" : `those ${count} places`} and cannot be undone here; each customer left without one validates again from their own list.`,
    takes: () => true,
    run: (row, answer) =>
      crmPost<unknown>("/api/phoenix-crm/validation-reviews/refuse", { placeId: row.placeId, note: answer.note, refusalReason: answer.reason }, "refused"),
  },
];

export function ValidatedPlaceList({
  mode = "company",
  noteIndex = EMPTY_INDEX,
  rows,
  showSearch = true,
}: {
  mode?: PlaceCheckNotesMode;
  noteIndex?: PlaceNoteIndex;
  rows: ValidatedPlaceRow[];
  showSearch?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const bulk = mode === "company";

  const found = useMemo(() => {
    const wanted = query.trim().toLowerCase();
    if (!wanted) return rows;
    return rows.filter((row) =>
      [row.customerName, row.repName, row.territory, row.placeLabel, row.brickName, row.areaName, row.address]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .some((value) => value.toLowerCase().includes(wanted)),
    );
  }, [query, rows]);
  const shown = found.slice(0, page * PAGE);
  // The PAGE is what can be picked, never the whole filtered set: a tick box is only honest about a
  // row on screen, and "Pick all" that reached 600 places behind a Show more would be a trap.
  const picks = useRowPicks<ValidatedPlaceRow>(bulk ? shown : [], (row) => row.placeId);
  const kind = picks.picked.length > 0 && picks.picked.every((row) => row.photoKind === "schedule") ? "schedule" : "signboard";

  return (
    <div className="min-w-0 space-y-3">
      {showSearch ? (
        <div className="px-4 pt-4 md:max-w-md">
          <CrmSearchField
            id="validated-place-search"
            label="Find a customer, a rep or a territory"
            onChange={(next) => {
              setQuery(next);
              setPage(1);
            }}
            placeholder="Name, rep, brick or area"
            value={query}
          />
        </div>
      ) : null}

      {found.length === 0 ? (
        <div className="px-4 pb-4">
          <CrmEmpty message={showSearch ? "Nothing here matches what you typed." : "Nothing here matches these filters."} title="No validation found" />
        </div>
      ) : (
        <>
          {bulk ? (
            <BulkDecideBar
              actions={IN_USE_ACTIONS}
              // Both answers are here since 2026-10-17, so both quick picks are offered; "look yourself" is neither.
              adviceOf={(row) => {
                const advice = adviseOnPlaceInUse(row).kind;
                return advice === "look" ? null : advice;
              }}
              kind={kind}
              nameOf={(row) => row.customerName}
              picks={picks}
            />
          ) : null}
          <CrmCardsOnPhone>
            {shown.map((row) => (
              <div key={row.placeId} className="space-y-3 px-4 py-4">
                {bulk ? <BulkPick picks={picks} row={row} /> : null}
                {/* The photograph IS the question on this list, so on a phone it takes the card's whole width. */}
                <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy path={row.photoPath} rotatable />
                <Who row={row} />
                <Place row={row} />
                <LastColumn mode={mode} noteIndex={noteIndex} row={row} />
              </div>
            ))}
          </CrmCardsOnPhone>
          <CrmTable columns={["36%", "20%", "24%", "20%"]}>
            <thead>
              <tr>
                <th className={crmThClassName}>Photo</th>
                <th className={crmThClassName}>Customer and rep</th>
                <th className={crmThClassName}>The place they saved</th>
                <th className={crmThClassName}>{mode === "team" ? "Your comment" : "Approve or refuse"}</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <tr key={row.placeId} className="even:bg-slate-50/60">
                  <td className={crmTdClassName}>
                    <div className="min-w-0 space-y-2">
                      <CrmPhotoThumb alt={photoAlt(row)} className={PHOTO_CLASS} lazy path={row.photoPath} rotatable />
                      {bulk ? <BulkPick picks={picks} row={row} /> : null}
                    </div>
                  </td>
                  <td className={crmTdClassName}>
                    <Who row={row} />
                  </td>
                  <td className={crmTdClassName}>
                    <Place row={row} />
                  </td>
                  <td className={crmTdClassName}>
                    <LastColumn mode={mode} noteIndex={noteIndex} row={row} />
                  </td>
                </tr>
              ))}
            </tbody>
          </CrmTable>
          <div className="px-4 pb-4">
            <CrmShowMore left={found.length - shown.length} onMore={() => setPage((current) => current + 1)} page={PAGE} />
          </div>
        </>
      )}
    </div>
  );
}
