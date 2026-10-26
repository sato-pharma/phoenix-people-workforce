"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Button } from "@/components/ui/button";
import {
  isSessionVerificationUnavailableDigest,
  nextSessionCheckRetryDelay,
  type SessionCheckRetryRun,
} from "@/lib/auth/session-unavailable-digest";
import { reportClientError } from "@/lib/error-monitor/report-client-error";

type RouteErrorStateProps = {
  description: string;
  error?: Error & { digest?: string };
  eyebrow: string;
  reset: () => void;
  /**
   * "portal" draws the employee portal's own navy header frame and prints no error digest (an
   * employee cannot act on one; it is still reported below). Left unset it follows the route: a
   * portal path gets the portal look, everything else — every admin error boundary — keeps the
   * original card unchanged.
   */
  surface?: "admin" | "portal";
  title: string;
};

// A failed retry mounts a fresh card (the boundary unmounts it on every reset), so the run lives here.
let sessionCheckRun: SessionCheckRetryRun | null = null;

function isPortalPath(pathname: string) {
  return (
    pathname === "/employee-portals" ||
    pathname.startsWith("/employee-portals/") ||
    pathname === "/payslips" ||
    pathname.startsWith("/payslips/") ||
    pathname.startsWith("/employee/")
  );
}

export function RouteErrorState({
  description: routeDescription,
  error,
  eyebrow: routeEyebrow,
  reset,
  surface,
  title: routeTitle,
}: RouteErrorStateProps) {
  const pathname = usePathname();
  const router = useRouter();
  // The database could not confirm the sign-in (a restart or an outage). Not a crash: the session
  // is kept, the server already recorded the cause, and the page comes back by itself once the
  // database answers — so it is neither reported again nor drawn as an error.
  const sessionCheckUnavailable = isSessionVerificationUnavailableDigest(error);

  useEffect(() => {
    if (error && !sessionCheckUnavailable) {
      reportClientError({ digest: error.digest ?? null, error, route: pathname });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  useEffect(() => {
    if (!sessionCheckUnavailable) return;
    const next = nextSessionCheckRetryDelay(sessionCheckRun, Date.now());
    sessionCheckRun = next.run;
    if (next.delayMs === null) return;
    const timer = window.setTimeout(() => {
      router.refresh();
      reset();
    }, next.delayMs);
    return () => window.clearTimeout(timer);
  }, [error, reset, router, sessionCheckUnavailable]);

  const eyebrow = sessionCheckUnavailable ? "Reconnecting" : routeEyebrow;
  const title = sessionCheckUnavailable ? "We could not confirm your sign-in just now" : routeTitle;
  const description = sessionCheckUnavailable
    ? "Phoenix could not reach its database for a moment. You are still signed in and nothing you saved is affected. This page will try again by itself in a few seconds."
    : routeDescription;

  const portal = surface ? surface === "portal" : isPortalPath(pathname ?? "");

  if (portal) {
    // The same frame as EmployeePortalPageShell's command header, so an error reads as the page's
    // own header saying what went wrong, not a rose card from another design.
    return (
      <section
        className="rounded-sm border border-slate-800 bg-[#08111f] px-4 py-5 text-white shadow-[0_24px_70px_rgba(8,17,31,0.20)] sm:px-5 lg:px-6"
        role="alert"
      >
        <span className="inline-flex items-center gap-2 rounded-sm border border-orange-400/35 bg-orange-500/12 px-2.5 py-1 text-phx-2xs font-black uppercase tracking-[0.18em] text-orange-200">
          <AlertTriangle aria-hidden className="h-3.5 w-3.5 shrink-0" />
          {eyebrow}
        </span>
        <h2 className="mt-3 break-words text-2xl font-black leading-tight tracking-tight text-white">{title}</h2>
        <p className="mt-2 max-w-3xl break-words text-sm font-semibold leading-6 text-slate-300">{description}</p>
        <Button className="mt-4 min-h-10 gap-2 rounded-none md:min-h-9" type="button" onClick={reset}>
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
      </section>
    );
  }

  return (
    <div className="flex min-h-[420px] items-center justify-center rounded-[26px] border border-rose-200 bg-[linear-gradient(180deg,#fff7f7_0%,#ffffff_100%)] p-6 text-center shadow-[0_18px_46px_rgba(15,23,42,0.08)]">
      <div className="max-w-xl space-y-5">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl border border-rose-100 bg-rose-50 text-rose-600 shadow-[0_12px_28px_rgba(244,63,94,0.14)]">
          <AlertTriangle className="h-7 w-7" />
        </div>
        <div className="space-y-2">
          <p className="text-phx-2xs font-black uppercase tracking-[0.22em] text-rose-600">{eyebrow}</p>
          <h2 className="text-2xl font-black tracking-tight text-slate-950">{title}</h2>
          <p className="text-sm leading-6 text-slate-600">{description}</p>
          {error?.digest && !sessionCheckUnavailable ? (
            <p className="font-mono text-xs font-semibold text-slate-400">Error digest: {error.digest}</p>
          ) : null}
        </div>
        <Button className="gap-2" type="button" onClick={reset}>
          <RotateCcw className="h-4 w-4" />
          Try again
        </Button>
      </div>
    </div>
  );
}
