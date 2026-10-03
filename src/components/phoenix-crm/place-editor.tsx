"use client";

/**
 * Phoenix CRM — one place of a customer, as the rep enters it at the clinic: the live photo of the sign
 * or door (with its own location), the Capture location button (the same place read again by GPS), the
 * days and hours the place receives visits, and its details.
 *
 * Owner, 2026-09-16: a customer is real only with a live photo, the location captured on the spot and
 * at least one timing; timings belong to the place, so a doctor who receives in two places has two.
 * Owner, 2026-09-30: the location is captured TWICE — once by the photo, once by the button.
 */

import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
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
  /** The Capture-location reading, taken by its own button apart from the photo (owner, 2026-09-30). */
  pin: CapturedPin | null;
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
  return { photo: null, pin: null, label: "", timings: [] };
}

/** The server's own checks, so a gap is named before the save leaves the phone. */
export function placeDraftProblem(draft: PlaceDraftState, options: { needsPhoto: boolean }): string | null {
  if (options.needsPhoto && !draft.photo) return "Take a live photo of the clinic sign or door.";
  if (options.needsPhoto && !draft.pin) return "Press Capture location while you stand at the clinic.";
  const checked = parseTimings(timingsToDrafts(draft.timings));
  return checked.ok ? null : checked.error;
}

/**
 * The place as /api/phoenix-crm/list/validate and /list/places read it: the photo, the raw fix, the
 * name and the timings. No address, no part of town, no brick — the server resolves the whole
 * location from these coordinates and writes it once (owner, 2026-09-23).
 *
 * TWO READINGS (owner, 2026-09-29, 2026-09-30): `lat`/`lon` are the Capture-location pin — the
 * button's own GPS reading, never the camera's — and the `shutter*` four are the photo's own reading.
 * They travel under the names the server's `parseCapturedFix` reads (it stores them as
 * photoLat/photoLon/photoAccuracyMeters/photoCapturedAt) and again under those place names — the same
 * body the out-of-list entry sends — and the server fixes the place on the photo's reading, falling
 * back to the pin when the photo has none, or when only the pin is inside the 200 m line (`placePoint`,
 * 2026-10-03); with both wider it refuses the save. Each is sent as it was measured: neither is ever a
 * copy of the other. With no pin, `lat`/`lon` go as null and the server refuses the save.
 */
export function placePayload(photo: CapturedPhoto, draft: PlaceDraftState) {
  return {
    photoPath: photo.path,
    lat: draft.pin ? draft.pin.lat : null,
    lon: draft.pin ? draft.pin.lon : null,
    accuracyMeters: draft.pin ? draft.pin.accuracyMeters : null,
    deviceCapturedAt: photo.deviceCapturedAt,
    shutterLat: photo.shutterLat,
    shutterLon: photo.shutterLon,
    shutterAccuracyMeters: photo.shutterAccuracyMeters,
    shutterCapturedAt: photo.shutterCapturedAt,
    photoLat: photo.shutterLat,
    photoLon: photo.shutterLon,
    photoAccuracyMeters: photo.shutterAccuracyMeters,
    photoCapturedAt: photo.shutterCapturedAt,
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
 *
 * The rep reads WHERE, never HOW WELL (owner, 2026-09-29): no coordinates and no accuracy on this
 * block. The raw readings are the Super Admin's and the SFE Manager's, on the place-move screen.
 */
function CapturedLocationBlock({ capture, location }: { capture: boolean; location: CapturedLocation | null }) {
  if (!location) {
    return (
      <p className="text-sm font-medium text-slate-500">
        {capture ? "Take the photo and capture the location; the address is filed with them." : "This place has no location on record."}
      </p>
    );
  }
  const territory = [location.brickName, location.areaName, location.regionName].filter(Boolean).join(" · ");
  return (
    <div className="grid min-w-0 gap-3 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <LocationFact label="Address">{location.address ?? (capture ? "Location captured. The address is filed when you save." : "Location captured. No street address was found for it.")}</LocationFact>
      </div>
      {location.zone ? <LocationFact label="Part of town">{location.zone}</LocationFact> : null}
      <LocationFact label="Brick · area · region">{territory || (capture ? "Filed from this location when you save" : "No brick near enough to name")}</LocationFact>
      <p className="text-sm font-medium text-slate-500 sm:col-span-2">
        Taken from where you stood. It is the customer&rsquo;s fixed location and cannot be changed.
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
}: {
  /** A new place takes a live photo; changing a saved place keeps its photo and location. */
  capture: boolean;
  customerName: string;
  disabled?: boolean;
  /** The saved place's frozen location, when one is already on record. */
  location?: CapturedLocation | null;
  /** The number of this editor's first step on the screen ("2 · Signboard photo"). */
  firstStep: number;
  idPrefix: string;
  onChange: PlaceDraftUpdate;
  /** Why the camera cannot open yet (the customer's name, printed on the photo, is not written). */
  photoBlockedReason?: string | null;
  ramadanNote: string | null;
  seatId: string;
  test: boolean;
  value: PlaceDraftState;
  /** Accepted and ignored since 2026-09-29 — the capture no longer judges a reading in front of the rep. */
  weakGpsMeters?: number;
}) {
  // A capture has two steps before the timings: the photo, then Capture location.
  const pinStep = firstStep + 1;
  const timingsStep = firstStep + (capture ? 2 : 0);
  const detailsStep = timingsStep + 1;

  function takePhoto(photo: CapturedPhoto | null) {
    onChange((current) => ({ ...current, photo }));
  }

  function capturePin(pin: CapturedPin | null) {
    onChange((current) => ({ ...current, pin }));
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
        <CrmBlock className="border-t border-slate-100" title={`${firstStep} · Signboard photo`}>
          {photoBlockedReason && !value.photo ? (
            <p className="text-sm font-semibold text-slate-500">{photoBlockedReason}</p>
          ) : (
            <LivePhotoCapture
              disabled={disabled}
              hint="Stand at the clinic's signboard and take a live photo. The photo keeps its own location and time."
              onChange={takePhoto}
              purpose="place"
              seatId={seatId}
              test={test}
              title={`Phoenix CRM customer: ${customerName}`}
              value={value.photo}
            />
          )}
        </CrmBlock>
      ) : null}

      {capture ? (
        <CrmBlock className="border-t border-slate-100" title={`${pinStep} · Capture location`}>
          <CaptureLocation disabled={disabled} onChange={capturePin} value={value.pin} />
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
