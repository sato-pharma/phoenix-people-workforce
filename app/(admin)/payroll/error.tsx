"use client";

import { useEffect } from "react";
import { RouteErrorState } from "@/components/ui/route-error-state";
import { isStaleDeployChunkError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";

export default function PayrollError({
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
      description="Payroll intelligence could not render the selected batch or dashboard state. Retry before uploading or replacing payroll files."
      error={error}
      eyebrow="Payroll Error"
      reset={reset}
      title="Payroll workspace unavailable"
    />
  );
}
