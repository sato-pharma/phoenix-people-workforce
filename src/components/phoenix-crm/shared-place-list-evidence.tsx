"use client";

/**
 * Phoenix CRM — one polyclinic or centre, as it is read: its name, its kind and where it stands, the sign
 * on its door with what the system read on it, the one timetable photographed inside for everybody
 * seated there, and where it was captured.
 *
 * Presentation only: nothing here decides or posts. The decision is in `shared-place-list-decision.tsx`;
 * the table and its phone cards are in `shared-place-list.tsx`, which also hands these pieces to the
 * one-by-one review.
 *
 * 🔴 A MANAGER'S BOARD SAYS WHAT IS TRUE OF THE BUILDING, never that a decision waits on anybody or who
 * made one (owner, 2026-10-13) — `VenueStatus` and `TimetablePhoto` both read `mode`.
 */

import { usePlaceCheckDecides } from "@/components/phoenix-crm/place-check-decides";
import type { PlaceCheckNotesMode } from "@/components/phoenix-crm/place-check-notes";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import { CrmPill } from "@/components/phoenix-crm/ui";
import { buildingStatusPill } from "@/lib/phoenix-crm/approved-place-words";
import { sharedPlaceKindNoun } from "@/lib/phoenix-crm/shared-place-rules";
import { cn } from "@/lib/utils";
import type { VenueGroup } from "@/lib/phoenix-crm/shared-place-groups";
import type { SharedPlaceBoardRow } from "@/lib/phoenix-crm/view-types";

/**
 * What the system read on the sign of the BUILDING. A verdict on the venue's own name, never on a person's.
 * The match names the building's own kind (`sharedPlaceKindNoun`), never "polyclinic" for a hospital.
 */
const SIGNBOARD_TEXT: Record<string, string> = {
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
  not_comparable: "The sign is in another script from the name",
  unconfirmed: "Two readings of the sign disagreed",
  // 🔴 Never "yet": a building's sign is read at its capture, and no night pass reads it again.
  unreadable: "The sign could not be read at the capture",
  unreadable_final: "The sign could not be read",
};

function signboardText(signboard: NonNullable<SharedPlaceBoardRow["signboard"]>, kind: string | null): string {
  if (signboard.verdict === "match") return `The sign names this ${sharedPlaceKindNoun(kind)}`;
  if (signboard.verdict !== "unjudged") return SIGNBOARD_TEXT[signboard.verdict] ?? SIGNBOARD_TEXT.unjudged;
  return SIGNBOARD_UNJUDGED_TEXT[signboard.reason ?? ""] ?? SIGNBOARD_TEXT.unjudged;
}

function readingText(label: string, reading: SharedPlaceBoardRow["pin"]): string | null {
  if (!reading) return null;
  const accuracy = reading.accuracyMeters === null ? "accuracy unknown" : `within ${Math.round(reading.accuracyMeters)} m`;
  return `${label}: ${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} (${accuracy})`;
}

/**
 * Where the building stands, in one pill. A manager's board never says a decision waits on anybody, or
 * that somebody rejected it (owner, 2026-10-13) — it says what is true of the building.
 */
function VenueStatus({ mode, row }: { mode: PlaceCheckNotesMode; row: SharedPlaceBoardRow }) {
  const decides = usePlaceCheckDecides();
  if (row.status === "held") return <CrmPill tone="warn">{mode === "team" ? "Being checked" : decides ? "Waiting for you" : "Waiting for the administrator"}</CrmPill>;
  if (row.status === "retired") return <CrmPill tone="bad">{mode === "team" ? "No longer in use" : "Rejected"}</CrmPill>;
  // An approved building says so (owner, 21 Nov 2026: "it kept not approved"); a manager's board says only "In use".
  const pill = buildingStatusPill(row, mode);
  return <CrmPill tone={pill.tone}>{pill.text}</CrmPill>;
}

/**
 * The building, read first and read whole (owner, 2026-10-17: "every polyclinic should crystal clear
 * show me the name of the polyclinic and its data"): its name large, what kind of building it is and
 * where it stands, who captured it and when, and where it is.
 *
 * A phone card draws it in two parts (owner, 23 Nov 2026: "Fix what is under 9.5"; a closed building was
 * 256 to 300 px): `summary` is its name, its pills, and who captured it; `rest` is when and where, drawn
 * first inside the opened card. The table draws it whole.
 */
