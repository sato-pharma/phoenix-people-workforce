"use client";

import { RouteErrorState } from "@/components/ui/route-error-state";

// Group-level error boundary for the whole admin surface. Because the (admin)
// layout renders AppShell, this boundary renders INSIDE the shell — so when an
// admin page throws, the sidebar/topbar stay mounted and the user can still
// navigate, instead of falling through to the root app/error.tsx which replaces
// the entire chrome with a standalone page. Pages with their own error.tsx
// (e.g. a route-specific error.tsx) still take precedence over this baseline.
export default function AdminGroupError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <RouteErrorState
      description="This admin view stopped unexpectedly. Your navigation stays intact — retry to reload just this page, or use the sidebar to move elsewhere."
      error={error}
      eyebrow="Admin"
      reset={reset}
      title="This page stopped unexpectedly"
    />
  );
}
