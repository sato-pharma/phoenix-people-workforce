"use client";

import { useEffect } from "react";
import { isStaleDeployChunkError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";
import { reportClientError } from "@/lib/error-monitor/report-client-error";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isStaleDeployChunkError(error)) {
      recoverFromStaleDeployOnce();
      return;
    }

    console.error(error);
    reportClientError({ digest: error.digest ?? null, error });
  }, [error]);

  return (
    <html lang="en">
      <body>
        <div style={{ padding: "2rem", fontFamily: "sans-serif", textAlign: "center" }}>
          <h2>Something went wrong</h2>
          <p style={{ color: "#666", marginTop: "0.5rem" }}>
            An unexpected error occurred. The team has been notified.
          </p>
          <button
            onClick={reset}
            style={{
              marginTop: "1rem",
              padding: "0.5rem 1.5rem",
              borderRadius: "0.375rem",
              border: "1px solid #ccc",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
