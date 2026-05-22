"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function PayslipsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="The payslips workspace could not render the latest compensation data. Retry keeps the current employee portal session active."
      error={error}
      eyebrow="Payslips Error"
      reset={reset}
      title="Payslips unavailable"
    />
  );
}
