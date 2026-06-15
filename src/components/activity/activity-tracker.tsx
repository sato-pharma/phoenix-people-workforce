"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const ENDPOINT = "/api/activity/track";
// Ignore pass-through navigations shorter than this (redirect chains, mis-taps).
const MIN_DWELL_MS = 1000;

function sendActivityBeacon(path: string, enteredAtIso: string | null, durationMs: number) {
  if (!path || durationMs < MIN_DWELL_MS) return;
  const payload = JSON.stringify({ path, enteredAt: enteredAtIso, durationMs: Math.round(durationMs) });
  try {
    // fetch(keepalive) sets the Origin header (so it passes CSRF) and survives
    // unload, unlike a bare fetch. Errors are swallowed — tracking must be silent.
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Never let tracking surface an error to the user.
  }
}

/**
 * Records lightweight page-view + dwell-time events for the Activity Control
 * Center. Mounted once inside RouteTransitionProvider, so it runs only inside the
 * authenticated admin shell and employee portal — never on the login screen.
 *
 * It sends only the path + how long the page was foregrounded. The server derives
 * who/which session from the session cookie. No keystrokes, form values, or page
 * contents are ever captured. Timing pauses while the tab is hidden so background
 * tabs don't count as "active" work.
 */
export function ActivityTracker() {
  const pathname = usePathname();
  const pathRef = useRef<string | null>(null);
  const startRef = useRef<number | null>(null);
  const enteredIsoRef = useRef<string | null>(null);

  // One effect per page: start timing on entry, flush the dwell on exit (route
  // change or unmount). The cleanup runs before the next pathname effect.
  useEffect(() => {
    pathRef.current = pathname;
    startRef.current = Date.now();
    enteredIsoRef.current = new Date().toISOString();
    return () => {
      if (pathRef.current && startRef.current != null) {
        sendActivityBeacon(pathRef.current, enteredIsoRef.current, Date.now() - startRef.current);
        startRef.current = null;
      }
    };
  }, [pathname]);

  // Catch tab-close / backgrounding, which don't trigger a route change. Timing
  // pauses while hidden and resumes when the user returns to the same page.
  useEffect(() => {
    function flush() {
      if (pathRef.current && startRef.current != null) {
        sendActivityBeacon(pathRef.current, enteredIsoRef.current, Date.now() - startRef.current);
        startRef.current = null;
      }
    }
    function onVisibility() {
      if (document.visibilityState === "hidden") {
        flush();
      } else if (startRef.current == null && pathRef.current) {
        startRef.current = Date.now();
        enteredIsoRef.current = new Date().toISOString();
      }
    }
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, []);

  return null;
}
