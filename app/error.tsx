"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="min-h-screen bg-bg-soft p-4 sm:p-6 lg:p-8">
      <RouteErrorState
        description="Phoenix Workforce could not finish loading this workspace view. Retry the render before refreshing or changing routes."
        error={error}
        eyebrow="Application Error"
        reset={reset}
        title="This workspace view stopped unexpectedly"
      />
    </main>
  );
}
