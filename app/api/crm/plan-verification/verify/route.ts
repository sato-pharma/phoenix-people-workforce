import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { isIReports360Configured } from "@/lib/crm/config";
import { resolveVendorSyncStandDown, VENDOR_SYNC_RETIRED_MESSAGE } from "@/lib/crm/cutover";
import { IReports360ApiError } from "@/lib/crm/client";
import { canAccessPlanVerification, getPlanVerificationScope } from "@/lib/crm/plan-verification-access";
import { isPlanVerificationAction } from "@/lib/crm/plan-verification";
import { setPlanVerification } from "@/lib/crm/plan-verification-service";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// A district manager verifies one rep's plan — or takes that verification back. The ONLY route in
// Phoenix that writes into the customer's CRM.
//
// The path still reads `/verify` after unverify was added on 2026-09-01, and that is deliberate:
// renaming it would break every in-flight client for a cosmetic gain, and the direction is a
// parameter of the same decision rather than a second operation. Both directions pass the same
// three gates and the same pure rule; neither is a shortcut past the other.
//
// GATED THREE TIMES, in widening order of cost:
//   1. the role list (plan-verification-access.ts) — is this seat allowed here at all;
//   2. crm_plans:approve through the permission matrix — the actual security boundary. `approve`,
//      not `read`: the CEO account holds read and is deliberately observational on this, so the
//      board opens for it and this route does not;
//   3. the viewer's ORG SCOPE against the plan's own rep, resolved server-side and checked inside
//      setPlanVerification against a fresh read of the plan.
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

    const body = (await request.json().catch(() => ({}))) as { action?: unknown; crmPlanId?: unknown };
    const crmPlanId = Number(body?.crmPlanId);
    // A NEGATIVE id is a plan filed in Phoenix after the CRM cutover (crm_plan_entries_unified). It
    // has no iReports360 record to sign, and it is decided on Phoenix's own plan review screen.
    // Asked BEFORE the stand-down below: once the vendor is retired every plan a manager sees is a
    // Phoenix plan, and the generic "iReports360 has been retired" would not tell him where to go.
    if (Number.isInteger(crmPlanId) && crmPlanId < 0) {
      return NextResponse.json(
        {
          error:
            "This plan was filed in Phoenix, so it is reviewed on Phoenix's plan review screen (Visits, then Plan reviews), not verified in iReports360.",
        },
        { status: 409 },
      );
    }

    // THE CRM CUTOVER. This route writes a signature into iReports360; once it is retired there is no
    // CRM to write into.
    const standDown = await resolveVendorSyncStandDown();
    if (standDown) {
      return NextResponse.json({ error: VENDOR_SYNC_RETIRED_MESSAGE }, { status: 409 });
    }

    if (!isIReports360Configured()) {
      return NextResponse.json(
        { error: "The iReports360 connection is not configured in this environment." },
        { status: 503 },
      );
    }

    if (!Number.isInteger(crmPlanId) || crmPlanId <= 0) {
      return NextResponse.json({ error: "Give the plan id to verify." }, { status: 400 });
    }

    // ABSENT means verify — the shape every caller sent before unverify existed, and the safe
    // default if the field is ever lost in transit. Anything PRESENT but unrecognised is refused
    // rather than falling back, because a typo'd action silently becoming "verify" would write a
    // signature into the customer's CRM that nobody asked for.
    const action = body?.action === undefined ? "verify" : body.action;
    if (!isPlanVerificationAction(action)) {
      return NextResponse.json({ error: 'The action must be "verify" or "unverify".' }, { status: 400 });
    }

    const scope = await getPlanVerificationScope(access);
    const outcome = await setPlanVerification({
      action,
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
        action: outcome.action,
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
    if (isForbiddenError(error)) return NextResponse.json({ error: clientSafeErrorMessage(error, "Forbidden.") }, { status: 403 });
    return NextResponse.json({ error: String((error as { message?: unknown })?.message ?? error) }, { status: 500 });
  }
}
