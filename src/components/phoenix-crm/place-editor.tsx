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

/**
 * What the rep fills in. The location is NOT here.
 *
 * Owner, 2026-09-23: "the capture location is never editable and its separated when captured to brick
 * area region clean addresss and raw location". The address and the part of town used to be text
 * boxes on this screen, seeded from the location and then open to be typed over — so the record of
 * where a customer is could differ from where the photo was taken. They are gone: the server resolves
 * the clean address, the part of town, the brick, the area and the region from the captured
 * coordinates and freezes them. What stays typed is the place's NAME and its days and hours.
 */
export type PlaceDraftState = {
  photo: CapturedPhoto | null;
  label: string;
  timings: PhoenixCrmTiming[];
};

/** A place's location as it stands: on the capture screen the photo's, on an edit the saved row's. */
export type CapturedLocation = {
  address: string | null;
  zone: string | null;
  brickName: string | null;
  areaName: string | null;
  regionName: string | null;
  lat: number;
  lon: number;
};

/** Updates arrive as functions of the latest draft: a photo finishes uploading while the rep types. */
export type PlaceDraftUpdate = (update: (current: PlaceDraftState) => PlaceDraftState) => void;

export function emptyPlaceDraft(): PlaceDraftState {
  return { photo: null, label: "", timings: [] };
}

/** The server's own checks, so a gap is named before the save leaves the phone. */
export function placeDraftProblem(draft: PlaceDraftState, options: { needsPhoto: boolean }): string | null {
  if (options.needsPhoto && !draft.photo) return "Take a live photo of the clinic sign or door.";
  const checked = parseTimings(timingsToDrafts(draft.timings));
  return checked.ok ? null : checked.error;
}

/**
 * The place as /api/phoenix-crm/list/validate and /list/places read it: the photo, the raw fix, the
 * name and the timings. No address, no part of town, no brick — the server resolves the whole
 * location from these coordinates and writes it once (owner, 2026-09-23).
 */
export function placePayload(photo: CapturedPhoto, draft: PlaceDraftState) {
  return {
    photoPath: photo.path,
    lat: photo.lat,
    lon: photo.lon,
    accuracyMeters: photo.accuracyMeters,
    deviceCapturedAt: photo.deviceCapturedAt,
    label: draft.label.trim() || null,
    timings: timingsToDrafts(draft.timings),
  };
}

/** "Ramadan runs Mon 8 Feb 2027 to Mon 8 Mar 2027 …" for the timings editor. */
export function ramadanHoursNote(ramadan: { startsOn: string; endsOn: string } | null, cairoToday: string): string | null {
  if (!ramadan) return null;
  const inForce = cairoToday >= ramadan.startsOn && cairoToday <= ramadan.endsOn;
  return `${inForce ? "Ramadan runs" : "The next Ramadan runs"} ${dayLabelWithYear(ramadan.startsOn)} to ${dayLabelWithYear(ramadan.endsOn)}. Ramadan hours are used on those days.`;
}

/** One captured fact, printed as a fact — never an input, because none of this can be typed over. */
function LocationFact({ children, label }: { children: string; label: string }) {
  return (
    <div className="min-w-0">
      <p className="text-phx-2xs font-black uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className="break-words text-sm font-semibold text-slate-800">{children}</p>
    </div>
  );
}

/**
 * The location as it was captured: read-only, always (owner, 2026-09-23).
 *
 * On the capture screen this is what the phone resolved for the photo it just took; the brick, the
 * area and the region are settled on the server as it saves, which is why they are named as coming
 * with the save rather than shown blank. On an edit it is the row's own frozen location.
 */
function CapturedLocationBlock({ capture, location }: { capture: boolean; location: CapturedLocation | null }) {
  if (!location) {
    return (
      <p className="text-sm font-medium text-slate-500">
        {capture ? "Take the photo and the location is filed with it." : "This place has no location on record."}
      </p>
    );
  }
  const territory = [location.brickName, location.areaName, location.regionName].filter(Boolean).join(" · ");
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <LocationFact label="Address">{location.address ?? "The map did not answer for this point. The coordinates below are the record."}</LocationFact>
      </div>
      {location.zone ? <LocationFact label="Part of town">{location.zone}</LocationFact> : null}
      <LocationFact label="Brick · area · region">{territory || (capture ? "Filed from this location when you save" : "No brick near enough to name")}</LocationFact>
      <div className="sm:col-span-2">
        <LocationFact label="Coordinates">{`${location.lat.toFixed(6)}, ${location.lon.toFixed(6)}`}</LocationFact>
      </div>
      <p className="text-sm font-medium text-slate-500 sm:col-span-2">
        Taken from where you stood. It is the customer&rsquo;s record and cannot be changed.
      </p>
    </div>
  );
}

export function PlaceEditor({
  capture,
  customerName,
  disabled = false,
  firstStep,
  idPrefix,
  location = null,
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
  /** The saved place's frozen location, when one is already on record. */
  location?: CapturedLocation | null;
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
    onChange((current) => ({ ...current, photo }));
  }

  // The capture screen shows the photo's own location; an edit shows the saved row's.
  const shown: CapturedLocation | null = capture
    ? value.photo
      ? { address: value.photo.address, zone: value.photo.zone, brickName: null, areaName: null, regionName: null, lat: value.photo.lat, lon: value.photo.lon }
      : null
    : location;

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

      <CrmBlock className="border-t border-slate-100" title={`${detailsStep} · Place name`}>
        <CrmField hint="Optional. For example: Evening clinic, or Al Salam Hospital." htmlFor={`${idPrefix}-label`} label="Place name">
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
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title={`${detailsStep + 1} · Location`}>
        <CapturedLocationBlock capture={capture} location={shown} />
      </CrmBlock>
    </>
  );
}
