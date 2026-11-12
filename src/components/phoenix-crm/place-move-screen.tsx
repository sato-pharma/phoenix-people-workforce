"use client";

/**
 * Phoenix CRM — moving a validated clinic: the Super Admin's and the SFE Manager's screen, never the rep's.
 *
 * Owner, 2026-09-29: "the location is fixed forever, only the system administrator changes it" — widened
 * by him the same day to the SFE Manager. A rep is never offered this screen: the customer's page shows
 * "Move this place" only where the list says `canMovePlaces`, and this screen refuses to draw for anyone
 * else. The server refuses the move for anyone else too (place-move.ts, `assertPlaceMover`).
 *
 * This is the one screen in the module that shows the two raw readings a clinic was validated with — the
 * Capture-location pin and the photo's own reading — with their accuracy and the distance between them,
 * because deciding which one is right is the mover's job. The new point is CHOSEN, never typed as an
 * address: one of those two readings, or coordinates pasted from a map. The server resolves the address,
 * brick, area and region from it, and every move needs a written reason and is kept on record.
 */

import { useState } from "react";

import { crmPost, errorCodeOf, messageOf } from "@/components/phoenix-crm/api";
import { cairoStamp } from "@/components/phoenix-crm/format";
import { customerMetaText, placeName } from "@/components/phoenix-crm/labels";
import { ListGone, type ListNotice, type ListScreenBase } from "@/components/phoenix-crm/list-screens";
import { CrmPhotoThumb } from "@/components/phoenix-crm/photo";
import {
  CrmBackBar,
  CrmBlock,
  CrmButton,
  CrmChoice,
  CrmFacts,
  CrmField,
  CrmNote,
  CrmPanel,
  crmInputClassName,
  crmTextareaClassName,
} from "@/components/phoenix-crm/ui";
import { distanceMeters, formatDistance } from "@/lib/phoenix-crm/geo";
import { noPhotoTextFor } from "@/lib/phoenix-crm/trusted-point-rules";
import type { ListCustomer, ListPlace, PlaceMoveResult, PlaceMoveTarget, PlaceReading } from "@/lib/phoenix-crm/view-types";

/** The written reason a move needs — the bounds place-move.ts and phoenix_crm_move_place hold. */
const MOVE_REASON_MIN = 10;
const MOVE_REASON_MAX = 500;

