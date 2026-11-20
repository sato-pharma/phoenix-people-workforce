"use client";

import { useEffect } from "react";

/**
 * React Grab, in development only (owner, 2026-11-20: "All six tools", for the portal redesign).
 *
 * Hover any element of the running app and press Ctrl+C: the clipboard then holds that element and
 * the component stack behind it, with file and line, ready to paste into a session — so "this card
 * here" becomes a precise source location instead of a description.
 *
 * WHY A PACKAGE AND NOT THE CDN TAG ITS README SHOWS. The app's Content-Security-Policy
 * (`next.config.ts`, `script-src`) admits no CDN it does not already name, so the unpkg tag would be
 * blocked in silence. The package is a pinned devDependency served from the app's own origin, so the
 * policy is left exactly as it is.
 *
 * WHY IT CANNOT REACH PRODUCTION. The root layout mounts this only when `NODE_ENV` is
 * "development", and the import below sits behind the same test, so a production build never loads
 * it. It renders nothing.
 */
export function DevReactGrab() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "development") return;
    void import("react-grab");
  }, []);
  return null;
}
