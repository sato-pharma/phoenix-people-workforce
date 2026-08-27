import { NextResponse } from "next/server";

import { backfillMissingMarketingAssignmentEmails } from "@/lib/marketing-requests/service";
import { logCronUnauthorized, logError } from "@/lib/observability/log";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { bearerSecretMatches } from "@/lib/security/constant-time";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

function isAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET;
  // An unset CRON_SECRET may ONLY be bypassed on a real developer machine. Anything less
  // would leave this route callable unauthenticated wherever CRON_SECRET is unset —
  // including staging, which is a 1:1 clone of production data.
  if (!secret) return process.env.NODE_ENV === "development";
  return bearerSecretMatches(request.headers.get("authorization"), secret);
}

/**
 * Tell the approver who is holding a marketing request that it is on their desk — for any request
 * where that never happened.
 *
 * A decision recorded outside the app (straight into the database) skips the notify path entirely,
 * so the request advances and its new approver is never told. `MKT-REQ-20260818-8C628BF4` reached
 * Finance Execution on 2026-08-19 with zero deliveries on any channel while its sibling, decided
 * through the UI 22 minutes earlier, reached the same person on email, in-app and push.
 *
 * The same sweep runs on the daily job; this route exists so it can be driven ON DEMAND, in
 * production, without running every other daily notification alongside it — and without sending
 * production mail from a developer machine whose `.env.local` can differ from production (it
 * currently carries the decommissioned Vercel `PHOENIX_APP_URL`, which would put a dead link in
 * front of the approver).
 *
 * Sends nothing that was already sent: the notice keys on the current step id and
 * `notification_deliveries.idempotency_key` is a UNIQUE index, so an already-notified rung is a
 * no-op rather than a second email.
 */
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    logCronUnauthorized("cron/marketing-assignment-backfill", request);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  try {
    const result = await backfillMissingMarketingAssignmentEmails();
    return NextResponse.json({
      success: true,
      checked: result.checked,
      dispatched: result.dispatched,
      requestCodes: result.requestCodes,
    });
  } catch (error) {
    logError("Marketing assignment backfill failed", {
      labels: { event: "cron_failed", job: "marketing-assignment-backfill" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Marketing assignment backfill failed.");
    return NextResponse.json({ error: "marketing_assignment_backfill_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
