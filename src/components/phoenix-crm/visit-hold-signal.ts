"use client";

/**
 * Phoenix CRM — whether the screen open now can keep a visit on this phone, for the portal's header to read.
 *
 * Only the Visits screen knows, because only the server's day answer says so (`heldVisitsOwnerHrId`), and a manager's
 * save is not held. 🔴 THE SHELL IMPORTS THIS ON EVERY PAGE, so it imports React and nothing else: the sending code and
 * its rules stay out of the shell (`visit-outbox-runner.tsx`).
 */

import { useSyncExternalStore } from "react";

let screensThatHold = 0;
const listeners = new Set<() => void>();

function changed(): void {
  for (const listener of listeners) listener();
}

/** Says this screen can hold a visit, until the answer it returns is called. */
export function markVisitsCanBeHeld(): () => void {
  screensThatHold += 1;
  changed();
  return () => {
    screensThatHold -= 1;
    changed();
  };
}

export function visitsCanBeHeldNow(): boolean {
  return screensThatHold > 0;
}

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

export function useVisitsCanBeHeld(): boolean {
  return useSyncExternalStore(subscribe, visitsCanBeHeldNow, () => false);
}
