import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isIReports360Configured } from "@/lib/crm/config";
import { IReports360ApiError } from "@/lib/crm/client";
import { canAccessPlanVerification, getPlanVerificationScope } from "@/lib/crm/plan-verification-access";
import { verifyPlan } from "@/lib/crm/plan-verification-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A district manager verifies one rep's plan. The ONLY route in Phoenix that writes into the
// customer's CRM.
//
// GATED THREE TIMES, in widening order of cost:
//   1. the role list (plan-verification-access.ts) — is this seat allowed here at all;
//   2. crm_plans:approve through the permission matrix — the actual security boundary. `approve`,
//      not `read`: the CEO account holds read and is deliberately observational on this, so the
//      board opens for it and this route does not;
//   3. the viewer's ORG SCOPE against the plan's own rep, resolved server-side and checked inside
//      verifyPlan against a fresh read of the plan.
//
// The third is the one that matters and the one a role check cannot do. A district manager passing
// this gate is still only entitled to HIS reps' plans, and the scope object is resolved here from
// the live AccessContext — never from anything the browser sent. `access.role` off a request body
// would let any viewer name himself Super Admin and take the company branch.
//
// A plan outside the viewer's reach answers 404, not 403, so ids cannot be probed to discover which
// plans exist in another district.

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    if (!canAccessPlanVerification(access)) {
      return NextResponse.json({ error: "Plan verification is not available to your role." }, { status: 403 });
    }
    await assertPermission(access, "crm_plans", "approve");

    if (!isIReports360Configured()) {
      return NextResponse.json(
        { error: "The iReports360 connection is not configured in this environment." },
        { status: 503 },
      );
    }

    const body = (await request.json().catch(() => ({}))) as { crmPlanId?: unknown };
    const crmPlanId = Number(body?.crmPlanId);
    if (!Number.isInteger(crmPlanId) || crmPlanId <= 0) {
      return NextResponse.json({ error: "Give the plan id to verify." }, { status: 400 });
    }

    const scope = await getPlanVerificationScope(access);
    const outcome = await verifyPlan({
      actorHrId: access.hrId ?? null,
      actorLoginId: access.loginId ?? access.hrId ?? null,
      actorName: access.loginId ?? access.hrId ?? null,
      crmPlanId,
      scope,
    });

    if (!outcome.ok) {
      return NextResponse.json({ error: outcome.reason }, { status: outcome.status });
    }
    return NextResponse.json(
      {
        repNotified: outcome.repNotified,
        repNotifyReason: outcome.repNotifyReason,
        status: outcome.status,
        statusLabel: outcome.statusLabel,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    // The vendor's own message is passed through with its own status — "Weekly plan not found." is
    // a far more actionable thing for a manager to read than a generic 500, and it is the CRM
    // telling us the write did not happen.
    if (error instanceof IReports360ApiError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    if (isForbiddenError(error)) return NextResponse.json({ error: String(error) }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
