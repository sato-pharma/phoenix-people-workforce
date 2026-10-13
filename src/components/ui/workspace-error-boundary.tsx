"use client";

import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

import { reportClientError } from "@/lib/error-monitor/report-client-error";
import {
  isStaleDeployChunkError,
  isTransientRouterMountError,
  recoverFromStaleDeployOnce,
} from "@/lib/utils/stale-deploy-recovery";

type Props = {
  children: ReactNode;
  fallbackTitle?: string;
};

type State = {
  error: Error | null;
  hasError: boolean;
  staleDeploy: boolean;
};

/**
 * React error boundary for workspace-level components.
 * Catches render/lifecycle errors gracefully and shows a recovery UI
 * instead of a white screen or full-page crash.
 *
 * 🔴 It is also the boundary EmployeePortalPageShell wraps every portal page in, so it — not a
 * route `error.tsx` — is what catches a `next/dynamic` chunk failure anywhere in the portal,
 * Phoenix CRM included. Until 2026-10-13 it reported such an error and recovered from nothing: the
 * deploy had deleted the chunk URL the open tab was asking for, and "Try Again" only cleared
 * `hasError`, which re-rendered the same `Lazy` and re-requested the same dead file. Production
 * recorded exactly that — three failures 10 seconds apart on /employee-portals/weekly-sales with
 * `sinceNavMs` still climbing (so no reload ever happened, 2026-09-21), and the same shape on
 * /employee-portals/field-crm/visits on a rep's handset (2026-10-13). A chunk error that reaches
 * window.onerror instead was recovering the whole time, which is why the portal rows looked like
 * an unlucky minority rather than the one path with no recovery in it.
 */
export class WorkspaceErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null, hasError: false, staleDeploy: false };
  }

  static getDerivedStateFromError(error: Error): State {
    return {
      error,
      hasError: true,
      staleDeploy: isStaleDeployChunkError(error) || isTransientRouterMountError(error),
    };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("[WorkspaceErrorBoundary]", error, errorInfo);
    // Forward the component stack so the System Issues dashboard can show which
    // component tree threw, not just a minified JS stack.
    reportClientError({ error, componentStack: errorInfo.componentStack });
    // A stale-deploy chunk or a transient router-mount error clears itself on a reload, and on
    // nothing else. Cooldown-guarded inside, so a persistent error cannot loop the page.
    if (isStaleDeployChunkError(error) || isTransientRouterMountError(error)) {
      recoverFromStaleDeployOnce();
    }
  }

  render() {
    if (this.state.staleDeploy) {
      // The reload above is already on its way (or was blocked by the 10s guard, which means one
      // just happened and did not clear it). Either way the only control that can help is a real
      // reload — never a state reset, which asks for the same missing file again.
      return (
        <div className="flex flex-col items-center justify-center gap-4 rounded-sm border border-slate-200 bg-slate-50 px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-sm bg-slate-200 text-slate-600">
            <RefreshCcw className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-phx-lg font-bold text-slate-900">Phoenix was just updated</h3>
            <p className="mt-1 max-w-md text-phx-md font-medium text-slate-600">
              This page was open while a new version went live. Reloading brings it up to date — nothing you
              have already saved is affected.
            </p>
          </div>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-sm border border-slate-200 bg-white px-4 text-phx-md font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
            onClick={() => {
              if (typeof window !== "undefined") window.location.reload();
            }}
            type="button"
          >
            <RefreshCcw className="h-3.5 w-3.5" />
            Reload
          </button>
        </div>
      );
    }

    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-4 rounded-sm border border-rose-200 bg-rose-50/50 px-6 py-12 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-sm bg-rose-100 text-rose-600">
            <AlertTriangle className="h-5 w-5" />
          </div>
          <div>
            <h3 className="text-phx-lg font-bold text-slate-900">
              {this.props.fallbackTitle ?? "Something went wrong"}
            </h3>
            <p className="mt-1 max-w-md text-phx-md font-medium text-slate-600">
              This workspace encountered an unexpected error. Your data is safe. Try refreshing the section.
            </p>
            {this.state.error?.message && (
              <p className="mt-2 text-phx-xs font-mono text-rose-600/80">
                {this.state.error.message.slice(0, 120)}
              </p>
            )}
          </div>
          <button
            className="inline-flex h-9 items-center gap-2 rounded-sm border border-slate-200 bg-white px-4 text-phx-md font-bold text-slate-700 shadow-sm transition hover:bg-slate-50"
            onClick={() => this.setState({ error: null, hasError: false, staleDeploy: false })}
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
