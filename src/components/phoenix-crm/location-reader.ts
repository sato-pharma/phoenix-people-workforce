"use client";

/**
 * Phoenix CRM — the page half of `location-reader-probe.ts`: keeps the readings this page was handed
 * and answers, at the moment a capture is sent, whether the browser's location reader is its own.
 *
 * Every Phoenix CRM reader calls `noteReading` from its success callback, and every capture body
 * spreads `locationReaderPayload()` beside its coordinates. Nothing here is shown, refused, awaited
 * or allowed to throw: a rep's save must never be lost because this had a bad day (Golden Rule #1).
 */

import { probeLocationReader, type LocationReaderAnswer } from "@/lib/phoenix-crm/location-reader-probe";

/** A handful is plenty: a made-up reading looks made-up every time, and this page may live all day. */
const KEPT_READINGS = 4;

const readings: unknown[] = [];

/** Keep a reading the page was just handed, so its object type can be asked when a capture is sent. */
export function noteReading(position: unknown): void {
  try {
    readings.push(position);
    if (readings.length > KEPT_READINGS) readings.splice(0, readings.length - KEPT_READINGS);
  } catch {
    // Never in the way of the reading itself.
  }
}

/** The two keys every capture body carries, under the names `parseCapturedFix` reads. */
export function locationReaderPayload(): LocationReaderAnswer {
  try {
    if (typeof window === "undefined") return { readerReplaced: null, readerFindings: [] };
    const scope = window as unknown as Record<string, unknown>;
    return probeLocationReader(
      {
        navigator: typeof navigator === "undefined" ? undefined : navigator,
        Geolocation: scope.Geolocation,
        GeolocationPosition: scope.GeolocationPosition,
        GeolocationCoordinates: scope.GeolocationCoordinates,
      },
      readings,
    );
  } catch {
    return { readerReplaced: null, readerFindings: [] };
  }
}
