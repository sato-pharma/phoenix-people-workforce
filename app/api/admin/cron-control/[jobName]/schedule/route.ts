import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { validateCronExpression } from "@/lib/cron-control/cron-expression";
import { updateCronJobSchedule } from "@/lib/cron-control/service";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Super Admin only. Server-side validation never trusts the client's own preview call — the
// API is directly callable, so syntax/reachability is re-checked here regardless of what the
// dashboard's "Preview" step already confirmed.
export async function POST(request: NextRequest, context: { params: Promise<{ jobName: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    if (!canAccessSystemAdministratorWorkspace(access)) {
      return NextResponse.json({ message: "Forbidden: Super Admin only." }, { status: 403 });
    }

    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 10,
      scope: "cron-control:schedule",
      windowMs: 60 * 1000,
    });

    const body = (await request.json().catch(() => ({}))) as {
      cronExpression?: unknown;
      timeZone?: unknown;
      previousCronExpression?: unknown;
      previousTimeZone?: unknown;
    };
    const cronExpression = typeof body.cronExpression === "string" ? body.cronExpression.trim() : "";
    const timeZone = typeof body.timeZone === "string" ? body.timeZone.trim() : "";
    if (!cronExpression || !timeZone) {
      return NextResponse.json({ ok: false, error: "cronExpression and timeZone are required." }, { status: 400 });
    }

    const validation = validateCronExpression(cronExpression, timeZone);
    if (!validation.valid) {
      return NextResponse.json({ ok: false, error: validation.error }, { status: 400 });
    }

    const previousSchedule =
      typeof body.previousCronExpression === "string" && typeof body.previousTimeZone === "string"
        ? { cronExpression: body.previousCronExpression, timeZone: body.previousTimeZone }
        : undefined;

    const { jobName } = await context.params;
    const job = await updateCronJobSchedule(jobName, { cronExpression, timeZone }, access, previousSchedule);
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many schedule edits — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, error: clientSafeErrorMessage(error, "Failed to update cron schedule.") },
      { status: 500 },
    );
  }
}
