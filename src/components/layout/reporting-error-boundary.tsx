"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportClientError } from "@/lib/error-monitor/report-client-error";
import { isStaleDeployChunkError, isTransientRouterMountError, recoverFromStaleDeployOnce } from "@/lib/utils/stale-deploy-recovery";

type Props = { children: ReactNode };
type State = { hasError: boolean };

/**
 * Root-level class error boundary mounted in app/layout.tsx, above the App Router's
 * per-segment error.tsx boundaries. It exists for one reason those function-component
 * boundaries can't serve: `componentDidCatch(error, errorInfo)` exposes
 * `errorInfo.componentStack`, which we forward to the System Issues dashboard so an
 * admin sees which component tree threw instead of a minified JS stack.
 *
 * Scope note: it only catches render-phase throws that bubble to the root (i.e. not
 * caught by a lower segment error.tsx), and NOT recoverable hydration errors (#418 etc.,
 * which React reports via onRecoverableError, not error boundaries) nor async/event
 * handler errors (those hit window.onerror in GlobalErrorReporter, without a component
 * stack). It renders a minimal fallback so the app never hard-crashes to blank.
 */
export class ReportingErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    reportClientError({ error, componentStack: errorInfo.componentStack });
    // A stale-deploy chunk or transient router-mount error clears itself on reload.
    if (isStaleDeployChunkError(error) || isTransientRouterMountError(error)) {
      recoverFromStaleDeployOnce();
    }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 p-8 text-center">
          <h1 className="text-lg font-bold text-slate-900">Something went wrong</h1>
          <p className="max-w-md text-sm text-slate-600">
            An unexpected error occurred. Reloading the page usually resolves it.
          </p>
          <button
            className="mt-2 inline-flex h-9 items-center rounded-md border border-slate-200 bg-white px-4 text-sm font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
            type="button"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
