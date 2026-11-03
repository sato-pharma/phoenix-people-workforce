"use client";

/**
 * Phoenix CRM — the visit's location, read in silence.
 *
 * Owner, 2026-09-29: "the medical rep just presses; in the back end we take his location". Log visit
 * is one tap: no photo, no map, no pin, no "finding your location" line. The phone's position is
 * watched from the moment the visit form opens, the best reading is kept, and the tap sends it.
 *
 * GOLDEN RULE #1, the BLIND half: nothing here is ever put into words for the rep. He is not told a
 * reading exists, how good it is, or what it is compared with. The one sentence he can meet is about
 * HIS OWN WORK failing — location switched off — and it is the server's own sentence
 * (`NO_FIX_FOR_A_VISIT`, entry-rules.ts): what to switch on, nothing about any check.
 *
 * Every location word the visit form needs lives in THIS file, so the form itself names none of them
 * (pinned by tests/phoenix-crm-one-tap-visit.test.ts).
 */

import { useCallback, useEffect, useRef } from "react";

import { locationReaderPayload, noteReading } from "@/components/phoenix-crm/location-reader";
import { VISIT_MAX_ACCURACY_METERS, withinAccuracy } from "@/lib/phoenix-crm/entry-rules";

/** One reading of the phone's position. `at` is when the phone took it, on the phone's clock. */
export type SilentFix = { lat: number; lon: number; accuracyMeters: number | null; at: number };

/**
 * Answers with the kept reading, waiting up to `waitMs` for one the visit save will take; null when
 * there is none at all.
 */
export type SilentFixReader = (waitMs?: number) => Promise<SilentFix | null>;

/** How long Log visit waits for a first reading, or a sharper one, before it sends what it has. */
export const SILENT_FIX_WAIT_MS = 8_000;

/**
 * Whether the kept reading is one the visit save takes (`VISIT_MAX_ACCURACY_METERS`, entry-rules.ts).
 * A phone's first reading is often a rough one from the network before its GPS settles, so a tap that
 * comes too soon waits for a sharper one rather than meeting the server's refusal for a phone that was
 * about to be fine. Only a phone that stays rough — approximate location — reaches that refusal.
 */
function goodEnough(fix: SilentFix | null): fix is SilentFix {
  return fix !== null && withinAccuracy(fix.accuracyMeters, VISIT_MAX_ACCURACY_METERS);
}

/** A newer reading replaces a sharper one once the sharper one is this old: he may have walked on. */
const STALE_MS = 15_000;

/** Whether a new reading should replace the one kept: sharper, or the kept one has gone stale. */
function replaces(current: SilentFix | null, reading: SilentFix): boolean {
  if (!current || current.accuracyMeters === null) return true;
  if (reading.accuracyMeters !== null && reading.accuracyMeters <= current.accuracyMeters) return true;
  return reading.at - current.at > STALE_MS;
}

/**
 * Starts watching the position when the calling screen mounts and stops when it goes. Returns the
 * reader Log visit calls from its own handler.
 *
 * A refusal stops the watch and answers anyone waiting at once; the next call starts it again, because
 * the rep may have switched location on between two taps.
 *
 * `active` false holds the watch until the screen needs it (Validate, on the customer's own door, which
 * has its own Capture location). The reader still starts it when called.
 */
export function useSilentFix(active: boolean = true): SilentFixReader {
  const bestRef = useRef<SilentFix | null>(null);
  const watchRef = useRef<number | null>(null);
  const waitersRef = useRef<Set<() => void>>(new Set());

  const wake = useCallback(() => {
    for (const waiter of [...waitersRef.current]) waiter();
  }, []);

  const stop = useCallback(() => {
    if (watchRef.current !== null && typeof navigator !== "undefined") navigator.geolocation?.clearWatch(watchRef.current);
    watchRef.current = null;
  }, []);

  const start = useCallback((): boolean => {
    if (typeof navigator === "undefined" || !navigator.geolocation) return false;
    if (watchRef.current !== null) return true;
    watchRef.current = navigator.geolocation.watchPosition(
      (position) => {
        noteReading(position);
        const reading: SilentFix = {
          lat: position.coords.latitude,
          lon: position.coords.longitude,
          accuracyMeters: Number.isFinite(position.coords.accuracy) ? position.coords.accuracy : null,
          at: position.timestamp || Date.now(),
        };
        if (replaces(bestRef.current, reading)) bestRef.current = reading;
        wake();
      },
      (error) => {
        // Refused: nothing more will come, so whoever is waiting is answered now. A slow or missing
        // signal is not a refusal — the watch keeps going and the waiter's own clock answers it.
        if (error.code === error.PERMISSION_DENIED) {
          stop();
          wake();
        }
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
    );
    return true;
  }, [stop, wake]);

  useEffect(() => {
    if (!active) return;
    start();
    return () => stop();
  }, [active, start, stop]);

  return useCallback(
    (waitMs: number = SILENT_FIX_WAIT_MS) => {
      if (goodEnough(bestRef.current)) return Promise.resolve(bestRef.current);
      if (!start()) return Promise.resolve(bestRef.current);
      return new Promise<SilentFix | null>((resolve) => {
        const waiters = waitersRef.current;
        const finish = () => {
          window.clearTimeout(timer);
          waiters.delete(check);
          resolve(bestRef.current);
        };
        // Woken by every reading and by a refusal: answers once the kept reading is one the save
        // takes, or the watch has stopped and nothing more will come. Otherwise the clock answers it
        // with whatever is kept, and the server's own sentence says what to switch on.
        const check = () => {
          if (goodEnough(bestRef.current) || watchRef.current === null) finish();
        };
        const timer = window.setTimeout(finish, waitMs);
        waiters.add(check);
      });
    },
    [start],
  );
}

/**
 * The reading as the visit save reads it (`parseCapturedFix`, entry-rules.ts).
 *
 * `deviceCapturedAt` is the phone's clock at the TAP, which the server compares with its own clock on
 * arrival — a manager's fact, never the rep's. `deviceMocked` is null: a browser cannot ask the
 * question, and null is "not asked", never "clean".
 *
 * `fixTakenAt` is `fix.at` — the instant the PHONE took the reading, which this file has always read
 * from `position.timestamp` and then dropped. Sending it is what stops the server's receipt being the
 * only clock on a one-tap visit: the two together say how old the reading already was when he pressed,
 * both ends measured by the same phone, so a wrong phone clock cancels out of the answer.
 *
 * `readerReplaced` / `readerFindings` answer the question the web CAN ask in place of `deviceMocked`:
 * whether the browser's own location reader is still the browser's (location-reader.ts). Asked at
 * the tap, recorded for the board, refused to nobody.
 */
export function silentFixPayload(fix: SilentFix, tappedAt: number) {
  // A reading with no usable clock sends none. `new Date(NaN).toISOString()` throws, and a throw here
  // would cost a rep standing at a door the visit he actually made — the one thing this file may
  // never do.
  const takenAt = Number.isFinite(fix.at) ? new Date(fix.at) : null;
  return {
    lat: fix.lat,
    lon: fix.lon,
    accuracyMeters: fix.accuracyMeters === null ? null : Math.round(fix.accuracyMeters * 10) / 10,
    deviceCapturedAt: new Date(tappedAt).toISOString(),
    fixTakenAt: takenAt !== null && !Number.isNaN(takenAt.getTime()) ? takenAt.toISOString() : null,
    deviceMocked: null,
    ...locationReaderPayload(),
  };
}
