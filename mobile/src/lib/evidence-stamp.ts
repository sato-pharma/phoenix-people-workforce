/**
 * The words and the geometry of a Phoenix evidence stamp, for the native app.
 *
 * A PORT, NOT A NEW DESIGN. The web app burns this stamp into every outstation arrival and
 * departure photo — `src/components/outstation/evidence-watermark.ts` draws it and
 * `src/lib/evidence/location-stamp.ts` words the location — and an approver compares a departure
 * photo against its arrival photo. A departure photo taken on this app has to carry the stamp the
 * portal would have drawn, line for line and position for position, or the pair stops being
 * comparable.
 *
 * The app cannot import those two files: `mobile/` is its own TypeScript project (its `@/*` alias
 * points at `mobile/src`), and the watermark module draws on a browser canvas. So the pure half of
 * both is copied here, and 🔴 `tests/mobile-evidence-stamp-parity.test.ts`, in the web app's
 * required `test` check, runs the web originals and this port side by side and fails on any
 * difference: the time, every fallback wording, the wrapped lines, the panel geometry, and every
 * draw call's text, position, font, shadow and gradient stop. Change the web stamp and that test
 * says to change this file in the same PR — never re-pin the test to make the two agree.
 *
 * NO IMPORTS AT ALL, on purpose. The parity test loads this file under plain Node, and the Skia
 * executor (`evidence-burn.ts`) and the capture flow (`evidence-photo.ts`) both read every number
 * from here, so they cannot disagree about a single coordinate.
 */

/** The business time zone every Phoenix stamp is written in — `PHOENIX_BUSINESS_TIME_ZONE` on the web. */
export const EVIDENCE_TIME_ZONE = "Africa/Cairo";

/**
 * How long a capture waits for the GPS fix, and then again for the address lookup, before stamping
 * the photo without it. The web gives the GPS and the lookup the same twelve seconds each, and for
 * the same reason: a rep in a weak-signal place must still be able to file the photo, with the gap
 * written on its face, rather than be locked out by a spinner.
 */
export const EVIDENCE_LOOKUP_TIMEOUT_MS = 12_000;

/** Longest side of the uploaded JPEG, from `getCompressedEvidenceCanvasSize` on the web. */
export const EVIDENCE_MAX_DIMENSION = 1280;

/** JPEG quality, from the web card's `canvas.toDataURL("image/jpeg", 0.74)`. */
export const EVIDENCE_JPEG_QUALITY = 0.74;

/** The server refuses anything larger — `CAR_EVIDENCE_MAX_UPLOAD_BYTES` in `car-evidence-storage.ts`. */
export const EVIDENCE_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** The route that turns a pin into the stamp's address and territory lines, gated on `outstation:create`. */
export const OUTSTATION_REVERSE_GEOCODE_PATH = "/api/outstation/reverse-geocode";

/** Names which capture this is, so the photo says so without trusting a filename or a row. */
export const DEPARTURE_PHOTO_LABEL = "Departure photo";

/** The reference line's right half, exactly as the portal's departure card writes it. */
export function departurePhotoReference(requestId: number): string {
  return `Request: ${requestId}`;
}

/** Stored label when the device never produced a fix. Unchanged wording — it is read downstream. */
export const EVIDENCE_LOCATION_UNAVAILABLE_LABEL = "Location unavailable";

/** The resolved place for one capture: one line to store, several to burn in. */
export type ResolvedEvidenceLocation = {
  /** Single line for `capturedLocationLabel` and the approver screens that read it back. */
  label: string;
  /** The lines for the watermark panel, already worded and ordered. */
  lines: string[];
};

/** What the reverse-geocode route returns. Only `location` is read here. */
export type EvidenceLocationResponse = {
  area?: string | null;
  city?: string | null;
  governorate?: string | null;
  label?: string | null;
  location?: { label?: string | null; lines?: unknown } | null;
};

/** The pin itself. The web's `EvidenceLocationStamp` carries more, but the coordinate line reads only these. */
export type EvidencePin = {
  accuracyMeters: number | null;
  latitude: number;
  longitude: number;
};

/**
 * The timestamp burned into the photo, always in Cairo.
 *
 * It is evidence, permanently baked into a JPEG that an approver later compares against a trip
 * date, so it never follows the phone's own zone setting — a handset set to the wrong zone would
 * otherwise stamp a photo that looks as if it was taken on another day.
 */
export function formatEvidenceDateTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "N/A";
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    hour: "2-digit",
    hour12: true,
    minute: "2-digit",
    month: "short",
    timeZone: EVIDENCE_TIME_ZONE,
    year: "numeric",
  }).format(date);
}

