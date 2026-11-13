import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { hireHandoffSteps, type HireHandoffStep } from "@/lib/employees/hire-handoff";
import { retryHireHandoffNow } from "@/lib/employees/hire-handoff-reconciler";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { logError } from "@/lib/observability/log";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isStep(value: unknown): value is HireHandoffStep {
  return typeof value === "string" && (hireHandoffSteps as readonly string[]).includes(value);
}

/**
 * POST /api/employees/hire-handoff/retry — run ONE unfinished hire hand-off step again now, instead of
 * waiting for the hourly reconciler (REC-027). Body: `{ hrId, step }`.
 *
 * `employees:create` — the right that made the hire is the right that finishes it. The step runs
 * through exactly the retry the reconciler runs (`retryHireHandoffStep`), so it writes nothing a second
 * time and sends nothing the step did not already send — never an email. The login step uses the
 * presser's own seat, exactly as Add Employee would; a step already done is reported and left alone.
 * A press counts as an attempt; a step that has given up may be pressed again once its cause is fixed.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "employees", "create");

    const body = (await request.json().catch(() => null)) as { hrId?: unknown; step?: unknown } | null;
    const hrId = typeof body?.hrId === "string" ? body.hrId.trim() : "";
    if (!hrId || !isStep(body?.step)) {
      return NextResponse.json(
        { error: "invalid_request", message: "Name the employee's HR ID and one hand-off step." },
        { status: 400 },
      );
    }

    const result = await retryHireHandoffNow({
      actor: { loginId: access.loginId ?? null, role: access.role },
      hrId,
      step: body.step,
    });
    if (!result.found) {
      return NextResponse.json(
        { error: "not_found", message: "There is no hand-off step of that kind for this employee." },
        { status: 404 },
      );
    }
    if (result.alreadyDone) return NextResponse.json({ ok: true, status: "done", alreadyDone: true });
    return NextResponse.json({
      ok: result.outcome.status === "done",
      attempts: result.outcome.attempts,
      lastError: result.outcome.lastError,
      status: result.outcome.status,
    });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json({ error: "forbidden", message: "You are not allowed to add employees." }, { status: 403 });
    }
    logError("A hire hand-off retry failed", {
      error,
      labels: { event: "hire_handoff_retry_failed" },
    });
    return NextResponse.json(
      { error: "hire_handoff_retry_failed", message: clientSafeErrorMessage(error, "The step could not be retried.") },
      { status: 500 },
    );
  }
}
