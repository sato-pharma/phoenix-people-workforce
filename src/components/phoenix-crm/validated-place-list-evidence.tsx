/**
 * Phoenix CRM — one place in use, as it is read: the photograph's size and what it is called, who
 * validated it, and the place the rep saved with what the system read on its signboard — or, for a
 * customer seated in a polyclinic, on the timetable inside it.
 *
 * Presentation only: nothing here decides or posts. The two controls are in
 * `validated-place-list-decision.tsx`; the table and its phone cards are in `validated-place-list.tsx`,
 * which also hands these pieces to the one-by-one review and to the boards that draw a place the same way.
 *
 * 🔴 WHAT THE SYSTEM READ IS A VERDICT, NEVER A DECISION, AND IT IS ALWAYS SAID IN WORDS. A reason added
 * later falls back to the verdict's own sentence, so it can never render as a code (`signboardText`).
 */

import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { CrmPill } from "@/components/phoenix-crm/ui";
import { decisionStamp } from "@/lib/phoenix-crm/decision-stamp";
import type { ValidatedPlaceRow } from "@/lib/phoenix-crm/view-types";

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

/** A place whose photo shows no readable name, sent back to its rep for a new one (2026-10-18). */
const SIGNBOARD_RETAKE_TEXT = "Sent back to the rep for a new photo";

function signboardText(signboard: NonNullable<ValidatedPlaceRow["signboard"]>): string {
  if (signboard.retake) return SIGNBOARD_RETAKE_TEXT;
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

function Who({ row, mode }: { row: ValidatedPlaceRow; mode: PlaceCheckNotesMode }) {
  // Who approved it and when, on the company board only: a district manager's board names nobody above
  // him (owner, 2026-10-13), and this is the SFE Manager's and the Super Admin's own record (2026-10-20).
  const approved = mode === "team" ? null : decisionStamp("Approved", row.decidedByName, row.decidedAtText);
  return (
    <div className="min-w-0 space-y-1">
      <p className="break-words text-sm font-black text-slate-900" dir="auto">
        {row.customerName}
      </p>
      <p className="break-words text-xs font-semibold text-slate-500">{[row.listType, row.speciality].filter(Boolean).join(" · ")}</p>
      <p className="break-words text-sm text-slate-700">{row.repName}</p>
      <p className="break-words text-xs text-slate-500">{row.territory}</p>
      <p className="break-words text-xs text-slate-500">Validated {row.validatedAtText}</p>
      {approved ? <p className="break-words text-xs font-semibold text-slate-700">{approved}</p> : null}
      <div className="flex min-w-0 flex-wrap gap-1">
        {row.reviewed ? null : <CrmPill tone="info">Never looked at</CrmPill>}
        {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
    </div>
  );
}

/** The fields the evidence block reads: a Place checks row, or a place another screen draws the same way. */
type PlaceEvidence = Pick<
  ValidatedPlaceRow,
  "photoKind" | "photo" | "pin" | "placeLabel" | "sharedPlaceName" | "address" | "brickName" | "areaName" | "mapsLink" | "schedule" | "signboard"
>;

function Place({ row }: { row: PlaceEvidence }) {
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

export { PHOTO_CLASS, photoAlt, Place, readingText, SCHEDULE_TEXT, signboardText, Who };
