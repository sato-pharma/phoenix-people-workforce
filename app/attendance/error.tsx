"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function AttendanceError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
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
