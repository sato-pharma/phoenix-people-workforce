/**
 * The two photos an outstation approver decides on, arrival and departure, as one list.
 *
 * Owner report (2026-09-18): the Super Admin approves every outstation expense and "can't see any
 * of the photos". Two causes. The departure photo was never signed on any admin read path, so no
 * approver screen could show it: its distance and timing review, the "taken far from the trip"
 * flag meant to prompt a human look, had only ever been visible to the employee himself. And the
 * Expense Approvals page showed the arrival photo as a 160px cropped tile labelled "Car evidence",
 * although every trip needs one, not only a car trip.
 *
 * Pure and type-only on purpose, so the approval screens (client) and the attachments route
 * (server) read one answer. It must never import departure-evidence.ts, which pulls the sales geo
 * module into the browser bundle: the review was computed when the photo was taken and stored in
 * the metadata, and it is read from there. evidence-waiver.ts, captured-coordinates.ts and
 * departure-location-refusals.ts pull in nothing heavier than a number reader, so all are safe here.
 */
import { usablePosition } from "@/lib/outstation/captured-coordinates";
import {
  NO_GPS_CAUSE_NOT_REPORTED,
  noGpsLocationText,
  readDepartureLocationRefusals,
} from "@/lib/outstation/departure-location-refusals";
import { isOutstationEvidenceWaivedRole } from "@/lib/outstation/evidence-waiver";
import type {
  OutstationCarEvidenceMetadata,
  OutstationDepartureEvidenceMetadata,
  OutstationEvidenceGateStatus,
} from "@/lib/outstation/types";

export type ApproverTripPhotoKind = "arrival" | "departure";

export type ApproverTripPhoto = {
  capturedAt: string | null;
  /**
   * The photo is on file with no GPS position: `DEPARTURE_PHOTO_NO_GPS_NOTE`. Null when the photo
   * has a position or there is no photo. Departure only: an arrival with no fix is refused at
   * capture, so it can never be stored without one.
   */
  gpsMissingReason: string | null;
  /** True only when the stored review raised a flag. A flag asks for a look; it never blocks pay. */
  isFlagged: boolean;
  kind: ApproverTripPhotoKind;
  label: "Arrival photo" | "Departure photo";
  /**
   * Where the photo was taken, from the stored metadata — so the approver's map can pin it beside
   * the trip's check-ins (owner, 2026-11-07). Null when the photo has no usable position (the
   * 0,0 marker counts as none, captured-coordinates.ts) or there is no photo.
   */
  latitude: number | null;
  locationLabel: string | null;
  longitude: number | null;
  /** Why no picture is shown, in words: never taken, or on file but not openable right now. */
  missingNote: string | null;
  /**
   * Departure photos refused for having no GPS location, oldest first, each with its time and its
   * cause in the owner's words ("No GPS location because ..."). Always empty on the arrival photo.
   */
  refusedTries: Array<{ at: string; text: string }>;
  /** How many earlier captures this one replaced. Every earlier version is kept in the metadata. */
  retakeCount: number;
  /** The departure review stored with the photo, for example "Departure photo captured 3 km ...". */
  review: string | null;
  /** The arrival photo can be an upload instead of a live capture, and the approver must know. */
  sourceNote: string | null;
  url: string | null;
};

export type ApproverTripPhotosInput = {
  carEvidenceImagePath?: string | null;
  carEvidenceImageUrl?: string | null;
  carEvidenceMetadata?: OutstationCarEvidenceMetadata | null;
  departureEvidenceImagePath?: string | null;
  departureEvidenceImageUrl?: string | null;
  departureEvidenceMetadata?: OutstationDepartureEvidenceMetadata | null;
  /** The stored refused tries (departure_location_refusals), read defensively. */
  departureLocationRefusals?: unknown;
  employeeRole?: string | null;
  evidenceGateStatus?: OutstationEvidenceGateStatus | null;
};

/**
 * What the approver reads under a departure photo on file with no GPS position (owner, 2026-09-18:
 * "the system must record the reason"). Since the same day such a photo is refused at capture and
 * nothing is stored (departure-photo-location.ts), so only one saved before then reaches here, and
 * nothing recorded why its position was missing. Owner, same day: short, the fact only, no history.
 */