function VenueHeader({ mode, part, row }: { mode: PlaceCheckNotesMode; part?: "summary" | "rest"; row: SharedPlaceBoardRow }) {
  const where = [row.address, row.brickName, row.areaName].filter(Boolean).join(" · ");
  if (part === "rest") {
    return (
      <div className="min-w-0 space-y-1" data-venue-rest>
        <p className="break-words text-sm font-semibold text-slate-700">Captured {row.capturedAtText}</p>
        {where ? (
          <p className="break-words text-sm text-slate-500" dir="auto">
            {where}
          </p>
        ) : null}
      </div>
    );
  }
  return (
    <div className="min-w-0 flex-1 space-y-1.5">
      <h3 className="break-words text-lg font-black leading-tight text-slate-950" dir="auto">
        {row.name}
      </h3>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        <CrmPill>{row.kindLabel}</CrmPill>
        <VenueStatus mode={mode} row={row} />
        {row.waitingText ? <CrmPill tone={row.waitingLong ? "warn" : "neutral"}>{row.waitingText}</CrmPill> : null}
        <CrmPill tone={row.seated === 0 ? "neutral" : "info"}>
          {row.seated === 0 ? "Nobody seated yet" : `${row.seated} ${row.seated === 1 ? "customer seated" : "customers seated"}`}
        </CrmPill>
        {row.timetableExempt ? <CrmPill tone="info">No timetable</CrmPill> : null}
        {row.isTest ? <CrmPill>Test entry</CrmPill> : null}
      </div>
      <p className="break-words text-sm font-semibold text-slate-700">
        {part === "summary" ? `${row.repName} · ${row.territory}` : `${row.repName} · ${row.territory} · Captured ${row.capturedAtText}`}
      </p>
      {where && part !== "summary" ? (
        <p className="break-words text-sm text-slate-500" dir="auto">
          {where}
        </p>
      ) : null}
    </div>
  );
}

/** A photograph's own heading — drawn on the phone, where no table header names the column. */
function PhotoHeading({ children }: { children: string }) {
  return <p className="break-words text-phx-sm font-black uppercase tracking-[0.12em] text-slate-500">{children}</p>;
}

/** The sign on the building's own door, large, with what the reader saw on it. */
function SignPhoto({ headed, row }: { headed: boolean; row: SharedPlaceBoardRow }) {
  return (
    <div className="min-w-0 space-y-1.5">
      {headed ? <PhotoHeading>The sign on the building</PhotoHeading> : null}
      <CrmPhotoThumb alt={`Sign photo for ${row.name}`} className="h-64 w-full" lazy path={row.photoPath} rotatable />
      {row.signboard ? (
        <CrmPill tone={row.signboard.verdict === "match" ? "good" : row.signboard.verdict === "unjudged" ? "neutral" : "warn"}>
          {signboardText(row.signboard, row.kind)}
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
 *
 * 🔴 A BUILDING THE ADMINISTRATOR DECLARED HAS NO TIMETABLE IS NOT THAT FAULT (owner, 2026-10-18, City
 * clinic: "it does not have a timetable … make those doctors validated by the admin as an exception for
 * this polyclinic and show this"). It draws the exception in grey instead — and never the photograph on
 * file, which is the door of the clinic, not a timetable. A manager's board states the fact and not who
 * decided it (owner, 2026-10-13).
 */
function TimetablePhoto({
  customers,
  headed,
  mode,
  row,
}: {
  customers: VenueGroup["customers"];
  headed: boolean;
  mode: PlaceCheckNotesMode;
  row: SharedPlaceBoardRow;
}) {
  const read = customers.find((customer) => customer.timetable?.scheduleText)?.timetable?.scheduleText ?? null;
  if (row.timetableExempt) {
    return (
      <div className="min-w-0 space-y-1.5">
        {headed ? <PhotoHeading>The timetable inside</PhotoHeading> : null}
        <div className="flex min-h-32 w-full flex-col items-center justify-center gap-1 border border-dashed border-slate-300 bg-slate-50 px-4 py-4 text-center">
          <p className="break-words text-sm font-black text-slate-700">This building has no timetable.</p>
          {mode === "team" ? null : (
            <>
              <p className="break-words text-xs text-slate-700">Its customers are validated by the administrator as an exception.</p>
              <p className="break-words text-xs text-slate-500">
                Set by {row.timetableExempt.byName}, {row.timetableExempt.atText}
              </p>
            </>
          )}
        </div>
      </div>
    );
  }
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
      {/* The declaration that was taken back, and by whom (owner, 14 Nov 2026) — never on a manager's board. */}
      {mode === "team" || !row.timetableTakenBack ? null : (
        <p className="break-words text-xs text-slate-500">
          &ldquo;This building has no timetable&rdquo; was taken back by {row.timetableTakenBack.byName}, {row.timetableTakenBack.atText}. It had been declared by{" "}
          {row.timetableTakenBack.declaredByName}, {row.timetableTakenBack.declaredAtText}.
        </p>
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
        This building is not looked up in Google: the check reads a customer&apos;s own name, and a {sharedPlaceKindNoun(row.kind)} has none.
      </p>
    </div>
  );
}

export { SignPhoto, signboardText, TimetablePhoto, VenueHeader, Where };
