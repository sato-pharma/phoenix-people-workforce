"use client";

import { useEffect } from "react";

// Reports how long this page took to paint its first content and its largest content, once, when the tab
// is hidden or closed. It sends two numbers and the page's own path (no query, no hash) — the server
// reduces the path to a page shape and keeps no identity (src/lib/observability/page-timing-intake.ts).
//
// HARD LOADS ONLY: the browser fires these paint entries once per document, and an App Router soft
// navigation does not start a new document, so a client-side link click is not measured here. That is
// deliberate — the first load is what a rep waits on after signing in or opening a bookmark.
export function PageTimingBeacon() {
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined" || typeof navigator.sendBeacon !== "function") return;

    let firstContent: number | null = null;
    let largestContent: number | null = null;
    let sent = false;

    const observers: PerformanceObserver[] = [];
    const watch = (type: string, onEntry: (entry: PerformanceEntry) => void) => {
      try {
        const observer = new PerformanceObserver((list) => list.getEntries().forEach(onEntry));
        observer.observe({ type, buffered: true });
        observers.push(observer);
      } catch {
        // This browser does not offer that entry type; the other number may still arrive.
      }
    };
    watch("paint", (entry) => {
      if (entry.name === "first-contentful-paint") firstContent = entry.startTime;
    });
    watch("largest-contentful-paint", (entry) => {
      largestContent = entry.startTime;
    });

    const send = () => {
      if (sent || (firstContent === null && largestContent === null)) return;
      sent = true;
      try {
        navigator.sendBeacon(
          "/api/telemetry/page-timing",
          new Blob([JSON.stringify({ path: window.location.pathname, fcp: firstContent, lcp: largestContent })], {
            type: "application/json",
          }),
        );
      } catch {
        // Telemetry must never disturb the page.
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") send();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", send);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", send);
      observers.forEach((observer) => observer.disconnect());
    };
  }, []);

  return null;
}
