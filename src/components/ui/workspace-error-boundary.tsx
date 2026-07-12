"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

import { reportClientError } from "@/lib/error-monitor/report-client-error";

type Props = {
  children: ReactNode;
  fallbackTitle?: string;
};

type State = {
  error: Error | null;
  hasError: boolean;
};

/**
 * React error boundary for workspace-level components.
 * Catches render/lifecycle errors gracefully and shows a recovery UI
 * instead of a white screen or full-page crash.
 */
export class WorkspaceErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, hasError: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error, hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[WorkspaceErrorBoundary]", error, errorInfo);
    // Forward the component stack so the System Issues dashboard can show which
    // component tree threw, not just a minified JS stack.
    reportClientError({ error, componentStack: errorInfo.componentStack });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 rounded-sm border border-rose-200 bg-rose-50/50 px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-sm bg-rose-100 text-rose-600">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-[15px] font-bold text-slate-900">
              {this.props.fallbackTitle ?? "Something went wrong"}
            </h3>
            <p className="mt-1 max-w-md text-[13px] font-medium text-slate-600">
              This workspace encountered an unexpected error. Your data is safe. Try refreshing the section.
            </p>
            {this.state.error?.message && (
              <p className="mt-2 text-[11px] font-mono text-rose-600/80">
                {this.state.error.message.slice(0, 120)}
              </p>
            )}
          </div>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-sm border border-slate-200 bg-white px-4 text-[13px] font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
            onClick={() => this.setState({ error: null, hasError: false })}
            type="button"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
