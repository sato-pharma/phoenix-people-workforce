"use client";

/**
 * Phoenix CRM — the phone's location receiver, switched on early and in silence while a capture screen is
 * open, and asked since when it has been running.
 *
 * WHY (22 Oct 2026). A receiver that has just been switched on answers first from nearby networks, and a
 * network answer can land kilometres away while claiming tens of metres. The live camera switched its
 * receiver on only as it opened, so a rep who opened it and pressed at once photographed the clinic with
 * the network's guess: Dr Tharwat Milad's signboard in Dishna was stamped Faw Bahari, 10 km away, and the
 * pin the same phone took five seconds later read Dishna. Holding the receiver on from the moment the
 * validation screen opens means the satellites have usually locked before the camera or the pin is
 * reached, so both are read from them. Nothing waits on it and nothing is shown: Golden Rule #1.
 *
 * It starts only where location is ALREADY allowed for the site. Asking for the permission the moment a
 * screen opens, before the rep has done anything that needs it, would put a browser prompt in front of him
 * at a moment he cannot place, and a refusal there would block the camera that needs it. Where it is not
 * yet allowed, the camera and the pin ask exactly as they always have.
 *
 * `receiverRunningSince` answers the camera's one question about it (photo-reading-rules.ts): was a
 * reading taken while the receiver was still cold? Every watch on the page counts, the warm-up and the
 * camera's own, and the earliest one still running is the answer.
 */

import { useEffect } from "react";

import { noteReading } from "@/components/phoenix-crm/location-reader";

/** Every watch running on this page, by token, with the moment it started on this page's clock. */
const running = new Map<number, number>();
let nextToken = 1;

/** Record that a watch has started. The token is handed back to `receiverStopped`. */
export function receiverStarted(): number {
  const token = nextToken;
  nextToken += 1;
  running.set(token, Date.now());
  return token;
}

/** Record that a watch has stopped. A null token, or one already stopped, is nothing. */
export function receiverStopped(token: number | null): void {
  if (token !== null) running.delete(token);
}

/** Since when the receiver has been running without a break: the earliest watch still running, or null. */
export function receiverRunningSince(): number | null {
  let since: number | null = null;
  for (const startedAt of running.values()) if (since === null || startedAt < since) since = startedAt;
  return since;
}

// ── The warm-up's own latest reading ────────────────────────────────────────────────────────────
//
// 🔴 KEPT, NOT THROWN AWAY (12 Nov 2026, the owner validating in training: "the location took hilarious
// time"). The warm-up used to hand its readings to `noteReading` and nothing else, so the camera — opened
// after the receiver had already been reading for a minute — started a watch of its own with
// `maximumAge: 0` and held "Take the photo" until THAT watch answered. Indoors the phone sends a new
// reading only every so often, so the rep stood waiting for a reading the page had already been handed.
// The camera now starts from this one when it is recent; its own watch and the fresh shutter reading
// still replace it exactly as they replace any first reading (photo-reading-rules.ts), and the cold
// rule still judges it by when the receiver was switched on. The Capture-location pin never reads it:
// the pin stays its own fresh reading, because the photo-versus-pin check needs two readings, not one
// read twice (read-shutter-fix.ts, 2026-10-12).

/** One reading the warm-up was handed: its place, its accuracy, the phone's time for it, and when it arrived. */
export type WarmReading = {
  lat: number;
  lon: number;
  accuracyMeters: number | null;
  /** The phone's own time for the reading (`position.timestamp`). */
  takenAt: number;
  /** When this page received it, on the same clock as `receiverStarted`. */
  arrivedAt: number;
};

let latestWarm: WarmReading | null = null;

/** Keep the warm-up's newest reading. A position with no usable coordinates is ignored. */
export function noteWarmReading(position: GeolocationPosition, arrivedAt: number = Date.now()): void {
  const { latitude, longitude, accuracy } = position.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  latestWarm = {
    lat: latitude,
    lon: longitude,
    accuracyMeters: Number.isFinite(accuracy) ? accuracy : null,
    takenAt: Number.isFinite(position.timestamp) && position.timestamp > 0 ? position.timestamp : arrivedAt,
    arrivedAt,
  };
}

/** The warm-up's newest reading if it arrived within `maxAgeMs`, else null. Never waits. */
export function latestWarmReading(maxAgeMs: number, now: number = Date.now()): WarmReading | null {
  if (!latestWarm) return null;
  const age = now - latestWarm.arrivedAt;
  return age >= 0 && age <= maxAgeMs ? latestWarm : null;
}

// ── The shared warm-up: one watch for the page, however many screens hold it ─────────────────────

let holders = 0;
let warmWatch: number | null = null;
let warmToken: number | null = null;

async function locationAlreadyAllowed(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || !navigator.permissions?.query) return false;
    const status = await navigator.permissions.query({ name: "geolocation" });
    return status.state === "granted";
  } catch {
    // A browser that cannot answer is treated as not allowed: the camera and the pin will ask.
    return false;
  }
}

function stopWarmWatch() {
  if (warmWatch !== null && typeof navigator !== "undefined") navigator.geolocation?.clearWatch(warmWatch);
  warmWatch = null;
  receiverStopped(warmToken);
  warmToken = null;
  // A reading from a receiver that is no longer running vouches for nothing the next screen does.
  latestWarm = null;
}

async function startWarmWatch() {
  if (warmWatch !== null || typeof navigator === "undefined" || !navigator.geolocation) return;
  if (!(await locationAlreadyAllowed())) return;
  // Released, or started by another holder, while the permission was being asked.
  if (holders === 0 || warmWatch !== null) return;
  warmToken = receiverStarted();
  warmWatch = navigator.geolocation.watchPosition(
    (position) => {
      noteReading(position);
      noteWarmReading(position);
    },
    (error) => {
      // Switched off since the question was asked: stop quietly, and the camera will ask.
      if (error.code === error.PERMISSION_DENIED) stopWarmWatch();
    },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
  );
}

/** Hold the receiver on until the returned function is called. Never throws and never waits. */
export function holdLocationWarm(): () => void {
  holders += 1;
  void startWarmWatch();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) stopWarmWatch();
  };
}

/** Keep the phone's location receiver warm for as long as the calling screen is open. */
export function useLocationWarmUp(active: boolean = true): void {
  useEffect(() => (active ? holdLocationWarm() : undefined), [active]);
}
