import { NextResponse } from "next/server";

import { describeThrown } from "@/lib/error-monitor/describe-thrown";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { pingDeadMansSwitch } from "@/lib/observability/dead-mans-switch";
import { logError } from "@/lib/observability/log";
import { refreshExpenseClaims } from "@/lib/outstation/claims-refresh";
import { assertCronAuthorized } from "@/lib/security/cron-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

const JOB_SLUG = "phoenix-expense-claims-refresh";

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
 *
 * THE DEAD-MAN'S SWITCH IS PINGED DIRECTLY, NOT VIA `withDeadMansSwitch`, and the three status
 * codes above are exactly why. Two of them — 409 and the parity-dirty 500 — are returned WITHOUT
 * throwing, so the generic wrapper would see a clean resolve and ping "success" on both: green on
 * a mirror that is no longer being rebuilt, which is the precise failure this route was written to
 * end. All three non-clean outcomes therefore ping /fail with the reason as detail. A 409 counts
 * as a failure even though nothing is broken: an interlock refusal is persistent, and while it
 * stands the schedule's guarantee is not being kept — which is the drift that once hid 31 approved
 * claims worth EGP 15,294.74 from the approvals queue for ten days.
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
      await pingDeadMansSwitch(JOB_SLUG, "fail", `interlock refused the rebuild: ${result.reason}`);
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
      await pingDeadMansSwitch(
        JOB_SLUG,
        "fail",
        `parity still dirty after rebuild: ${result.parity.drifted} of ${result.parity.total} claim(s)`,
      );
      return NextResponse.json(
        { ...body, success: false, error: "expense_claims_refresh_parity_dirty" },
        { status: 500 },
      );
    }

    // `flagged` rides along in the success detail because a held row is the one thing a clean
    // parity verdict CANNOT tell you about. Parity answers "did the rebuild reproduce legacy";
    // `flagged` answers "does legacy hold something the mirror cannot represent" — an approved
    // amount above the claim, or components that do not sum. Both are legitimate reasons for a
    // green run, and without this the count only exists in a response body that cron-job.org
    // discards (AGENTS.md §3 — its job list returns an empty body).
    await pingDeadMansSwitch(
      JOB_SLUG,
      "success",
      `${result.claims} claim(s) rebuilt, parity clean, ${result.flagged} flagged for data quality`,
    );
    return NextResponse.json(body);
  } catch (error) {
    logError("Expense claims refresh failed", {
      labels: { event: "cron_failed", job: "expense-claims-refresh" },
      error,
    });
    // Calling String() on the thrown value here wrote the literal "[object Object]" into
    // job_heartbeats.last_detail on every failed run from 2026-09-03 02:51 Cairo — a red job that
    // could not say why. Supabase throws a plain object, so the non-Error branch was the one that
    // ran. claims-refresh.ts now wraps at source; describeThrown is the backstop for anything else
    // that reaches here.
    await pingDeadMansSwitch(JOB_SLUG, "fail", describeThrown(error));
    const message = clientSafeErrorMessage(error, "Expense claims refresh failed.");
    return NextResponse.json({ error: "expense_claims_refresh_failed", message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return GET(request);
}
