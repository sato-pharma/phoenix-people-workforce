"use client";

/**
 * Phoenix CRM — a polyclinic or centre, and seating a customer inside it.
 *
 * Owner, 2026-10-09 in chat (Arabic): validate the polyclinic ONCE, then register each customer's
 * times in it, "from X to Y and from X to Y", at most three a day; he uploads a photo of the
 * timetable showing the names of the people he is adding, at each one; the polyclinic's location is
 * taken once, so seating needs no location; and the administrator reviews the timetable afterwards.
 *
 * 🔴 SO THIS SCREEN HAS NO LOCATION BLOCK AT ALL, and that absence is the feature rather than an
 * omission. The venue's point was captured at its own door — a live photo of the sign on the building
 * and both GPS readings inside the place line — and every customer seated behind that door inherits
 * it. A second capture per customer is exactly what the owner removed: the sign names the BUILDING,
 * so it could never name the fifth doctor who receives inside it, and each of them stayed unvalidated
 * with his visits scoring nothing.
 *
 * What replaces the signboard for a seated customer is the clinic's own TIMETABLE — the schedule
 * hanging on the wall, which is the one thing at that door that does name him — plus his days and
 * hours. Both are read on the server (`readPlaceSchedule`), and the administrator's Polyclinics
 * section is the human gate behind them.
 *
 * 🔴 THE TIMETABLE IS ASKED FOR ONCE PER BUILDING, NOT ONCE PER DOCTOR (owner, 2026-10-10: "ask him
 * for only one timetable, not for every doctor"). So this editor's photo step has two faces: the
 * camera, for the first customer seated in a building, stamped with the VENUE's name because the board
 * belongs to the building; and a note naming the date it was photographed, with one secondary button
 * for the only case that reopens the camera — the board on the wall was replaced. The server decides
 * the same thing again from the venue's stored path, so nothing here is trusted.
 *
 * 🔴 IT LIVES IN ITS OWN FILE SO `list-screens.tsx` DOES NOT GROW AGAIN: that file is already 1,780
 * lines and carries nine screens. What it exports is the three pure helpers the save path needs
 * (`emptySeatedDraft`, `seatedDraftProblem`, `seatedPayload`) and ONE component — so `ValidateScreen`
 * and `AddPlaceScreen` swap `PlaceEditor` for `SharedPlaceEditor` and keep every other line: the same
 * same-name question, the same phone field, the same photo-code recovery, the same save bar.
 *
 * The rep never reads the words "shared place": the screen says "Polyclinic or centre", and the four
 * kinds carry the owner's own words.
 */

