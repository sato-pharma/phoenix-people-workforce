"use client";

/**
 * Phoenix CRM — pages 2 to 5 of a polyclinic's timetable (owner, 25 Nov 2026: "make the rep able to
 * upload multiple photos for a timetable … he can validate 1, 2, 3 doctors in one timetable if it has
 * their name").
 *
 * Drawn under the first timetable photo once it is taken. Each extra photo is a live capture of its own,
 * stamped like the first; "Add another photo of the timetable" opens one more camera, up to five photos
 * in all, and each one can be removed. The server reads every photo, and a customer named on any of
 * them counts (`bestTimetablePageCheck`).
 *
 * A slot is `null` while its camera is open and nothing is taken yet; only taken photos are sent.
 */

import { ImagePlus, Trash2 } from "lucide-react";

import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import { LivePhotoCapture, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { CrmButton } from "@/components/phoenix-crm/ui";
import { TIMETABLE_ADD_PAGE, TIMETABLE_EXTRA_PAGES_MAX, TIMETABLE_PAGES_HINT } from "@/lib/phoenix-crm/timetable-pages-rules";

export type TimetableExtraSlots = Array<CapturedPhoto | null>;

/** The paths to send: taken photos only, in the order they were added. */
export function timetableExtraPaths(slots: TimetableExtraSlots): string[] {
  return slots.filter((slot): slot is CapturedPhoto => slot !== null).map((slot) => slot.path);
}

/** Frees every extra photo's preview, as the screen frees the first one's. */
export function releaseTimetableExtras(slots: TimetableExtraSlots) {
  for (const slot of slots) releaseCapturedPhoto(slot);
}

export function TimetableExtraPhotos({
  disabled = false,
  onChange,
  seatId,
  test,
  title,
  value,
}: {
  disabled?: boolean;
  onChange: (update: (current: TimetableExtraSlots) => TimetableExtraSlots) => void;
  seatId: string;
  test: boolean;
  /** The stamp burned into each photo — the building's, exactly as on the first. */
  title: string;
  value: TimetableExtraSlots;
}) {
  const canAdd = value.length < TIMETABLE_EXTRA_PAGES_MAX && value.every((slot) => slot !== null);
  return (
    <div className="mt-3 grid gap-3">
      {value.map((slot, index) => (
        <div className="border-t border-slate-100 pt-3" key={index}>
          <div className="mb-2 flex min-w-0 flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-black text-slate-950">Timetable photo {index + 2}</p>
            <CrmButton
              disabled={disabled}
              onClick={() =>
                onChange((current) => {
                  releaseCapturedPhoto(current[index]);
                  return current.filter((_, at) => at !== index);
                })
              }
              size="sm"
              variant="secondary"
            >
              <Trash2 aria-hidden className="h-4 w-4" />
              Remove this photo
            </CrmButton>
          </div>
          <LivePhotoCapture
            disabled={disabled}
            onChange={(photo) => onChange((current) => current.map((entry, at) => (at === index ? photo : entry)))}
            purpose="place"
            seatId={seatId}
            test={test}
            title={title}
            value={slot}
          />
        </div>
      ))}
      {canAdd ? (
        <div className="grid gap-1.5">
          <p className="break-words text-xs font-semibold leading-5 text-slate-500">{TIMETABLE_PAGES_HINT}</p>
          <div className="grid gap-2 sm:flex sm:flex-wrap">
            <CrmButton disabled={disabled} onClick={() => onChange((current) => [...current, null])} size="sm" variant="secondary">
              <ImagePlus aria-hidden className="h-4 w-4" />
              {TIMETABLE_ADD_PAGE}
            </CrmButton>
          </div>
        </div>
      ) : null}
    </div>
  );
}
