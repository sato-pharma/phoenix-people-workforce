// Mailbox compliance monitor — the ONE catch block for all four routes.
//
// Every mailbox-monitor route handler caught its own failure and returned a client-safe JSON body,
// which meant the real cause went nowhere: not to app_error_events, and not to instrumentation.ts's
// onRequestError either, because that only fires on errors a handler lets ESCAPE. So a mailbox that
// stopped answering produced a 502 in the browser and no trace anywhere on the server — the same
// hole /api/admin/outstation/expenses had, diagnosed there on 2026-08-12 and fixed one route at a
// time. Six identical catch blocks is how that happens: the net has to sit under all of them.
//
// This module also decides WHAT is worth recording. A refused enrolment (a typo'd address, a
// mailbox already monitored) is a user telling us something, not a fault — route those to the error
// monitor and the real failures drown. MailboxMonitorError carries a `diagnostic` flag set where
// the cause is actually known; anything unrecognised is always recorded, because an error nobody
// classified is exactly the one nobody is watching for.

import { NextResponse } from "next/server";

import { isForbiddenError, type resolveAccessContext } from "@/lib/auth/server";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { logAppError } from "@/lib/error-monitor/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { MailboxMonitorError } from "@/lib/mailbox-monitor/service";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

const MODULE_KEY = "mailbox_monitor";
const MODULE_LABEL = "Mailbox Monitor";

/** Resolved actor, or null when the failure happened before (or during) resolving it. */
export type MailboxMonitorRouteAccess = Awaited<ReturnType<typeof resolveAccessContext>> | null;

/**
 * Translate any thrown value into the response the route should return, recording the ones worth
 * investigating on the way out.
 *
 * `route` is a LITERAL path template ("/api/admin/mailbox-monitor/[id]/messages"), never
 * request.nextUrl.pathname. The error monitor groups by moduleKey + route (signatureKey in
 * src/lib/error-monitor/derived-status.ts), so a concrete id in the path would give every monitor
 * its own signature and no failure would ever look recurrent.
 *
 * routeType is fixed rather than passed: it means "what kind of thing threw" everywhere else in
 * this codebase (instrumentation.ts sets it from Next's own context), and it is not part of the
 * grouping key, so letting each call site invent a value would only make the column mean less.
 */
export async function mailboxMonitorErrorResponse(input: {
  access: MailboxMonitorRouteAccess;
  error: unknown;
  fallbackMessage: string;
  request: Request;
  route: string;
}): Promise<NextResponse> {
  const { access, error, fallbackMessage, request, route } = input;

  // Expected outcomes, in the order they can occur. None is a fault, so none is recorded.
  if (isApiRateLimitError(error)) {
    return NextResponse.json(
      { message: "Too many attempts — slow down.", retryAfterSeconds: error.retryAfterSeconds },
      { status: 429 },
    );
  }
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message }, { status: 403 });
  }
  if (error instanceof MailboxMonitorError && !error.diagnostic) {
    return NextResponse.json({ message: error.message }, { status: error.statusCode });
  }

  // Everything below is worth a row. The status still comes from the error when it named one, so
  // recording a failure never changes what the caller is told.
  const status = error instanceof MailboxMonitorError ? error.statusCode : 500;
  await logAppError({
    hrId: access?.hrId ?? null,
    loginId: access?.loginId ?? null,
    // describeThrown, not String(error): supabase hands back a plain
    // { message, code, details, hint } that this codebase rethrows as-is, and String() on it
    // records "[object Object]" — a row that proves a failure happened and nothing else.
    message: describeThrown(error),
    moduleKey: MODULE_KEY,
    moduleLabel: MODULE_LABEL,
    role: access?.role ?? null,
    route,
    routeType: "route-handler",
    source: "server",
    stack: error instanceof Error ? error.stack ?? null : null,
    userAgent: request.headers.get("user-agent"),
  }).catch(() => {
    // Never let the logger turn a failed request into a crash. logAppError already swallows its
    // own errors; this guards the call itself so the response below always goes out.
  });

  return NextResponse.json(
    {
      message:
        error instanceof MailboxMonitorError
          ? error.message
          : clientSafeErrorMessage(error, fallbackMessage),
    },
    { status },
  );
}
