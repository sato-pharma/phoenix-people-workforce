import { NextResponse, type NextRequest } from "next/server";

import { canAccessSystemAdministratorWorkspace } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { pauseCronJob } from "@/lib/cron-control/service";
import { assertApiRateLimit, isApiRateLimitError, rateLimitIdentity } from "@/lib/security/api-rate-limit";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Super Admin only — pausing a cron that drives payroll/notification SLAs is at least as
// consequential as an IP block (which uses the same gate).
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
      limit: 5,
      scope: "cron-control:mutate",
      windowMs: 60 * 1000,
    });

    const { jobName } = await context.params;
    const job = await pauseCronJob(jobName, access);
    return NextResponse.json({ ok: true, job });
  } catch (error) {
    if (isApiRateLimitError(error)) {
      return NextResponse.json(
        { error: "rate_limited", message: "Too many cron mutations — slow down.", retryAfterSeconds: error.retryAfterSeconds },
        { status: 429 },
      );
    }
    if (isForbiddenError(error)) {
      return NextResponse.json({ message: (error as Error).message }, { status: 403 });
    }
    return NextResponse.json(
      { ok: false, error: clientSafeErrorMessage(error, "Failed to pause cron job.") },
      { status: 500 },
    );
  }
}
