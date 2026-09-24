import type { VerifiedCaptureLocation } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// Turning one captured location string into its parts (owner ask, 2026-09-25: "make the customer
// location raw as it is and also separate it to brick, area, gov, clean address").
//
// A field capture is stored as one string. Direct-order captures decorate it with the resolved
// territory as a suffix:
//
//   "X863+4QW, Maadi …, Cairo Governorate 4064104, Egypt · Brick ش الكورنيش · Area Cairo West · Region Cairo"
//
// Marketing captures carry only the plain reverse-geocode, no suffix:
//
//   "XW45+PRF, 74 Al Jabal 17, 6th of October City (2), Giza Governorate 3231423, Egypt"
//
// `parseCapturedAddress` peels the "· Brick/Area/Region <name>" tags off the end (names already, so
// the owner's names-never-codes rule is kept), leaving the clean street address in front, and reads
// the governorate out of the Google address itself. Everything here is a PURE string function so it
// is unit-tested without a database.
// ─────────────────────────────────────────────────────────────────────────────

export type ParsedCaptureLocation = {
  /** The street address with the "· Brick/Area/Region" suffix removed. */
  cleanAddress: string | null;
  brick: string | null;
  area: string | null;
  /** The sales region tag ("Delta (1)", "Cairo"), when the capture carried one. */
  region: string | null;
  /** The governorate read out of the Google address ("Giza Governorate"). */
  governorate: string | null;
};

// The middot the field app joins tags with, with any surrounding whitespace.
const TAG_SEPARATOR = /\s*·\s*/;
const TAG = /^(brick|area|region)\b\s*(.*)$/i;

/** The governorate named inside a Google reverse-geocode, without its trailing postal code. */
export function extractGovernorate(address: string | null | undefined): string | null {
  const trimmed = typeof address === "string" ? address.trim() : "";
  if (!trimmed) return null;
  for (const segmentRaw of trimmed.split(",")) {
    const segment = segmentRaw.trim();
    if (/governorate/i.test(segment) || /محافظ/.test(segment)) {
      // Drop a trailing postal code like " 6131346", keep the readable name.
      const cleaned = segment.replace(/\s+[\d\s]+$/, "").trim();
      return cleaned || null;
    }
  }
  return null;
}

/** Split one captured location string into clean address + brick/area/region + governorate. */
export function parseCapturedAddress(raw: string | null | undefined): ParsedCaptureLocation {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  if (!trimmed) {
    return { cleanAddress: null, brick: null, area: null, region: null, governorate: null };
  }

  const parts = trimmed.split(TAG_SEPARATOR);
  const base = (parts.shift() ?? "").trim();
  let brick: string | null = null;
  let area: string | null = null;
  let region: string | null = null;
  for (const part of parts) {
    const match = TAG.exec(part.trim());
    if (!match) continue;
    const value = match[2].trim() || null;
    const key = match[1].toLowerCase();
    if (key === "brick") brick = value;
    else if (key === "area") area = value;
    else if (key === "region") region = value;
  }

  return {
    cleanAddress: base || null,
    brick,
    area,
    region,
    governorate: extractGovernorate(base),
  };
}

/**
 * Assemble the shape the gallery renders: the raw captured string kept verbatim, plus the parsed
 * pieces. A pre-resolved `brick`/`area`/`governorate` (e.g. a sales area name looked up from a code)
 * is used only as a fallback when the string itself did not carry that piece.
 */
export function buildCaptureLocation(input: {
  latitude: number | null;
  longitude: number | null;
  /** The composite capture string (direct orders) or Google reverse-geocode (marketing). */
  capturedAddress: string | null;
  /** The rep's own free-text address, used as the raw value when nothing was reverse-geocoded. */
  rawFallback?: string | null;
  brick?: string | null;
  area?: string | null;
  region?: string | null;
  governorate?: string | null;
}): VerifiedCaptureLocation {
  const parsed = parseCapturedAddress(input.capturedAddress);
  const rawFallback = input.rawFallback ?? null;
  return {
    latitude: input.latitude,
    longitude: input.longitude,
    address: parsed.cleanAddress ?? rawFallback,
    rawLocation: input.capturedAddress ?? rawFallback,
    brick: parsed.brick ?? input.brick ?? null,
    area: parsed.area ?? input.area ?? null,
    region: parsed.region ?? input.region ?? null,
    // A clean, pre-resolved governorate (marketing's `extracted_governorate_name`) wins over the one
    // scraped from the address; the scrape is the fallback for captures that carry no clean field.
    governorate: input.governorate ?? parsed.governorate ?? null,
  };
}
