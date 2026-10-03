"use client";

import { useCallback, useSyncExternalStore } from "react";

import { browserNameFromUserAgent, nameBrowserIn } from "@/lib/phoenix-crm/browser-name";

/** Read once per tab and remembered: a user agent cannot change under a loaded page. */
let readName: string | null | undefined;

function onThePhone(): string | null {
  if (readName === undefined) {
    readName = browserNameFromUserAgent(typeof navigator === "undefined" ? null : navigator.userAgent);
  }
  return readName;
}

/** On the server, and through hydration, there is no user agent to read — the placeholder stands. */
function onTheServer(): string | null {
  return null;
}

/** The name never changes while the page is open, so nothing ever has to be told about it. */
function subscribe(): () => void {
  return () => {};
}

/**
 * Names the rep's browser in any message carrying `BROWSER_PLACEHOLDER` (browser-name.ts).
 *
 * `useSyncExternalStore` is the primitive for this rather than state set from an effect: it takes a
 * SERVER snapshot used for the server's render and through hydration, and only then switches to what
 * the phone reports. Seeding state during render would make the two disagree ("your browser" against
 * "Chrome") and React would discard the subtree to settle it; setting it from an effect is a
 * cascading render, which this repo's lint refuses outright. Either way the rep loses nothing while
 * he waits — the placeholder is a finished sentence, never a blank or a token.
 */
export function useBrowserNamed(): (text: string) => string {
  const browser = useSyncExternalStore(subscribe, onThePhone, onTheServer);
  return useCallback((text: string) => nameBrowserIn(text, browser), [browser]);
}