/** The same timestamp with the zone said out loud, for the burned-in panel. */
export function formatEvidenceDateTimeStamp(value: string): string {
  const formatted = formatEvidenceDateTime(value);
  return formatted === "N/A" ? formatted : `${formatted} (Cairo)`;
}

/** The separator between fields on one stamp line. Spaced so it reads as fields, not one value. */
const FIELD_SEPARATOR = "  ·  ";

/** Six decimals with an explicit hemisphere, so a negative sign can never be mistaken for a typo. */
export function formatCoordinatePair(latitude: number, longitude: number): string {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return "unavailable";
  const lat = `${Math.abs(latitude).toFixed(6)}°${latitude < 0 ? "S" : "N"}`;
  const lng = `${Math.abs(longitude).toFixed(6)}°${longitude < 0 ? "W" : "E"}`;
  return `${lat}, ${lng}`;
}

/** `GPS: 30.059482°N, 31.223145°E  ·  accuracy ±12 m` */
export function formatEvidenceCoordinateLine(pin: EvidencePin): string {
  const accuracy =
    pin.accuracyMeters != null && Number.isFinite(pin.accuracyMeters)
      ? `${FIELD_SEPARATOR}accuracy ±${Math.round(Number(pin.accuracyMeters))} m`
      : "";
  return `GPS: ${formatCoordinatePair(pin.latitude, pin.longitude)}${accuracy}`;
}

/**
 * The stamp used when the lookup itself could not run — offline, timed out, or refused.
 *
 * Distinct from "no brick matched": that is an answer, this is the absence of one, and an approver
 * must be able to tell the two apart from the photo alone.
 */
