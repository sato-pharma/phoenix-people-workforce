/**
 * Phoenix CRM — the Super Admin's queue: what one held place is read with. The photograph's size and what
 * it is called, who captured it, and the evidence the system judged on — where the rep's phone put him,
 * what the sign or the timetable says, and every listing Google returned for the customer's name.
 *
 * Presentation only: nothing here decides or posts. The controls are in
 * `validation-review-queue-decision.tsx`; the table and its phone cards are in
 * `validation-review-queue.tsx`, which also hands these pieces to the one-by-one review.
 *
 * 🔴 A TIMETABLE ROW NEVER FALLS THROUGH TO GOOGLE. No listing was ever asked for on a seating, so the
 * listings are drawn only where a listing was the question (`Evidence`).
 */

import { CrmPill } from "@/components/phoenix-crm/ui";
import { earlierDecisionText } from "@/lib/phoenix-crm/earlier-decision";
import type { ValidationReviewRow } from "@/lib/phoenix-crm/view-types";

const REASON_TEXT: Record<NonNullable<ValidationReviewRow["reason"]>, string> = {
  no_confident_listing: "Google has no listing the system is sure is this customer.",
  lookup_failed: "Google Maps could not be asked at the time (no answer).",
  listing_far: "Google's pin for this customer is over 1 km from them: the hospital may have moved, or the pin is old.",
  listing_off:
    "The rep was refused once for standing away from this customer's Google pin, and captured the same place again — so it is here instead of being refused a second time. Both their readings are precise; the distance to each listing is below.",
  refused_by_admin: "The system did not question this one — it was rejected here, by hand. The reason is the note.",
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
      {row.waitingText ? <CrmPill tone={row.waitingLong ? "warn" : "neutral"}>{row.waitingText}</CrmPill> : null}
      {/* A new capture of a customer already decided says so (owner, 22 Nov 2026), or it reads as the row just decided. */}
      {row.earlierDecision ? <p className="break-words text-xs font-semibold text-slate-700">{earlierDecisionText(row.earlierDecision)}</p> : null}
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

export { Evidence, PHOTO_CLASS, photoAlt, Who };
