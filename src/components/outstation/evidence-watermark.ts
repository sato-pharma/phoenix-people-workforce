/**
 * Shared machinery for Phoenix's live evidence photos — the watermark burned into the ARRIVAL
 * photo captured in the submit wizard, and into the DEPARTURE photo captured afterwards from the
 * portal (owner request 2026-08-04).
 *
 * Extracted from mobile-outstation-wizard.tsx unchanged in behaviour, with ONE deliberate fix
 * noted on formatEvidenceDateTime below. Both captures must burn in the same stamp: the whole
 * point of the pair is that an approver can compare them, and two photos whose watermarks were
 * drawn by two different code paths are exactly the thing that drifts.
 *
 * Pure browser-canvas helpers, no React, so both a wizard step and a portal card can use them.
 *
 * 2026-08-23 — the location is no longer a single line of whatever the geocoder returned. It is
 * the three-line block defined in `src/lib/evidence/location-stamp.ts`: full address, Phoenix
 * brick/area/region, then the coordinates as fine print. The panel now grows to fit that block
 * instead of assuming a fixed height, because a caption clipped off the bottom of a JPEG is
 * unrecoverable evidence.
 */

import {
  formatEvidenceCoordinateLine,
  type EvidenceLocationStamp,
} from "@/lib/evidence/location-stamp";
import { PHOENIX_BUSINESS_TIME_ZONE } from "@/lib/i18n/format";

/** The resolved place for one capture: one line to store, several to burn in. */
export type ResolvedEvidenceLocation = {
  /** Single line for `capturedLocationLabel` and the approver screens that read it back. */
  label: string;
  /** The lines for the watermark panel, already worded and ordered. */
  lines: string[];
};

export const EVIDENCE_LOGO_SRC = "/brand/phoenix-camera-watermark.png";

/** Stored label when the device never produced a fix. Unchanged wording — it is read downstream. */
export const EVIDENCE_LOCATION_UNAVAILABLE_LABEL = "Location unavailable";

/**
 * The timestamp burned into the photo.
 *
 * This used to call `toLocaleString()` with no timeZone, so the stamp read in whatever zone the
 * employee's phone happened to be set to — and it is EVIDENCE, permanently baked into a JPEG that
 * an approver later compares against a trip date. A device set to the wrong zone produced a photo
 * that looked like it was taken on another day, unfixably. Pinned to Africa/Cairo, which is the
 * business timezone every other Phoenix report already uses.
 */
export function formatEvidenceDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: PHOENIX_BUSINESS_TIME_ZONE,
    year: "numeric",
  }).format(date);
}

/**
 * The same timestamp with the zone SAID OUT LOUD, for the burned-in panel only.
 *
 * On screen the reader knows they are in a Cairo-time app. On a JPEG that will be forwarded,
 * printed and read a year later, "02:22 pm" with no zone is an unanswerable question.
 */
export function formatEvidenceDateTimeStamp(value: string) {
  const formatted = formatEvidenceDateTime(value);
  return formatted === "N/A" ? formatted : `${formatted} (Cairo)`;
}

/** The stamp used when the lookup itself could not run — offline, timed out, or refused. */
function unresolvedLookup(
  latitude: number,
  longitude: number,
  accuracyMeters: number | null,
): ResolvedEvidenceLocation {
  const stamp: EvidenceLocationStamp = {
    accuracyMeters,
    address: null,
    areaName: null,
    brickDistanceKm: null,
    brickName: null,
    latitude,
    longitude,
    regionName: null,
  };
  return {
    label: `Unresolved location at ${formatEvidenceCoordinateLine(stamp).replace(/^GPS: /, "")}`,
    lines: [
      // Distinct from "no brick matched": that is an answer, this is the absence of one. An
      // approver must be able to tell "we looked and the pin is nowhere near a Phoenix brick"
      // from "we could not look".
      "Address: lookup unavailable at capture time",
      "Territory: not resolved — Phoenix brick, area and region unavailable",
      formatEvidenceCoordinateLine(stamp),
    ],
  };
}

/** The stamp used when the device produced no position at all. */
export function evidenceLocationWithoutFix(): ResolvedEvidenceLocation {
  return {
    label: EVIDENCE_LOCATION_UNAVAILABLE_LABEL,
    lines: ["Location: no GPS fix — the device did not report a position"],
  };
}

/** What every evidence-location endpoint returns. The flat fields are each module's own legacy. */
export type EvidenceLocationResponse = {
  area?: string | null;
  city?: string | null;
  governorate?: string | null;
  label?: string | null;
  location?: { label?: string | null; lines?: unknown } | null;
};

/**
 * How long a capture screen will wait for the address before stamping the photo without one.
 *
 * This is a HARD ceiling, not a nicety. Every capture surface now holds the shutter until the
 * location resolves, so an un-timed `fetch` on a rep's phone in a weak-signal pharmacy would lock
 * them out of filing evidence entirely — the failure mode is worse than the missing address. Twelve
 * seconds is the same patience the departure photo already gives the GPS itself.
 */
