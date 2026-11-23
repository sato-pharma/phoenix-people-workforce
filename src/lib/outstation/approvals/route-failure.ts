/**
 * How every Expense Approvals route answers a failure — one tail, so the four routes cannot drift.
 *
 * Rebuilt 2026-11-23 (owner: "REBUILD FROM SCRATCH"). A refusal is a 403 in the guard's own words.
 * Anything else is a 500 whose client message is sanitised and whose REAL cause is written to the
 * app's error table with the person it happened to — the route this replaces once answered 500 for
 * a day with nothing anywhere able to say why (2026-08-12).
 *
 * The permission checks are NOT here: each route calls them itself, first, where a reader of the
 * route can see them.
 */

import { NextResponse } from "next/server";

import type { AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { logAppError } from "@/lib/error-monitor/service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export async function deskRouteFailure(input: {
  access: Pick<AccessContext, "hrId" | "loginId" | "role"> | null;
  code: string;
  error: unknown;
  fallback: string;
  route: string;
}): Promise<NextResponse> {
  const message = clientSafeErrorMessage(input.error, input.fallback);
  if (isForbiddenError(input.error)) {
    return NextResponse.json({ error: "forbidden", message }, { status: 403 });
  }
  await logAppError({
    source: "server",
    route: input.route,
    routeType: "route-handler",
    hrId: input.access?.hrId ?? null,
    loginId: input.access?.loginId ?? null,
    role: input.access?.role ?? null,
    message: describeThrown(input.error),
    stack: input.error instanceof Error ? (input.error.stack ?? null) : null,
  }).catch(() => {
    // The logger never turns a failing answer into a crash.
  });
  return NextResponse.json({ error: input.code, message }, { status: 500 });
}