/** A mover's point pasted from a map: "30.0444, 31.2357". The server checks it lies inside Egypt. */
function readCoordinates(text: string): { lat: number; lon: number } | null {
  const parts = text.split(/[,\s]+/).filter(Boolean);
  if (parts.length !== 2) return null;
  const lat = Number(parts[0]);
  const lon = Number(parts[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function accuracyText(meters: number | null): string {
  return meters === null ? "accuracy unknown" : `within ${formatDistance(Math.round(meters))}`;
}

/** "30.04441, 31.23571 · within 12 m". toFixed, never toLocaleString: the server renders the same string. */
// Undefined as well as null: the measurements are optional on `ListPlace` because its own rep never
// receives them (server/blind-payloads.ts). This screen is the movers' and always gets them.
function readingText(reading: PlaceReading | null | undefined): string {
  if (!reading) return "Not measured";
  return `${reading.lat.toFixed(5)}, ${reading.lon.toFixed(5)} · ${accuracyText(reading.accuracyMeters)}`;
}

/** Where the clinic's fixed point came from, in the mover's words. */
export function pointSourceText(place: Pick<ListPlace, "pointSource" | "moved">): string {
  if (place.pointSource === "moved") {
    return place.moved ? `Moved on ${cairoStamp(place.moved.at)} — ${place.moved.reason ?? "no reason on record"}` : "Moved";
  }
  if (place.pointSource === "photo") return "Fixed on the photo's own reading";
  if (place.pointSource === "trusted") return "Fixed by the Super Admin on the trusted point the reps' readings agree on (no photo)";
  if (place.pointSource === "line_twin") return "Validated on another line — it stands on that line's validated place and follows it (no photo of its own)";
  return "Fixed on the Capture-location pin (the photo had no reading)";
}

const GONE_NOT_MOVER = "Only the Super Admin and the SFE Manager move a clinic's location.";

export function PlaceMoveScreen(
  props: ListScreenBase & {
    customerId: string;
    onBack: () => void;
    onDone: (notice: ListNotice) => void;
    placeId: string;
  },
) {
  const { customerId, onBack, placeId, refreshing, view } = props;
  const customer = view.customers.find((entry) => entry.customerId === customerId) ?? null;
  const index = customer ? customer.places.findIndex((place) => place.placeId === placeId) : -1;
  const place = customer && index >= 0 ? customer.places[index] : null;
  // Reachable only where the list says this viewer moves places — the rep never is.
  const gone = !view.canMovePlaces
    ? GONE_NOT_MOVER
    : !customer
      ? "This customer is no longer on the territory's list."
      : !place
        ? "This clinic is no longer on the list."
        : null;
  if (!customer || !place || gone) {
    return <ListGone backLabel="Customer" message={gone ?? GONE_NOT_MOVER} onBack={onBack} refreshing={refreshing} title="Move this place" />;
  }
  // Keyed by the place, so a second move starts from a clean form.
  return <PlaceMoveForm {...props} customer={customer} index={index} key={place.placeId} place={place} />;
}

function PlaceMoveForm({
  customer,
  index,
  onBack,
  onDone,
  place,
  reload,
  seatId,
  test,
}: ListScreenBase & {
  customer: ListCustomer;
  index: number;
  onBack: () => void;
  onDone: (notice: ListNotice) => void;
  place: ListPlace;
}) {
  const [target, setTarget] = useState<PlaceMoveTarget | null>(null);
  const [coordinates, setCoordinates] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const name = placeName(place, index);
  const where = [place.address, place.zone, place.brickName ? `Brick ${place.brickName}` : null, place.areaName, place.regionName]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const apart =
    place.pinReading && place.photoReading
      ? formatDistance(distanceMeters({ lat: place.pinReading.lat, lon: place.pinReading.lon }, { lat: place.photoReading.lat, lon: place.photoReading.lon }))
      : "Only one reading was measured";
  const reasonLength = reason.trim().length;

  function clientProblem(): string | null {
    if (!target) return "Choose where the clinic goes: the photo reading, the pin reading, or coordinates from a map.";
    if (target === "photo" && !place.photoReading) return "This clinic has no photo reading to move to.";
    if (target === "pin" && !place.pinReading) return "This clinic has no pin reading to move to.";
    if (target === "coordinates" && !readCoordinates(coordinates)) return "Paste the clinic's coordinates from a map, like 30.0444, 31.2357.";
    if (reasonLength < MOVE_REASON_MIN) return `Write why the clinic is moved (at least ${MOVE_REASON_MIN} characters).`;
    return null;
  }

  async function save() {
    if (saving) return;
    const gap = clientProblem();
    if (gap) {
      setProblem(gap);
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      await crmPost<PlaceMoveResult>(
        "/api/phoenix-crm/list/places/move",
        {
          seatId,
          test,
          placeId: place.placeId,
          target,
          coordinates: target === "coordinates" ? coordinates.trim() : null,
          reason: reason.trim(),
        },
        "moved",
      );
      onDone({
        tone: "good",
        title: `Clinic moved: ${name}`,
        message: `${customer.name}. Its address, brick, area and region were read again from the new point, and the move is kept on record.`,
      });
    } catch (error) {
      const code = errorCodeOf(error);
      if (code === "phoenix_crm_place_not_found" || code === "phoenix_crm_place_retired") reload();
      setProblem(messageOf(error));
      setSaving(false);
    }
  }

  return (
    <CrmPanel>
      <CrmBackBar backLabel="Customer" onBack={onBack} title={`Move ${name}`} />
      <CrmBlock>
        <p className="break-words text-base font-black text-slate-950">{customer.name}</p>
        <p className="mt-0.5 break-words text-xs font-semibold text-slate-500">{customerMetaText(customer)}</p>
        <div className="mt-3 flex min-w-0 flex-wrap items-start gap-3">
          <CrmPhotoThumb
            alt={`Signboard photo: ${customer.name}, ${name}`}
            caption={`${customer.name} · ${name} · ${cairoStamp(place.capturedAt)}`}
            missingText={noPhotoTextFor(place.pointSource)}
            path={place.photoPath}
          />
          <div className="min-w-0 flex-1 basis-56">
            <p className="break-words text-sm font-black text-slate-950">{name}</p>
            <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-600">{where || "No address or brick on record"}</p>
            <p className="mt-0.5 break-words text-xs font-semibold leading-5 text-slate-500">{pointSourceText(place)}</p>
          </div>
        </div>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="The readings">
        <CrmFacts
          facts={[
            { label: "Fixed point now", value: readingText({ lat: place.lat, lon: place.lon, accuracyMeters: place.accuracyMeters ?? null }) },
            { label: "Validated", value: cairoStamp(place.capturedAt) },
            { label: "Photo reading", value: readingText(place.photoReading) },
            { label: "Capture-location pin", value: readingText(place.pinReading) },
            { label: "Between the two readings", value: apart },
          ]}
        />
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="1 · Where the clinic goes">
        <CrmChoice
          columns={3}
          label="Where the clinic goes"
          onChange={(next) => {
            setTarget(next);
            setProblem(null);
          }}
          options={[
            { value: "photo", label: "Use the photo reading", note: place.photoReading ? readingText(place.photoReading) : "Not measured", disabled: saving || !place.photoReading },
            { value: "pin", label: "Use the pin reading", note: place.pinReading ? readingText(place.pinReading) : "Not measured", disabled: saving || !place.pinReading },
            { value: "coordinates", label: "Enter coordinates", note: "Pasted from a map", disabled: saving },
          ]}
          value={target}
        />
        {target === "coordinates" ? (
          <CrmField className="mt-3" hint="Latitude, then longitude, as a map gives them." htmlFor="phoenix-crm-move-coordinates" label="Coordinates">
            <input
              autoComplete="off"
              className={crmInputClassName}
              disabled={saving}
              id="phoenix-crm-move-coordinates"
              onChange={(event) => {
                setCoordinates(event.target.value);
                setProblem(null);
              }}
              placeholder="30.0444, 31.2357"
              value={coordinates}
            />
          </CrmField>
        ) : null}
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100" title="2 · Why">
        <CrmField
          hint={`Needed · at least ${MOVE_REASON_MIN} characters · ${reasonLength} of ${MOVE_REASON_MAX}`}
          htmlFor="phoenix-crm-move-reason"
          label="Why the clinic is moved"
        >
          <textarea
            className={crmTextareaClassName}
            disabled={saving}
            id="phoenix-crm-move-reason"
            maxLength={MOVE_REASON_MAX}
            onChange={(event) => {
              setReason(event.target.value);
              setProblem(null);
            }}
            value={reason}
          />
        </CrmField>
      </CrmBlock>

      <CrmBlock className="border-t border-slate-100">
        <CrmNote tone="info">
          Moving changes where this clinic is on every screen: its address, brick, area and region are read again from the new point, and this
          customer&apos;s visits are measured against it again. The two original readings stay on record, with who moved it, when and why.
        </CrmNote>
        {problem ? (
          <CrmNote className="mt-3" tone="bad">
            {problem}
          </CrmNote>
        ) : null}
        <div className="mt-3 grid gap-2 sm:flex sm:flex-wrap">
          <CrmButton busy={saving} onClick={() => void save()} variant="primary">
            Move the clinic
          </CrmButton>
          <CrmButton disabled={saving} onClick={onBack}>
            Cancel
          </CrmButton>
        </div>
      </CrmBlock>
    </CrmPanel>
  );
}
