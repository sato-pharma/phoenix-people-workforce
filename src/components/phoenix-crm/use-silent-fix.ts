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

/** One reading of the phone's position. `at` is when the phone took it, on the phone's clock. */
export type SilentFix = { lat: number; lon: number; accuracyMeters: number | null; at: number };

/** Answers with the kept reading, waiting up to `waitMs` for a first one; null when there is none. */
export type SilentFixReader = (waitMs?: number) => Promise<SilentFix | null>;

/** How long Log visit waits for a first reading when none has come in yet. */
export const SILENT_FIX_WAIT_MS = 8_000;

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
 */
export function useSilentFix(): SilentFixReader {
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
    start();
    return () => stop();
  }, [start, stop]);

  return useCallback(
    (waitMs: number = SILENT_FIX_WAIT_MS) => {
      if (bestRef.current) return Promise.resolve(bestRef.current);
      if (!start()) return Promise.resolve(null);
      return new Promise<SilentFix | null>((resolve) => {
        const waiters = waitersRef.current;
        const finish = () => {
          window.clearTimeout(timer);
          waiters.delete(finish);
          resolve(bestRef.current);
        };
        const timer = window.setTimeout(finish, waitMs);
        waiters.add(finish);
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
 */
export function silentFixPayload(fix: SilentFix, tappedAt: number) {
  return {
    lat: fix.lat,
    lon: fix.lon,
    accuracyMeters: fix.accuracyMeters === null ? null : Math.round(fix.accuracyMeters * 10) / 10,
    deviceCapturedAt: new Date(tappedAt).toISOString(),
    deviceMocked: null,
  };
}
