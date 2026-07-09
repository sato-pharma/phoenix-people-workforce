"use client";

import { useEffect } from "react";

import { reportClientError } from "@/lib/error-monitor/report-client-error";


const extensionUrlPattern = /extensions\/|^(chrome|moz)-extension:\/\//i;

function isIgnorable(message: string, source?: string | null): boolean {
  if (source && extensionUrlPattern.test(source)) return true;
  return false;
}

// Mounted once in the root layout. React's own error boundaries never see
// exceptions thrown in event handlers or unhandled promise rejections — this
// closes that gap by mirroring what Sentry's browser SDK does under the hood.
export function GlobalErrorReporter() {
  useEffect(() => {
    function handleError(event: ErrorEvent) {
      const message = event.message || "Unknown window error";
      if (isIgnorable(message, event.filename)) return;
      reportClientError({ error: event.error ?? message });
    }

    function handleRejection(event: PromiseRejectionEvent) {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (isIgnorable(message)) return;
      reportClientError({ error: event.reason });
    }

    window.addEventListener("error", handleError);
    window.addEventListener("unhandledrejection", handleRejection);

    return () => {
      window.removeEventListener("error", handleError);
      window.removeEventListener("unhandledrejection", handleRejection);
    };
  }, []);

  return null;
}
