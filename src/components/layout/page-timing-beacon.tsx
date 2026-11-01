"use client";

import { useEffect } from "react";

import { PAGE_TIMING_SOFT_BATCH_LIMIT, deviceClassOf, type PageTimingDevice } from "@/lib/observability/page-timing-intake";

// Reports how long this page took, once, when the tab is hidden or closed — and, since 1 Nov 2026, how
// long each TAP inside the app took to reach its page. It sends page paths (no query, no hash),
// milliseconds and a device class; the server reduces each path to a page shape and keeps no identity
// (src/lib/observability/page-timing-intake.ts), sums the hour in memory and writes it to page_timings.
//
// THE HARD LOAD: the browser's own navigation and paint entries — the first byte, the first content, the
// largest content (not every browser offers it), the document interactive, and the first /api/ answer
// (the earliest moment the page had data). Fired once per document; an App Router soft navigation
// starts no new document.
//
// THE TAPS: RouteTransitionProvider knows the tap and the arrival and calls reportSoftNavigation; the
// taps are queued and sent in one beacon of up to PAGE_TIMING_SOFT_BATCH_LIMIT, or when the tab hides —
// a tap never costs a request of its own.

export const PAGE_TIMING_ENDPOINT = "/api/telemetry/page-timing";

type SoftNavigation = { ms: number; path: string };
const softQueue: SoftNavigation[] = [];

function canBeacon(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function";
}

function deviceClass(): PageTimingDevice {
  return deviceClassOf(navigator as unknown as { deviceMemory?: unknown; hardwareConcurrency?: unknown });
}

function send(body: Record<string, unknown>): void {
  try {
    navigator.sendBeacon(PAGE_TIMING_ENDPOINT, new Blob([JSON.stringify(body)], { type: "application/json" }));
  } catch {
    // Telemetry must never disturb the page.
  }
}

/** Send the queued taps now, in one beacon. */
export function flushSoftNavigations(): void {
  if (softQueue.length === 0 || !canBeacon()) return;
  const soft = softQueue.splice(0, softQueue.length);
  send({ device: deviceClass(), soft });
}

/** A tap inside the app reached `path` after `ms`. Queued; sent at the batch limit or when the tab hides. */
export function reportSoftNavigation(path: string, ms: number): void {
  if (typeof path !== "string" || path.length === 0 || !Number.isFinite(ms) || ms < 0) return;
  softQueue.push({ ms: Math.round(ms), path });
  if (softQueue.length >= PAGE_TIMING_SOFT_BATCH_LIMIT) flushSoftNavigations();
}

/** The first /api/ answer of this document, from the browser's own resource entries. */
function firstApiResponseEnd(): number | null {
  let first: number | null = null;
  for (const entry of performance.getEntriesByType("resource") as PerformanceResourceTiming[]) {
    if (!entry.name.includes("/api/") || !(entry.responseEnd > 0)) continue;
    if (first === null || entry.responseEnd < first) first = entry.responseEnd;
  }
  return first;
}

export function PageTimingBeacon() {
  useEffect(() => {
    if (typeof PerformanceObserver === "undefined" || !canBeacon()) return;

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
        // This browser does not offer that entry type; the other numbers may still arrive.
      }
    };
    watch("paint", (entry) => {
      if (entry.name === "first-contentful-paint") firstContent = entry.startTime;
    });
    watch("largest-contentful-paint", (entry) => {
      largestContent = entry.startTime;
    });

    const sendHardLoad = () => {
      if (sent) return;
      const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      const firstByte = navigation && navigation.responseStart > 0 ? navigation.responseStart : null;
      const interactive = navigation && navigation.domInteractive > 0 ? navigation.domInteractive : null;
      if (firstContent === null && largestContent === null && firstByte === null) return;
      sent = true;
      send({
        device: deviceClass(),
        hard: {
          fcp: firstContent,
          firstData: firstApiResponseEnd(),
          interactive,
          lcp: largestContent,
          path: window.location.pathname,
          ttfb: firstByte,
        },
      });
    };
    const onVisibility = () => {
      if (document.visibilityState !== "hidden") return;
      sendHardLoad();
      flushSoftNavigations();
    };
    const onPageHide = () => {
      sendHardLoad();
      flushSoftNavigations();
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", onPageHide);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onPageHide);
      observers.forEach((observer) => observer.disconnect());
    };
  }, []);

  return null;
}