const EVIDENCE_LOOKUP_TIMEOUT_MS = 12_000;

function lookupTimeoutSignal() {
  return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(EVIDENCE_LOOKUP_TIMEOUT_MS)
    : undefined;
}

/**
 * One round trip to the caller's own evidence-location endpoint. Never throws, never hangs.
 *
 * The endpoint differs per module because the permission does: outstation evidence is gated on
 * `outstation:create`, Direct Order storefronts on `direct_orders:create`, marketing captures on
 * the marketing creator roles. The wording that comes back is identical — it is built by one shared
 * formatter on the server.
 */
export async function fetchEvidenceLocation(
  endpoint: string,
  latitude: number,
  longitude: number,
  accuracyMeters: number | null = null,
): Promise<EvidenceLocationResponse | null> {
  try {
    const response = await fetch(endpoint, {
      body: JSON.stringify({ accuracyMeters, latitude, longitude }),
      headers: { "Content-Type": "application/json" },
      method: "POST",
      signal: lookupTimeoutSignal(),
    });
    if (!response.ok) return null;
    return (await response.json()) as EvidenceLocationResponse;
  } catch {
    // Human-readable location is best-effort; GPS metadata remains attached.
    return null;
  }
}

/**
 * Read a stamp out of an endpoint response, falling back to the "we could not look" wording.
 *
 * Split from the fetch so a caller that needs the response's OTHER fields — the marketing capture
 * writes Google's area and governorate onto the customer — gets both from one request instead of
 * geocoding the same pin twice.
 */
export function readEvidenceLocationStamp(
  payload: EvidenceLocationResponse | null,
  latitude: number,
  longitude: number,
  accuracyMeters: number | null = null,
): ResolvedEvidenceLocation {
  const location = payload?.location;
  if (
    location &&
    Array.isArray(location.lines) &&
    location.lines.length > 0 &&
    typeof location.label === "string" &&
    location.label.trim()
  ) {
    return {
      label: location.label.trim(),
      lines: (location.lines as unknown[]).map((line) => String(line)),
    };
  }
  return unresolvedLookup(latitude, longitude, accuracyMeters);
}

/**
 * Resolve one captured pin into the evidence stamp.
 *
 * Best-effort, and never throws: a rep whose phone briefly loses the network still gets a stamped,
 * submittable photo, with the gap stated on its face.
 */
export async function resolveEvidenceLocationStamp(
  endpoint: string,
  latitude: number,
  longitude: number,
  accuracyMeters: number | null = null,
): Promise<ResolvedEvidenceLocation> {
  const payload = await fetchEvidenceLocation(endpoint, latitude, longitude, accuracyMeters);
  return readEvidenceLocationStamp(payload, latitude, longitude, accuracyMeters);
}

export function loadWatermarkLogo() {
  return new Promise<HTMLImageElement | null>((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = EVIDENCE_LOGO_SRC;
  });
}

/**
 * Break one caption into the lines the canvas will actually draw, at the context's CURRENT font.
 *
 * Measuring and drawing must go through this same function or the panel is sized for a different
 * number of lines than it renders — which is how a caption ends up half off the bottom edge.
 */
export function wrapWatermarkText(
  context: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/g).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;
    if (context.measureText(nextLine).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = nextLine;
    }
  }

  if (line) lines.push(line);
  return lines;
}

/**
 * Accepts a live camera frame OR an uploaded image, because both routes now feed the same
 * arrival-photo slot. The two elements report their intrinsic size under different property
 * names — reading `videoWidth` off an image yields `undefined` and would silently fall through
 * to the 1280x720 default, stretching every uploaded photo to 16:9.
 */
export function getCompressedEvidenceCanvasSize(source: HTMLVideoElement | HTMLImageElement) {
  const sourceWidth = ("videoWidth" in source ? source.videoWidth : source.naturalWidth) || 1280;
  const sourceHeight =
    ("videoHeight" in source ? source.videoHeight : source.naturalHeight) || 720;
  const maxDimension = 1280;
  const scale = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight));

  return {
    height: Math.max(1, Math.round(sourceHeight * scale)),
    width: Math.max(1, Math.round(sourceWidth * scale)),
  };
}

/** The measured geometry of one evidence panel. Everything `drawEvidenceWatermark` needs to draw. */
export type EvidencePanelLayout = {
  bodyFont: number;
  /** The last body line's baseline, in canvas coordinates. Must stay inside the frame. */
  lastBaselineY: number;
  lineHeight: number;
  lines: string[];
  logoSize: number;
  padding: number;
  panelHeight: number;
  textWidth: number;
  titleFont: number;
};

/**
 * Measure the panel BEFORE drawing it, so its height is derived from the captions rather than
 * assumed.
 *
 * Two rules, both learned the hard way elsewhere in this file:
 *   - measuring and drawing must use the same wrapper and the same font, or the panel is sized for
 *     a different number of lines than it renders;
 *   - captions are never truncated with an ellipsis (the owner's standing rule). When the block is
 *     too tall, the FONT shrinks — six 10% steps from ~15px down to 9px, which still reads on a
 *     1280px frame — and past that the panel is simply allowed to be tall. The line most likely to
 *     be dropped by a naive cut is the last one, which is the coordinate pair.
 *
 * Exported for the test that proves nothing lands off the bottom edge; `drawEvidenceWatermark` is
 * the only production caller.
 */
