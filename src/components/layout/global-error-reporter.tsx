"use client";

import { useEffect } from "react";

import {
  CROSS_ORIGIN_MASKED_DISPLAY,
  isCrossOriginMaskedErrorEvent,
} from "@/lib/error-monitor/cross-origin-masked";
import {
  createNetworkBurstCollector,
  isBareBrowserNetworkFailure,
  networkBurstContext,
} from "@/lib/error-monitor/network-failure-burst";
import { reportClientError } from "@/lib/error-monitor/report-client-error";
import { installScreenCapture } from "@/lib/error-monitor/screen-capture";
import { startSentryBrowser } from "@/lib/observability/sentry-client";
import { isStaleDeployChunkError, isTransientRouterMountError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";


const extensionUrlPattern = /extensions\/|^(chrome|moz)-extension:\/\//i;

function isIgnorable(message: string, source?: string | null): boolean {
  if (source && extensionUrlPattern.test(source)) return true;
  return false;
}

// A cross-origin error the browser emptied carries no information by construction, so a second
// one carries no more than the first. Reporting every occurrence turned one 20-minute session
// into 24 identical rows and buried the errors that could actually be acted on. Report the first
// — dropping it outright would hide a genuine change in how often this happens — and count the
// rest. Module-level, so it resets on a real page load and holds across App Router navigations,
// matching the sequence counter in report-client-error.ts.
let maskedCrossOriginCount = 0;

// The browser's own "the connection dropped" rejections, one row per BURST rather than one per rejection: a rep's
// phone losing its connection wrote up to 69 bare `Load failed` rows inside a second (network-failure-burst.ts).
// Module-level for the same reason as the counter above.
const networkBursts = createNetworkBurstCollector(
  ({ count, message }) => reportClientError({ context: networkBurstContext(count), error: message }),
  {
    clearTimeout: (handle) => window.clearTimeout(handle as number),
    now: () => Date.now(),
    setTimeout: (callback, ms) => window.setTimeout(callback, ms),
  },
);

// Route error.tsx boundaries only catch React render-phase errors within their own
// segment. A router-mount race or a chunk error thrown outside a component's render
// call stack surfaces here instead (window.onerror/unhandledrejection) — recover the
// same way (reload once, cooldown-guarded) so it isn't just reported and dropped.
function maybeRecover(source: unknown, fallbackMessage: string) {
  const errorLike = source instanceof Error ? source : new Error(fallbackMessage);
  if (isStaleDeployChunkError(errorLike) || isTransientRouterMountError(errorLike)) {
    recoverFromStaleDeployOnce();
  }
}

// Mounted once in the root layout. React's own error boundaries never see
// exceptions thrown in event handlers or unhandled promise rejections — this
// closes that gap by forwarding them to reportClientError itself.
export function GlobalErrorReporter() {
  useEffect(() => {
    function handleError(event: ErrorEvent) {
      const message = event.message || "Unknown window error";
      if (isIgnorable(message, event.filename)) return;
      if (isCrossOriginMaskedErrorEvent(event)) {
        maskedCrossOriginCount += 1;
        if (maskedCrossOriginCount > 1) return;
        // Pass the string, not an Error: an Error built here would carry THIS file's stack and
        // read as though the reporter itself threw.
        reportClientError({ error: CROSS_ORIGIN_MASKED_DISPLAY });
        return;
      }
      if (isBareBrowserNetworkFailure(event.error ?? message)) {
        networkBursts.add(message);
        return;
      }
      maybeRecover(event.error, message);
      reportClientError({ error: event.error ?? message });
    }

    function handleRejection(event: PromiseRejectionEvent) {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (isIgnorable(message)) return;
      if (isBareBrowserNetworkFailure(event.reason)) {
        networkBursts.add(message);
        return;
      }
      maybeRecover(event.reason, message);
      reportClientError({ error: event.reason });
    }

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);
    // A burst still open as the page goes away is reported now (the report is a keepalive request).
    window.addEventListener("pagehide", networkBursts.flush);
    startSentryBrowser();
    // The error screenshot (owner, 23 Oct 2026): a refused or failed /api/ request leaves a picture of
    // what the person saw for the System Audit. Installs once, never unwrapped on unmount — a second
    // mount finds it already there.
    installScreenCapture();

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
      window.removeEventListener("pagehide", networkBursts.flush);
    };
  }, []);

  return null;
}
