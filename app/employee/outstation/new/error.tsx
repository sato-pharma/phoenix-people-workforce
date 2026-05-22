"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function EmployeeOutstationNewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="The outstation expense form could not load your trip context. Retry keeps the current employee portal session active."
      error={error}
      eyebrow="Expense Error"
      reset={reset}
      title="Submit expense unavailable"
    />
  );
}
