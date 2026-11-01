"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const ENDPOINT = "/api/activity/track";
// Ignore pass-through navigations shorter than this (redirect chains, mis-taps).
const MIN_DWELL_MS = 1000;
/** How long a page view waits in the queue before the batch is sent. */
export const ACTIVITY_FLUSH_INTERVAL_MS = 30_000;
/** The route accepts this many events in one request (MAX_EVENTS_PER_REQUEST); a full queue is sent at once. */
export const ACTIVITY_BATCH_LIMIT = 25;

type QueuedPageView = { path: string; enteredAt: string | null; durationMs: number };

/**
 * ONE REQUEST PER TAB EVERY 30 SECONDS, NOT ONE PER PAGE (1 Nov 2026). Every navigation sent its own
 * POST the moment the page was left — a request, and a session read behind it, per page view for
 * every role, on the saturated host where each costs about 450 ms. Page views now wait in this
 * module-level queue and go together: when the queue fills (the route's own batch limit), when the
 * tab is hidden or unloaded (keepalive, so the batch survives the close), and otherwise every
 * ACTIVITY_FLUSH_INTERVAL_MS. Each entry carries its own `enteredAt`, so the server records the true
 * time however long it waited; the route already accepts `{events: [...]}`.
 */
const queue: QueuedPageView[] = [];
let flushTimer: number | null = null;

function sendBatch(events: QueuedPageView[]) {
  if (events.length === 0) return;
  try {
    // fetch(keepalive) sets the Origin header (so it passes CSRF) and survives
    // unload, unlike a bare fetch. Errors are swallowed — tracking must be silent.
    void fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events }),
      keepalive: true,
      credentials: "same-origin",
    }).catch(() => {});
  } catch {
    // Never let tracking surface an error to the user.
  }
}

function flushActivityQueue() {
  if (flushTimer !== null) {
    window.clearTimeout(flushTimer);
    flushTimer = null;
  }
  while (queue.length > 0) sendBatch(queue.splice(0, ACTIVITY_BATCH_LIMIT));
}

function queueActivityBeacon(path: string, enteredAtIso: string | null, durationMs: number) {
  if (!path || durationMs < MIN_DWELL_MS) return;
  queue.push({ path, enteredAt: enteredAtIso, durationMs: Math.round(durationMs) });
  if (queue.length >= ACTIVITY_BATCH_LIMIT) {
    flushActivityQueue();
    return;
  }
  if (flushTimer === null) {
    flushTimer = window.setTimeout(() => {
      flushTimer = null;
      flushActivityQueue();
    }, ACTIVITY_FLUSH_INTERVAL_MS);
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
        queueActivityBeacon(pathRef.current, enteredIsoRef.current, Date.now() - startRef.current);
        startRef.current = null;
      }
    };
  }, [pathname]);

  // Catch tab-close / backgrounding, which don't trigger a route change. Timing
  // pauses while hidden and resumes when the user returns to the same page. Both
  // send whatever is queued at once: a hidden tab may never get its 30-second tick.
  useEffect(() => {
    function flush() {
      if (pathRef.current && startRef.current != null) {
        queueActivityBeacon(pathRef.current, enteredIsoRef.current, Date.now() - startRef.current);
        startRef.current = null;
      }
      flushActivityQueue();
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
