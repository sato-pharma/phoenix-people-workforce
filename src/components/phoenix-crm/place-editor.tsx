"use client";

/**
 * Phoenix CRM — one place of a customer, as the rep enters it at the clinic: the live photo of the sign
 * or door (the location is taken with it), the days and hours the place receives visits, and its
 * details.
 *
 * Owner, 2026-09-16: a customer is real only with a live photo, the location captured on the spot and
 * at least one timing; timings belong to the place, so a doctor who receives in two places has two.
 */

import { dayLabelWithYear } from "@/components/phoenix-crm/format";
import { LivePhotoCapture, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { TimingsEditor, timingsToDrafts } from "@/components/phoenix-crm/timings-editor";
import { CrmBlock, CrmField, crmInputClassName } from "@/components/phoenix-crm/ui";
import { PLACE_TEXT_MAX } from "@/lib/phoenix-crm/entry-rules";
import { parseTimings } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

/** The server keeps a zone to this length (src/lib/phoenix-crm/entry-rules.ts parsePlaceDraft). */
const ZONE_TEXT_MAX = 80;

export type PlaceDraftState = {
  photo: CapturedPhoto | null;
  label: string;
  address: string;
  zone: string;
  timings: PhoenixCrmTiming[];
};

/** Updates arrive as functions of the latest draft: a photo finishes uploading while the rep types. */
export type PlaceDraftUpdate = (update: (current: PlaceDraftState) => PlaceDraftState) => void;

export function emptyPlaceDraft(): PlaceDraftState {
  return { photo: null, label: "", address: "", zone: "", timings: [] };
}

/** The server's own checks, so a gap is named before the save leaves the phone. */
export function placeDraftProblem(draft: PlaceDraftState, options: { needsPhoto: boolean }): string | null {
  if (options.needsPhoto && !draft.photo) return "Take a live photo of the clinic sign or door.";
  const checked = parseTimings(timingsToDrafts(draft.timings));
  return checked.ok ? null : checked.error;
}

/** The place as /api/phoenix-crm/list/validate and /list/places read it. The brick comes from the location. */
export function placePayload(photo: CapturedPhoto, draft: PlaceDraftState) {
  return {
    photoPath: photo.path,
    lat: photo.lat,
    lon: photo.lon,
    accuracyMeters: photo.accuracyMeters,
    deviceCapturedAt: photo.deviceCapturedAt,
    label: draft.label.trim() || null,
    address: draft.address.trim() || null,
    zone: draft.zone.trim() || null,
    brick: null,
    timings: timingsToDrafts(draft.timings),
  };
}

/** "Ramadan runs Mon 8 Feb 2027 to Mon 8 Mar 2027 …" for the timings editor. */
export function ramadanHoursNote(ramadan: { startsOn: string; endsOn: string } | null, cairoToday: string): string | null {
  if (!ramadan) return null;
  const inForce = cairoToday >= ramadan.startsOn && cairoToday <= ramadan.endsOn;
  return `${inForce ? "Ramadan runs" : "The next Ramadan runs"} ${dayLabelWithYear(ramadan.startsOn)} to ${dayLabelWithYear(ramadan.endsOn)}. Ramadan hours are used on those days.`;
}

/** A field the rep typed stays; one the last photo filled follows the new photo. */
function carried(typed: string, previousAuto: string | null | undefined, nextAuto: string | null | undefined, max: number): string {
  if (typed.trim() && typed !== (previousAuto ?? "").slice(0, max)) return typed;
  return (nextAuto ?? "").slice(0, max);
}

export function PlaceEditor({
  capture,
  customerName,
  disabled = false,
  firstStep,
  idPrefix,
  onChange,
  photoBlockedReason = null,
  ramadanNote,
  seatId,
  test,
  value,
  weakGpsMeters,
}: {
  /** A new place takes a live photo; changing a saved place keeps its photo and location. */
  capture: boolean;
  customerName: string;
  disabled?: boolean;
  /** The number of this editor's first step on the screen ("2 · Live photo"). */
  firstStep: number;
  idPrefix: string;
  onChange: PlaceDraftUpdate;
  /** Why the camera cannot open yet (the customer's name, printed on the photo, is not written). */
  photoBlockedReason?: string | null;
  ramadanNote: string | null;
  seatId: string;
  test: boolean;
  value: PlaceDraftState;
  weakGpsMeters: number;
}) {
  const timingsStep = firstStep + (capture ? 1 : 0);
  const detailsStep = timingsStep + 1;

  function takePhoto(photo: CapturedPhoto | null) {
    onChange((current) => ({
      ...current,
      photo,
      address: carried(current.address, current.photo?.address, photo?.address, PLACE_TEXT_MAX),
      zone: carried(current.zone, current.photo?.zone, photo?.zone, ZONE_TEXT_MAX),
    }));
  }

  return (
    <>
      {capture ? (
        <CrmBlock className="border-t border-slate-100" title={`${firstStep} · Live photo`}>
          {photoBlockedReason && !value.photo ? (
            <p className="text-sm font-semibold text-slate-500">{photoBlockedReason}</p>
          ) : (
            <LivePhotoCapture
              disabled={disabled}
              hint="Stand at the clinic sign or door. The photo is saved with your location and the time."
              onChange={takePhoto}
              purpose="place"
              seatId={seatId}
              test={test}
              title={`Phoenix CRM customer: ${customerName}`}
              value={value.photo}
              weakGpsMeters={weakGpsMeters}
            />
          )}
        </CrmBlock>
      ) : null}

      <CrmBlock className="border-t border-slate-100" title={`${timingsStep} · Days and hours`}>
        <TimingsEditor
          disabled={disabled}
          idPrefix={`${idPrefix}-timings`}
          onChange={(timings) => onChange((current) => ({ ...current, timings }))}
          ramadanNote={ramadanNote}
          value={value.timings}
        />
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title={`${detailsStep} · Place details`}>
        <div className="grid min-w-0 gap-3 sm:grid-cols-2">
          <CrmField className="sm:col-span-2" hint="Optional. For example: Evening clinic, or Al Salam Hospital." htmlFor={`${idPrefix}-label`} label="Place name">
            <input
              className={crmInputClassName}
              disabled={disabled}
              id={`${idPrefix}-label`}
              maxLength={PLACE_TEXT_MAX}
              onChange={(event) => {
                const label = event.target.value;
                onChange((current) => ({ ...current, label }));
              }}
              value={value.label}
            />
          </CrmField>
          <CrmField
            className="sm:col-span-2"
            hint={capture ? "Filled from your location when it is found. Correct it if it is wrong." : null}
            htmlFor={`${idPrefix}-address`}
            label="Address"
          >
            <input
              className={crmInputClassName}
              disabled={disabled}
              id={`${idPrefix}-address`}
              maxLength={PLACE_TEXT_MAX}
              onChange={(event) => {
                const address = event.target.value;
                onChange((current) => ({ ...current, address }));
              }}
              value={value.address}
            />
          </CrmField>
          <CrmField hint="The part of town. For example: Faisal." htmlFor={`${idPrefix}-zone`} label="Zone">
            <input
              className={crmInputClassName}
              disabled={disabled}
              id={`${idPrefix}-zone`}
              maxLength={ZONE_TEXT_MAX}
              onChange={(event) => {
                const zone = event.target.value;
                onChange((current) => ({ ...current, zone }));
              }}
              value={value.zone}
            />
          </CrmField>
        </div>
      </CrmBlock>
    </>
  );
}