function unresolvedLookup(pin: EvidencePin): ResolvedEvidenceLocation {
  const coordinates = formatEvidenceCoordinateLine(pin);
  return {
    label: `Unresolved location at ${coordinates.replace(/^GPS: /, "")}`,
    lines: [
      "Address: lookup unavailable at capture time",
      "Territory: not resolved — Phoenix brick, area and region unavailable",
      coordinates,
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

/**
 * Read a stamp out of the reverse-geocode response, falling back to the "we could not look" wording.
 *
 * The address and territory lines are worded by the SERVER, by the one formatter every capture
 * surface shares, so this never words a place itself — it only decides whether the answer is usable.
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
  return unresolvedLookup({ accuracyMeters, latitude, longitude });
}

/** What one capture burns in, besides the frame itself. */
export type EvidenceStampDetails = {
  capturedAt: string;
  employeeHrId: string;
  /** "Departure photo" — which capture this is. */
  label: string;
  locationLines: string[];
  /** "Request: 123" — which record it belongs to. */
  reference: string;
};

/** The body lines of the panel, in reading order, before wrapping. */
export function buildEvidenceCaptions(details: EvidenceStampDetails): string[] {
  return [
    `Time: ${formatEvidenceDateTimeStamp(details.capturedAt)}`,
    ...details.locationLines,
    `HR ID: ${details.employeeHrId} | ${details.reference}`,
  ];
}

/** The panel's title line. */
export function evidenceTitle(label: string): string {
  return `Phoenix Workforce — ${label}`;
}

/** The two weights the stamp uses: 800 for the title, 700 for every body line. */
export type EvidenceFontWeight = 700 | 800;

/**
 * Width of `text` drawn in the stamp's sans-serif at this size and weight, in pixels.
 *
 * The web measures with the canvas; the app measures with a Skia paragraph. Both must measure and
 * draw through the SAME function, or the panel is sized for a different number of lines than it
 * renders — which is how a caption ends up half off the bottom edge of a JPEG.
 */
export type EvidenceTextMeasure = (text: string, sizePx: number, weight: EvidenceFontWeight) => number;

/** Break one caption into the lines that will actually be drawn. Word-wrapped, never truncated. */
export function wrapWatermarkText(
  measure: (text: string) => number,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/g).filter(Boolean);
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    const nextLine = line ? `${line} ${word}` : word;
    if (measure(nextLine) > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = nextLine;
    }
  }

  if (line) lines.push(line);
  return lines;
}

/** The uploaded size: the longest side at most 1280, never upscaled, never zero. */
export function getCompressedEvidenceSize(sourceWidth: number, sourceHeight: number) {
  const width = sourceWidth || 1280;
  const height = sourceHeight || 720;
  const scale = Math.min(1, EVIDENCE_MAX_DIMENSION / Math.max(width, height));

  return {
    height: Math.max(1, Math.round(height * scale)),
    width: Math.max(1, Math.round(width * scale)),
  };
}

/** The measured geometry of one evidence panel. */
export type EvidencePanelLayout = {
  bodyFont: number;
  /** The last body line's baseline. Must stay inside the frame. */
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
 * Measure the panel BEFORE drawing it, so its height comes from the captions rather than being
 * assumed. Captions are never cut with an ellipsis: when the block is too tall the FONT shrinks, six
 * 10% steps down to 9px, and past that the panel is allowed to be tall.
 */
export function computeEvidencePanelLayout(
  measure: EvidenceTextMeasure,
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
    const size = bodyFont;
    lines = captions.flatMap((caption) =>
      wrapWatermarkText((text) => measure(text, size, 700), caption, textWidth),
    );
    if (fixedHeight + lineHeight * lines.length <= maxHeight || bodyFont <= 9) break;
    bodyFont = Math.max(9, Math.round(bodyFont * 0.9));
  }

  const contentHeight = fixedHeight + lineHeight * lines.length;
  const panelHeight = Math.min(height, Math.max(150, Math.round(height * 0.22), contentHeight));

  return {
    bodyFont,
    lastBaselineY: height - panelHeight + padding + titleFont + lineHeight * Math.max(1, lines.length),
    lineHeight,
    lines,
    logoSize,
    padding,
    panelHeight,
    textWidth,
    titleFont,
  };
}

/** One run of text, placed the way canvas `fillText` places it: left edge and alphabetic baseline. */
export type EvidenceTextRun = {
  color: string;
  shadowColor: string;
  /** Canvas `shadowBlur`. A Skia blur takes a sigma, which is half of this. */
  shadowBlur: number;
  sizePx: number;
  text: string;
  weight: EvidenceFontWeight;
  x: number;
  /** The BASELINE, not the top of the line. */
  y: number;
};

/** Everything one stamp draws, in drawing order, as data — no canvas, no Skia. */
export type EvidenceDrawPlan = {
  /** The dark band behind the text: a vertical gradient filling the bottom of the frame. */
  band: {
    from: { x: number; y: number };
    rect: { height: number; width: number; x: number; y: number };
    stops: { color: string; offset: number }[];
    to: { x: number; y: number };
  };
  layout: EvidencePanelLayout;
  /** Bottom-right. Skipped by the executor when the logo cannot be loaded, exactly as on the web. */
  logo: { shadowBlur: number; shadowColor: string; size: number; x: number; y: number };
  texts: EvidenceTextRun[];
};

const STAMP_INK = "#fff";
const STAMP_SHADOW = "rgba(0,0,0,0.65)";

/** The whole stamp for one frame, from the same numbers `drawEvidenceWatermark` uses on the web. */
export function planEvidenceWatermark(
  measure: EvidenceTextMeasure,
  details: EvidenceStampDetails,
  width: number,
  height: number,
): EvidenceDrawPlan {
  const layout = computeEvidencePanelLayout(measure, buildEvidenceCaptions(details), width, height);
  const { bodyFont, lineHeight, lines, logoSize, padding, panelHeight, titleFont } = layout;
  const top = height - panelHeight;

  const texts: EvidenceTextRun[] = [
    {
      color: STAMP_INK,
      shadowBlur: 8,
      shadowColor: STAMP_SHADOW,
      sizePx: titleFont,
      text: evidenceTitle(details.label),
      weight: 800,
      x: padding,
      y: top + padding + titleFont,
    },
  ];

  let y = top + padding + titleFont + lineHeight;
  for (const line of lines) {
    texts.push({
      color: STAMP_INK,
      shadowBlur: 6,
      shadowColor: STAMP_SHADOW,
      sizePx: bodyFont,
      text: line,
      weight: 700,
      x: padding,
      y,
    });
    y += lineHeight;
  }

  return {
    band: {
      from: { x: 0, y: top },
      rect: { height: panelHeight, width, x: 0, y: top },
      stops: [
        { color: "rgba(0,0,0,0)", offset: 0 },
        { color: "rgba(0,0,0,0.48)", offset: 0.35 },
        { color: "rgba(0,0,0,0.72)", offset: 1 },
      ],
      to: { x: 0, y: height },
    },
    layout,
    logo: {
      shadowBlur: 10,
      shadowColor: STAMP_SHADOW,
      size: logoSize,
      x: width - padding - logoSize,
      y: height - padding - logoSize,
    },
    texts,
  };
}