import { Building2, CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";

import { crmPost, crmUrl, messageOf, useCrmGet } from "@/components/phoenix-crm/api";
import { releaseCapturedPhoto } from "@/components/phoenix-crm/captured-photo";
import { CaptureLocation, type CapturedPin } from "@/components/phoenix-crm/capture-location";
import { LivePhotoCapture, type CapturedPhoto } from "@/components/phoenix-crm/live-photo-capture";
import { TimingsEditor, timingsToDrafts } from "@/components/phoenix-crm/timings-editor";
import {
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmField,
  CrmLoading,
  CrmNote,
  crmInputClassName,
} from "@/components/phoenix-crm/ui";
import { useBrowserNamed } from "@/components/phoenix-crm/use-browser-name";
import { PLACE_PRECISION_NOTE, PLACE_TEXT_MAX, SIGNBOARD_FRAME_NOTE } from "@/lib/phoenix-crm/entry-rules";
import { SCHEDULE_UPLOAD_NOTE, scheduleUploadAllowed } from "@/lib/phoenix-crm/schedule-rules";
import {
  SEATED_PLACE_NO_PHOTO,
  SEATED_PLACE_NO_SESSION,
  SEATED_PLACE_NO_VENUE,
  SEATED_PLACE_PHOTO_HINT,
  SEATED_PLACE_PHOTO_ON_FILE,
  SEATED_PLACE_PHOTO_REPLACE,
  SHARED_PLACE_KINDS,
  SHARED_PLACE_NAME_LABEL,
  SHARED_PLACE_NAME_MAX,
  SHARED_PLACE_NO_KIND,
  SHARED_PLACE_NO_NAME,
  SHARED_PLACE_NO_PHOTO,
  SHARED_PLACE_TITLE,
  type SharedPlaceKind,
} from "@/lib/phoenix-crm/shared-place-rules";
import { parseTimings } from "@/lib/phoenix-crm/timings";
import type { PhoenixCrmTiming } from "@/lib/phoenix-crm/types";

/** One venue as the picker reads it — the server's `SharedPlaceRow`, named for the client. */
export type SharedPlaceChoice = {
  sharedPlaceId: string;
  name: string;
  kind: SharedPlaceKind;
  kindLabel: string;
  status: "active" | "held" | "retired";
  address: string | null;
  brickName: string | null;
  areaName: string | null;
  seated: number;
  capturedAtText: string;
  /** Set once the building's timetable has been photographed — then the rep is not asked again. */
  schedulePhotoPath: string | null;
  schedulePhotoCapturedAtText: string | null;
  /** This rep's refused photographs of this board today: two open the upload on the last try. */
  timetableRefusedToday?: number;
};

/** What the rep fills in to seat a customer. No photo of a sign, no pin, no location. */
export type SeatedDraftState = {
  sharedPlaceId: string | null;
  /**
   * The BUILDING's timetable, photographed live — null when the board is already on file and this
   * customer is being seated against it, which is the ordinary case from the second doctor onwards.
   */
  photo: CapturedPhoto | null;
  /** Whether the chosen building already has its timetable on file. Set from the picker's own rows. */
  timetableOnFile: boolean;
  /** He pressed "the timetable changed", so a fresh photograph is required even though one is on file. */
  replacingTimetable: boolean;
  timings: PhoenixCrmTiming[];
  label: string;
  /** AM or PM: the session he receives in at this building (owner, 2026-10-10). Null until chosen. */
  session: "AM" | "PM" | null;
  /** Timetable photos refused on this screen. Each one re-reads the server's count of today's refusals. */
  timetableRetakes: number;
};

/** The customer's own list as the first answer to "AM or PM here?" — a pharmacy or an unknown list gives none. */
export function seatedSessionOf(listType: string | null | undefined): "AM" | "PM" | null {
  return listType === "AM" || listType === "PM" ? listType : null;
}

export function emptySeatedDraft(timings: ReadonlyArray<PhoenixCrmTiming> = [], session: "AM" | "PM" | null = null): SeatedDraftState {
  return { sharedPlaceId: null, photo: null, timetableOnFile: false, replacingTimetable: false, timings: [...timings], label: "", session, timetableRetakes: 0 };
}

/**
 * The server's own checks, so a gap is named before the save leaves the phone.
 *
 * His "at least one day and one starting time" is `parseTimings`' own rule — one normal window with a
 * start minute — so it is asked here rather than restated, exactly as `placeDraftProblem` asks it.
 */
export function seatedDraftProblem(draft: SeatedDraftState): string | null {
  if (!draft.sharedPlaceId) return SEATED_PLACE_NO_VENUE;
  if (!draft.session) return SEATED_PLACE_NO_SESSION;
  // 🔴 ASKED ONCE PER BUILDING (owner, 2026-10-10). A photo is required of the FIRST customer seated
  // in a venue, and of a rep who said the board changed — never of the second doctor behind a door
  // whose timetable is already on file. The server re-decides it from the venue's own stored path, so
  // a stale `timetableOnFile` here can only ask for one photo too many, never let one too few through.
  if (!draft.photo && (draft.replacingTimetable || !draft.timetableOnFile)) return SEATED_PLACE_NO_PHOTO;
  const checked = parseTimings(timingsToDrafts(draft.timings));
  return checked.ok ? null : checked.error;
}

/**
 * The seating as /api/phoenix-crm/list/validate and /list/places read it: which venue, the timetable
 * photo, the hours, and an optional name for the room.
 *
 * 🔴 NOT ONE COORDINATE IN IT. `parseSeatedPlaceDraft` names no fix at all and the server copies the
 * venue's whole resolution — point, brick, area, region, address — onto the row. A reading sent from
 * here would be a second answer to a question already answered at the venue's door.
 */
export function seatedPayload(photo: CapturedPhoto | null, draft: SeatedDraftState) {
  return {
    sharedPlaceId: draft.sharedPlaceId,
    // 🔴 NULL MEANS "the board this building already has", and the server resolves it from the VENUE's
    // own `schedule_photo_path` — never from anything sent here. So a phone cannot name another rep's
    // photograph, and a photo sent here is always a REPLACEMENT of the board on the wall.
    photoPath: photo?.path ?? null,
    photoUploaded: photo?.uploaded === true,
    label: draft.label.trim() || null,
    timings: timingsToDrafts(draft.timings),
    session: draft.session,
  };
}

/** The venue's own capture state: the name on the building, which of the four, the photo, the pin. */
type VenueDraft = {
  name: string;
  kind: SharedPlaceKind | null;
  photo: CapturedPhoto | null;
  pin: CapturedPin | null;
};

function emptyVenueDraft(): VenueDraft {
  return { name: "", kind: null, photo: null, pin: null };
}

function venueProblem(draft: VenueDraft): string | null {
  const name = draft.name.replace(/\s+/g, " ").trim();
  if (name.length < 3) return SHARED_PLACE_NO_NAME;
  if (!draft.kind) return SHARED_PLACE_NO_KIND;
  if (!draft.photo) return SHARED_PLACE_NO_PHOTO;
  if (!draft.pin) return "Press Capture location while you stand at the building.";
  return null;
}

/** "Nile Polyclinic · Maadi · Cairo South" — where a venue is, for the picker and the chosen block. */
export function venueWhere(venue: SharedPlaceChoice): string {
  return [venue.address, venue.brickName, venue.areaName].filter(Boolean).join(" · ") || "No address on record";
}

/**
 * What a venue's row says about its customers.
 *
 * 🔴 THE REP'S ROW NEVER SAYS THE BUILDING IS BEING CHECKED (owner, 2026-10-14: "remove the grey" — and
 * golden rule #1, the rep's app never lets him feel he is being checked). A held venue reads exactly like
 * any other to him. The Super Admin's own move screen passes "admin" and is told which buildings still
 * wait for his approval, because that is the one screen where a held venue is refused.
 */
export function seatedNote(venue: SharedPlaceChoice, audience: "rep" | "admin" = "rep"): string {
  const customers = venue.seated === 0 ? "No customer in it yet" : venue.seated === 1 ? "1 customer in it" : `${venue.seated} customers in it`;
  return audience === "admin" && venue.status === "held" ? `Not approved yet · ${customers}` : customers;
}

/**
 * Captures one venue at its door, inside the seating screen rather than on a route of its own.
 *
 * 🔴 IT REPLACES THE REST OF THE FORM WHILE IT IS OPEN, instead of standing beside it: two live
 * cameras mounted at once would hold two `MediaStream`s on a phone, and the rep would be asked to
 * photograph a sign and a timetable in one scroll. The timetable photo and the hours live on the
 * PARENT's draft, so closing this form gives them back untouched.
 */
function CaptureVenue({
  busy,
  onCancel,
  onSaved,
  seatId,
  test,
}: {
  busy: boolean;
  onCancel: () => void;
  onSaved: (sharedPlaceId: string, held: boolean) => void;
  seatId: string;
  test: boolean;
}) {
  const [draft, setDraft] = useState<VenueDraft>(emptyVenueDraft);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // The rule names HIS browser, never "Phoenix" — the setting it sends him to belongs to the browser.
  const browserNamed = useBrowserNamed();
  const disabled = busy || saving;
  const cleanName = draft.name.replace(/\s+/g, " ").trim();

  async function save() {
    if (saving) return;
    const gap = venueProblem(draft);
    const photo = draft.photo;
    const pin = draft.pin;
    if (gap || !photo || !pin) {
      setProblem(gap ?? SHARED_PLACE_NO_PHOTO);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      const saved = await crmPost<{ sharedPlaceId: string; held: boolean }>(
        "/api/phoenix-crm/shared-places",
        {
          seatId,
          test,
          sharedPlace: {
            name: cleanName,
            kind: draft.kind,
            photoPath: photo.path,
            // The two readings travel under the names `parseCapturedFix` reads, exactly as a place's
            // do: the pin is the button's own reading, the `shutter*`/`photo*` four are the camera's.
            // Neither is ever a copy of the other.
            lat: pin.lat,
            lon: pin.lon,
            accuracyMeters: pin.accuracyMeters,
            pinCapturedAt: pin.capturedAt,
            deviceCapturedAt: photo.deviceCapturedAt,
            shutterLat: photo.shutterLat,
            shutterLon: photo.shutterLon,
            shutterAccuracyMeters: photo.shutterAccuracyMeters,
            shutterCapturedAt: photo.shutterCapturedAt,
            photoLat: photo.shutterLat,
            photoLon: photo.shutterLon,
            photoAccuracyMeters: photo.shutterAccuracyMeters,
            photoCapturedAt: photo.shutterCapturedAt,
          },
        },
        "sharedPlace",
      );
      onSaved(saved.sharedPlaceId, saved.held === true);
    } catch (error) {
      setSaving(false);
      setProblem(messageOf(error));
    }
  }

  return (
    <>
      <CrmBlock className="border-t border-slate-100" title={`Add a ${SHARED_PLACE_TITLE.toLowerCase()}`}>
        <p className="text-sm font-medium leading-6 text-slate-600">
          Stand at the building and photograph the sign on it, then capture the location. You do this once for the whole building — every customer
          you add inside it uses this same location.
        </p>
        <div className="mt-3 grid min-w-0 gap-3">
          <CrmField hint="As written on the sign on the building, not a person's name." htmlFor="phoenix-crm-venue-name" label={SHARED_PLACE_NAME_LABEL}>
            <input
              autoComplete="off"
              className={crmInputClassName}
              disabled={disabled}
              id="phoenix-crm-venue-name"
              maxLength={SHARED_PLACE_NAME_MAX}
              onChange={(event) => {
                const name = event.target.value;
                setDraft((current) => ({ ...current, name }));
                setProblem(null);
              }}
              value={draft.name}
            />
          </CrmField>
          <CrmField label="What is it">
            <CrmChoice
              columns={2}
              label="What is it"
              onChange={(kind: SharedPlaceKind) => {
                setDraft((current) => ({ ...current, kind }));
                setProblem(null);
              }}
              options={SHARED_PLACE_KINDS.map((kind) => ({ value: kind.key, label: kind.label, disabled }))}
              value={draft.kind}
            />
          </CrmField>
        </div>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="The sign on the building">
        <CrmNote className="mb-3" tone="info">
          {browserNamed(PLACE_PRECISION_NOTE)}
        </CrmNote>
        {cleanName.length < 3 && !draft.photo ? (
          <p className="text-sm font-semibold text-slate-500">Write the name on the building first. It is printed on the photo.</p>
        ) : (
          <LivePhotoCapture
            disabled={disabled}
            frameGuide={{ note: SIGNBOARD_FRAME_NOTE }}
            hint="Stand at the building and take a live photo of the sign on it. Put the sign inside the box on the screen, with the building's name readable."
            onChange={(photo) => {
              setDraft((current) => ({ ...current, photo }));
              setProblem(null);
            }}
            purpose="place"
            seatId={seatId}
            test={test}
            title={`Phoenix CRM ${SHARED_PLACE_TITLE.toLowerCase()}: ${cleanName}`}
            value={draft.photo}
          />
        )}
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="Capture location">
        <CaptureLocation
          disabled={disabled}
          onChange={(pin) => {
            setDraft((current) => ({ ...current, pin }));
            setProblem(null);
          }}
          value={draft.pin}
        />
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100">
        {problem ? (
          <CrmNote className="mb-3" tone="bad">
            {browserNamed(problem)}
          </CrmNote>
        ) : null}
        <div className="grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} onClick={() => void save()} variant="primary">
            Save this building
          </CrmButton>
          <CrmButton
            disabled={disabled}
            onClick={() => {
              releaseCapturedPhoto(draft.photo);
              onCancel();
            }}
          >
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </>
  );
}

/**
 * Seating one customer: which venue, the timetable photo, the days and hours, the room's name.
 *
 * It mirrors `PlaceEditor`'s contract — numbered steps from `firstStep`, a `disabled` flag, updates
 * as functions of the latest draft — so the two are swapped for each other on one line in
 * `ValidateScreen` and `AddPlaceScreen`.
 */
/**
 * One piece of the editor, for the validation form that shows a step at a time. Left out, the editor
 * draws every block, numbered from `firstStep`, exactly as the other screens have always had it.
 */
export type SharedPlaceEditorPart = "venue" | "photo" | "timings" | "details";

export function SharedPlaceEditor({
  disabled = false,
  firstStep,
  idPrefix,
  onAddingChange,
  onChange,
  part,
  ramadanNote,
  seatId,
  test,
  value,
}: {
  disabled?: boolean;
  /** The number of this editor's first step on the screen ("2 · Polyclinic or centre"). */
  firstStep: number;
  idPrefix: string;
  /** Told when the "add the building" capture opens or closes, so a step form can hold its Next until it is done. */
  onAddingChange?: (adding: boolean) => void;
  onChange: (update: (current: SeatedDraftState) => SeatedDraftState) => void;
  /** Draw only this piece (the validation form's steps). */
  part?: SharedPlaceEditorPart;
  ramadanNote: string | null;
  seatId: string;
  test: boolean;
  value: SeatedDraftState;
}) {
  const [adding, setAdding] = useState(false);
  useEffect(() => {
    onAddingChange?.(adding);
    // Only a change of `adding` is news; the callback is the parent's setter and may be a new function each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adding]);
  const shows = (piece: SharedPlaceEditorPart) => part === undefined || part === piece;
  const [justAdded, setJustAdded] = useState<string | null>(null);
  // 🔴 THE VALUE, NEVER THE ENVELOPE. `crmGet(url, key)` returns `body[key]`, so the answer here IS
  // the array: typing it `{ sharedPlaces: … }` and reading `data?.sharedPlaces` asks an array for a
  // property it has never had, and the picker is empty for ever (production, 2026-10-12).
  const venues = useCrmGet<SharedPlaceChoice[]>(crmUrl("/api/phoenix-crm/shared-places", { seatId, test }), "sharedPlaces");
  const list = venues.data ?? [];
  const chosen = list.find((venue) => venue.sharedPlaceId === value.sharedPlaceId) ?? null;
  // A refused photo moves the server's count, and the count is what opens the upload on the last try.
  const reloadVenues = venues.reload;
  useEffect(() => {
    if (value.timetableRetakes > 0) reloadVenues();
  }, [reloadVenues, value.timetableRetakes]);
  // The picker's own answer, which is the live one: `value.timetableOnFile` was written when the
  // choice was made and a reload can have brought a board in since.
  const timetableOnFile = Boolean(chosen?.schedulePhotoPath) || value.timetableOnFile;
  const photoStep = firstStep + 1;
  const timingsStep = firstStep + 2;
  const detailsStep = firstStep + 3;

  if (adding && shows("venue")) {
    return (
      <CaptureVenue
        busy={disabled}
        onCancel={() => setAdding(false)}
        onSaved={(sharedPlaceId, held) => {
          setAdding(false);
          setJustAdded(held ? sharedPlaceId : null);
          // A venue still being checked is chosen like any other (owner, 2026-10-14: "make him able to
          // choose him even if the system is still checking"): leaving it unchosen is what sent the rep
          // to "Choose the polyclinic or centre this customer receives in." on Save.
          // A building nobody has been seated in yet has no timetable on file, so the camera opens.
          onChange((current) => ({ ...current, sharedPlaceId, timetableOnFile: false, replacingTimetable: false }));
          venues.reload();
        }}
        seatId={seatId}
        test={test}
      />
    );
  }

  return (
    <>
      {shows("venue") ? (
        <CrmBlock className="border-t border-slate-100" title={`${firstStep} · ${SHARED_PLACE_TITLE}`}>
          {venues.loading && list.length === 0 ? (
            <CrmLoading label="Loading the polyclinics and centres" />
          ) : (
            <>
              {venues.error ? (
                <CrmNote className="mb-3" tone="bad">
                  {venues.error}
                </CrmNote>
              ) : null}
              {justAdded ? (
                <CrmNote className="mb-3" title="Saved" tone="info">
                  The building is saved. You can add customers in it now.
                </CrmNote>
              ) : null}
              {list.length === 0 ? (
                <p className="text-sm font-medium leading-6 text-slate-600">
                  No polyclinic or centre is on this territory yet. Add the one you are standing at, then add the customer in it.
                </p>
              ) : (
                <CrmChoice
                  columns={2}
                  label={SHARED_PLACE_TITLE}
                  onChange={(sharedPlaceId: string) =>
                    onChange((current) => ({
                      ...current,
                      sharedPlaceId,
                      // Whether this building's board is already on file travels with the choice, so
                      // `seatedDraftProblem` can ask for a photo without reading the picker's rows.
                      timetableOnFile: Boolean(list.find((venue) => venue.sharedPlaceId === sharedPlaceId)?.schedulePhotoPath),
                      replacingTimetable: false,
                    }))
                  }
                  options={list.map((venue) => ({
                    value: venue.sharedPlaceId,
                    label: venue.name,
                    note: `${venue.kindLabel} · ${venueWhere(venue)} · ${seatedNote(venue)}`,
                    disabled,
                  }))}
                  value={value.sharedPlaceId}
                />
              )}
              <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
                <CrmButton disabled={disabled} onClick={() => setAdding(true)} size="sm" variant="secondary">
                  <Building2 aria-hidden className="h-4 w-4" />
                  It is not here — add the building
                </CrmButton>
              </div>
              {chosen ? (
                <div className="mt-3">
                  <CrmChoice
                    columns={2}
                    label="Does this customer receive here in the AM or the PM?"
                    onChange={(session: "AM" | "PM") => onChange((current) => ({ ...current, session }))}
                    options={[
                      { value: "AM", label: "AM", note: "Morning", disabled },
                      { value: "PM", label: "PM", note: "Afternoon and evening", disabled },
                    ]}
                    value={value.session}
                  />
                  <p className="mt-1.5 break-words text-xs font-semibold text-slate-500">
                    On the plan, choosing AM shows this building&rsquo;s AM customers and choosing PM shows its PM customers. A building takes three visits a
                    day, AM and PM together.
                  </p>
                </div>
              ) : null}
              {chosen ? (
                <div className="mt-3 border border-slate-200 bg-slate-50/70 px-3 py-2.5">
                  <p className="flex min-w-0 items-start gap-2 text-sm font-black text-slate-950">
                    <Building2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />
                    <span className="min-w-0 break-words">{chosen.name}</span>
                  </p>
                  <p className="mt-0.5 break-words text-xs font-semibold text-slate-600">
                    {chosen.kindLabel} · {venueWhere(chosen)}
                  </p>
                  {/* The owner's own design, said plainly: the location is the building's, captured once
                      at its door, so this customer is not asked for one (2026-10-09). */}
                  <p className="mt-1 break-words text-xs font-semibold text-slate-500">
                    This building&rsquo;s location was captured at its door on {chosen.capturedAtText}. The customer takes it, so you do not capture a
                    location here.
                  </p>
                </div>
              ) : null}
            </>
          )}
        </CrmBlock>
      ) : null}

      {shows("photo") ? (
        <CrmBlock className="border-t border-slate-100" title={`${photoStep} · Timetable photo`}>
          {!chosen && venues.loading && list.length === 0 ? (
            <CrmLoading label="Loading the polyclinics and centres" />
          ) : !chosen ? (
            // The stamp burned into the photo is the BUILDING's name, so the venue has to be chosen
            // before the camera can open. It replaces the old "write the customer's name first" gate.
            <p className="text-sm font-semibold text-slate-500">Choose the polyclinic or centre first. Its name is printed on the photo.</p>
          ) : timetableOnFile && !value.replacingTimetable && !value.photo ? (
            // 🔴 ONE TIMETABLE PER BUILDING (owner, 2026-10-10). The board is already photographed, so
            // this customer is seated against it and the rep is not asked again.
            <>
              <CrmNote title={SEATED_PLACE_PHOTO_ON_FILE} tone="info">
                It was photographed on {chosen.schedulePhotoCapturedAtText ?? chosen.capturedAtText}, and it covers everybody who receives here. This
                customer is saved against it — enter the hours below.
              </CrmNote>
              <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
                <CrmButton
                  disabled={disabled}
                  onClick={() => onChange((current) => ({ ...current, replacingTimetable: true }))}
                  size="sm"
                  variant="secondary"
                >
                  <CalendarClock aria-hidden className="h-4 w-4" />
                  {SEATED_PLACE_PHOTO_REPLACE}
                </CrmButton>
              </div>
            </>
          ) : (
            <>
              {value.replacingTimetable || timetableOnFile ? (
                <CrmNote className="mb-3" title="This replaces the timetable on file" tone="info">
                  The photo you take now becomes this building&rsquo;s timetable, for this customer and for everybody seated here afterwards.
                </CrmNote>
              ) : null}
              <LivePhotoCapture
                disabled={disabled}
                hint={SEATED_PLACE_PHOTO_HINT}
                onChange={(photo) => onChange((current) => ({ ...current, photo }))}
                purpose="place"
                seatId={seatId}
                test={test}
                title={`Phoenix CRM ${SHARED_PLACE_TITLE.toLowerCase()}: ${chosen.name}`}
                uploadOffer={scheduleUploadAllowed(chosen.timetableRefusedToday ?? 0) ? { note: SCHEDULE_UPLOAD_NOTE } : undefined}
                value={value.photo}
              />
            </>
          )}
        </CrmBlock>
      ) : null}

      {shows("timings") ? (
        <CrmBlock className="border-t border-slate-100" title={`${timingsStep} · Days and hours`}>
          <p className="mb-3 flex min-w-0 items-start gap-2 text-sm font-medium leading-6 text-slate-600">
            <CalendarClock aria-hidden className="mt-1 h-4 w-4 shrink-0 text-slate-500" />
            <span className="min-w-0 break-words">Enter the hours this customer receives in this building, as the timetable shows them.</span>
          </p>
          <TimingsEditor
            disabled={disabled}
            idPrefix={`${idPrefix}-timings`}
            onChange={(timings) => onChange((current) => ({ ...current, timings }))}
            ramadanNote={ramadanNote}
            value={value.timings}
          />
        </CrmBlock>
      ) : null}

      {shows("details") ? (
        <CrmBlock className="border-t border-slate-100" title={`${detailsStep} · Room or clinic name`}>
          <CrmField hint="Optional. For example: Clinic 4, or Second floor." htmlFor={`${idPrefix}-label`} label="Room or clinic name">
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
      ) : null}
    </>
  );
}