export const DEPARTURE_PHOTO_NO_GPS_NOTE = NO_GPS_CAUSE_NOT_REPORTED;

function text(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

/**
 * A photo that was never owed must not read as a missing one: the three waived roles owe none
 * (evidence-waiver.ts), and a trip from before the two-photo rule could never be photographed.
 */
function notOwedNote(input: ApproverTripPhotosInput): string | null {
  if (isOutstationEvidenceWaivedRole(input.employeeRole)) return "Not required: this role owes no trip photos.";
  if (input.evidenceGateStatus === "grandfathered") return "Not required: submitted before the two-photo rule.";
  return null;
}

function missingNote(label: string, path: string | null, url: string | null, notOwed: string | null): string | null {
  if (url) return null;
  if (path) return `The ${label.toLowerCase()} is on file but could not be opened right now. Reload the page to try again.`;
  return notOwed ?? `No ${label.toLowerCase()} has been taken.`;
}

/** Always two entries, arrival first, so a missing photo is said out loud instead of vanishing. */
export function approverTripPhotos(input: ApproverTripPhotosInput): [ApproverTripPhoto, ApproverTripPhoto] {
  const arrivalUrl = text(input.carEvidenceImageUrl);
  const arrivalPath = text(input.carEvidenceImagePath);
  const arrivalMeta = input.carEvidenceMetadata ?? null;

  const departureUrl = text(input.departureEvidenceImageUrl);
  const departurePath = text(input.departureEvidenceImagePath);
  const departureMeta = input.departureEvidenceMetadata ?? null;
  const departureFlags = Array.isArray(departureMeta?.flags) ? departureMeta.flags : [];
  const version = Number(departureMeta?.version);
  const notOwed = notOwedNote(input);
  // No position is what the domain already calls it: nothing, half a pair, or the old 0,0 marker.
  const departureGpsMissingReason =
    departurePath && departureMeta && !usablePosition(departureMeta.capturedLatitude, departureMeta.capturedLongitude)
      ? DEPARTURE_PHOTO_NO_GPS_NOTE
      : null;
  const refusedTries = readDepartureLocationRefusals(input.departureLocationRefusals).map((refusal) => ({
    at: refusal.at,
    text: noGpsLocationText(refusal.reason),
  }));
  // A position only travels with a photo that exists: metadata left behind by a deleted file
  // must not put a pin on the map for a picture nobody can see.
  const arrivalPosition = arrivalPath ? usablePosition(arrivalMeta?.capturedLatitude, arrivalMeta?.capturedLongitude) : null;
  const departurePosition = departurePath
    ? usablePosition(departureMeta?.capturedLatitude, departureMeta?.capturedLongitude)
    : null;

  return [
    {
      capturedAt: text(arrivalMeta?.capturedAt),
      gpsMissingReason: null,
      isFlagged: false,
      kind: "arrival",
      label: "Arrival photo",
      latitude: arrivalPosition?.latitude ?? null,
      locationLabel: text(arrivalMeta?.capturedLocationLabel),
      longitude: arrivalPosition?.longitude ?? null,
      missingNote: missingNote("Arrival photo", arrivalPath, arrivalUrl, notOwed),
      refusedTries: [],
      retakeCount: 0,
      review: null,
      sourceNote: arrivalMeta?.source === "upload" ? "Uploaded, not captured with the live camera." : null,
      url: arrivalUrl,
    },
    {
      capturedAt: text(departureMeta?.capturedAt),
      gpsMissingReason: departureGpsMissingReason,
      isFlagged: departureFlags.length > 0,
      kind: "departure",
      label: "Departure photo",
      latitude: departurePosition?.latitude ?? null,
      // "Location unavailable" beside the reason would say the same thing twice, less well.
      locationLabel: departureGpsMissingReason ? null : text(departureMeta?.capturedLocationLabel),
      longitude: departurePosition?.longitude ?? null,
      missingNote: missingNote("Departure photo", departurePath, departureUrl, notOwed),
      refusedTries,
      retakeCount: Number.isFinite(version) ? Math.max(0, Math.trunc(version) - 1) : 0,
      review: text(departureMeta?.summary),
      sourceNote: null,
      url: departureUrl,
    },
  ];
}