export function computeEvidencePanelLayout(
  context: CanvasRenderingContext2D,
  captions: string[],
  width: number,
  height: number,
): EvidencePanelLayout {
  const padding = Math.max(24, Math.round(width * 0.025));
  const logoSize = Math.max(112, Math.round(width * 0.13));
  const titleFont = Math.max(18, Math.round(width * 0.018));
  const textWidth = width - logoSize - padding * 3;
  const fixedHeight = padding * 2 + titleFont;
  const maxHeight = Math.round(height * 0.45);

  let bodyFont = Math.max(15, Math.round(width * 0.014));
  let lineHeight = Math.round(bodyFont * 1.45);
  let lines: string[] = [];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    lineHeight = Math.round(bodyFont * 1.45);
    context.font = `700 ${bodyFont}px sans-serif`;
    lines = captions.flatMap((caption) => wrapWatermarkText(context, caption, textWidth));
    if (fixedHeight + lineHeight * lines.length <= maxHeight || bodyFont <= 9) break;
    bodyFont = Math.max(9, Math.round(bodyFont * 0.9));
  }

  const contentHeight = fixedHeight + lineHeight * lines.length;
  const panelHeight = Math.min(
    height,
    // The old fixed 150px / 22% floor is kept so a short caption still sits on the same familiar
    // band; only a caption that needs more room grows past it.
    Math.max(150, Math.round(height * 0.22), contentHeight),
  );

  return {
    bodyFont,
    lastBaselineY:
      height - panelHeight + padding + titleFont + lineHeight * Math.max(1, lines.length),
    lineHeight,
    lines,
    logoSize,
    padding,
    panelHeight,
    textWidth,
    titleFont,
  };
}

/**
 * Burn the evidence panel into the bottom of the frame.
 *
 * `label` names which capture this is ("Arrival photo" / "Departure photo") so the two are
 * distinguishable from the image alone, without trusting the filename or the database row.
 *
 * `locationLines` comes from `resolveEvidenceLocationStamp` — address, territory, coordinates. The
 * panel height is DERIVED from how many lines those wrap to, so nothing is ever clipped.
 */
export async function drawEvidenceWatermark(
  context: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  details: {
    capturedAt: string;
    employeeHrId: string;
    label: string;
    locationLines: string[];
    reference: string;
  },
) {
  const width = canvas.width;
  const height = canvas.height;

  const captions = [
    `Time: ${formatEvidenceDateTimeStamp(details.capturedAt)}`,
    ...details.locationLines,
    `HR ID: ${details.employeeHrId} | ${details.reference}`,
  ];

  const { bodyFont, lineHeight, lines, logoSize, padding, panelHeight, titleFont } =
    computeEvidencePanelLayout(context, captions, width, height);

  const gradient = context.createLinearGradient(0, height - panelHeight, 0, height);
  gradient.addColorStop(0, "rgba(0,0,0,0)");
  gradient.addColorStop(0.35, "rgba(0,0,0,0.48)");
  gradient.addColorStop(1, "rgba(0,0,0,0.72)");
  context.fillStyle = gradient;
  context.fillRect(0, height - panelHeight, width, panelHeight);

  context.shadowColor = "rgba(0,0,0,0.65)";
  context.shadowBlur = 8;
  context.fillStyle = "#fff";
  context.font = `800 ${titleFont}px sans-serif`;
  context.fillText(`Phoenix Workforce — ${details.label}`, padding, height - panelHeight + padding + titleFont);

  // Re-assert the body font: the title above replaced it, and `lines` was measured under it.
  context.font = `700 ${bodyFont}px sans-serif`;
  context.shadowBlur = 6;
  let y = height - panelHeight + padding + titleFont + lineHeight;
  for (const line of lines) {
    context.fillText(line, padding, y);
    y += lineHeight;
  }

  const logo = await loadWatermarkLogo();
  if (logo) {
    context.shadowBlur = 10;
    context.drawImage(logo, width - padding - logoSize, height - padding - logoSize, logoSize, logoSize);
  }
  context.shadowBlur = 0;
}

/**
 * The caption block for the two simpler stampers (Direct Order storefronts, marketing captures),
 * which draw their own boxed panel rather than the outstation gradient.
 *
 * Shared so all three surfaces word the place identically — that was the whole complaint.
 */
export function buildEvidenceStampLines(input: {
  capturedAt: string;
  locationCapturedAt: string | null;
  locationLines: string[];
  title: string;
}): string[] {
  return [
    input.title,
    `Photo taken: ${formatEvidenceDateTimeStamp(input.capturedAt)}`,
    ...input.locationLines,
    ...(input.locationCapturedAt
      ? [`Location captured: ${formatEvidenceDateTimeStamp(input.locationCapturedAt)}`]
      : []),
  ];
}
