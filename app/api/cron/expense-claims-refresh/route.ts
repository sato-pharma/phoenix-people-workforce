import { NextResponse } from "next/server";

import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { refreshExpenseClaims } from "@/lib/outstation/claims-refresh";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Rebuild the `expense_claims` read mirror from the legacy outstation tables.
 *
 * Reads are live on that mirror in production (`PHOENIX_EXPENSE_CLAIMS_READ=true`) while writes
 * still go to the legacy tables, so the mirror is correct only for as long as something rebuilds
 * it. Until this route existed, nothing did: `phx_refresh_expense_claims()` had no caller at all
 * and was invoked by hand. It drifted for ten days and hid 31 approved claims (EGP 15,294.74) from
 * the approvals queue. The full account is on `claims-refresh.ts`.
 *
 * The schedule is the guarantee. This route only makes it callable.
 *
 * WHAT THE STATUS CODES MEAN — deliberately not all 200:
 *
 *  - 200  rebuilt, and the parity view agrees with the legacy tables afterwards.
 *  - 409  an interlock refused. The rebuild is no longer safe (writes have cut over, or payroll
 *         linkage exists that the rebuild would destroy) and a human has to decide what happens
 *         next. Not retryable, so it must not look like a transient failure.
 *  - 500  rebuilt, but parity is STILL dirty afterwards. That should be impossible — the rebuild
 *         derives the mirror from the same tables the parity view compares against — so it means
 *         the rebuild and the view disagree, on data that approvers are reading right now.
 *
 * A red job here is meant to be read, not muted. `attempted: 0`-style silence is what let the
 * notification outbox sit blocked for thirteen days behind a green cron (AGENTS.md §3), so the
 * parity verdict is reported in the response body on every path and mirrored into the logs on both
 * failure paths — `railway logs | grep expense_claims_refresh` is the detection that actually works
 * here, since cron-job.org's job list returns an empty body.
 */
export async function GET(request: Request) {
  const denied = assertCronAuthorized(request, "cron/expense-claims-refresh");
  if (denied) return denied;

  try {
    const result = await refreshExpenseClaims();

    if (result.status === "blocked") {
      logError("Expense claims refresh refused by an interlock", {
        labels: { event: "cron_blocked", job: "expense-claims-refresh" },
        error: new Error(result.reason),
      });
      return NextResponse.json(
        { success: false, error: "expense_claims_refresh_blocked", message: result.reason },
        { status: 409 },
      );
    }

    const body = {
      success: true,
      claims: result.claims,
      imports: result.imports,
      flagged: result.flagged,
      refreshedAt: result.refreshedAt,
      parity: result.parity,
    };

    if (result.parity && !result.parity.clean) {
      logError("Expense claims mirror still disagrees with legacy after a rebuild", {
        labels: { event: "cron_failed", job: "expense-claims-refresh" },
        error: new Error(
          `${result.parity.drifted} of ${result.parity.total} claim(s) drifted after rebuild: ${result.parity.driftedRefs.join(", ")}`,
        ),
      });
      return NextResponse.json(
        { ...body, success: false, error: "expense_claims_refresh_parity_dirty" },
        { status: 500 },
      );
    }

    return NextResponse.json(body);
  } catch (error) {
    logError("Expense claims refresh failed", {
      labels: { event: "cron_failed", job: "expense-claims-refresh" },
      error,
    });
    const message = clientSafeErrorMessage(error, "Expense claims refresh failed.");
    return NextResponse.json({ error: "expense_claims_refresh_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
