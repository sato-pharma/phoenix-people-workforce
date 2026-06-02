"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function PayrollError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="Payroll intelligence could not render the selected batch or dashboard state. Retry before uploading or replacing payroll files."
      error={error}
      eyebrow="Payroll Error"
      reset={reset}
      title="Payroll workspace unavailable"
    />
  );
}
