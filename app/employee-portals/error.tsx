"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function EmployeePortalsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="The employee portal could not render the latest self-service data. Retry keeps the current portal session active."
      error={error}
      eyebrow="Portal Error"
      reset={reset}
      title="Employee portal unavailable"
    />
  );
}
