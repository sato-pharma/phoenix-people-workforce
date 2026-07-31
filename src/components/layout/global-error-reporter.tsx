"use client";

import { useEffect } from "react";

import { reportClientError } from "@/lib/error-monitor/report-client-error";
import { isStaleDeployChunkError, isTransientRouterMountError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";


const extensionUrlPattern = /extensions\/|^(chrome|moz)-extension:\/\//i;

function isIgnorable(message: string, source?: string | null): boolean {
  if (source && extensionUrlPattern.test(source)) return true;
  return false;
}

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
      maybeRecover(event.error, message);
      reportClientError({ error: event.error ?? message });
    }

    function handleRejection(event: PromiseRejectionEvent) {
      const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
      if (isIgnorable(message)) return;
      maybeRecover(event.reason, message);
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
