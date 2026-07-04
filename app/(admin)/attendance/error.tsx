"use client";

import { useEffect } from "react";
import { RouteErrorState } from "@/components/ui/route-error-state";
import { isStaleDeployChunkError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";

export default function AttendanceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    if (isStaleDeployChunkError(error)) {
      recoverFromStaleDeployOnce();
    }
  }, [error]);

  return (
    <RouteErrorState
      description="Attendance data, policy configuration, or device mapping could not render cleanly. Retry the view before running another sync."
      error={error}
      eyebrow="Attendance Error"
      reset={reset}
      title="Attendance workspace unavailable"
    />
  );
}
