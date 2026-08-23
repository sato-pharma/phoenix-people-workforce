import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext, jsonError } from "@/lib/deductions/http.ts";
import { DEDUCTION_COLLECTORS, isDeductionCollectorKey } from "@/lib/deductions/collect.ts";
import { assertDeductionsDecisionActor } from "@/lib/deductions/permissions.ts";
import { collectSettlementForLeaver, resolveSettlementEligibility } from "@/lib/deductions/settlement.ts";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

type SettlementBody = {
  month?: unknown;
  year?: unknown;
  connector?: unknown;
  employeeHrId?: unknown;
};

/**
 * Final-settlement collection for ONE leaver, in the month they left.
 *
 * Separate from /collect because the two answer different questions. /collect
 * asks "has this MONTH finished" and refuses if not — correctly, and that guard
 * is untouched. This asks "has this PERSON's employment finished", which for a
 * leaver whose last working day has passed is already true mid-month.
 *
 * Same one-connector-per-request shape as /collect, and for the same reason:
 * each connector is a company-wide scan, and running them all in one request is
 * what blew the 300s limit and got the module reverted (#1377). A request with
 * no `connector` returns eligibility plus the plan without scanning anything,
 * so the client can check a person before committing to six calls.
 */
export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "create");
    assertDeductionsDecisionActor(access);

    const body = (await request.json().catch(() => ({}))) as SettlementBody;
    const month = Number(body.month);
    const year = Number(body.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error("Validation: month must be an integer between 1 and 12.");
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      throw new Error("Validation: year must be an integer between 2000 and 2100.");
    }
    if (typeof body.employeeHrId !== "string" || !body.employeeHrId.trim()) {
      throw new Error("Validation: employeeHrId is required.");
    }

    const plan = DEDUCTION_COLLECTORS.map((collector) => ({ key: collector.key, label: collector.label }));

    // No connector = a dry check. Never scans, never writes.
    if (body.connector === undefined || body.connector === null) {
      const eligibility = await resolveSettlementEligibility({
        employeeHrId: body.employeeHrId,
        month,
        year,
      });
      return NextResponse.json({ success: true, eligibility, plan });
    }
    if (!isDeductionCollectorKey(body.connector)) {
      throw new Error(`Validation: connector must be one of ${plan.map((entry) => entry.key).join(", ")}.`);
    }

    const result = await collectSettlementForLeaver({
      employeeHrId: body.employeeHrId,
      connector: body.connector,
      month,
      year,
      createdBy: access.hrId ?? access.loginId ?? "unknown",
    });

    return NextResponse.json({ success: true, connector: body.connector, result });
  } catch (error) {
    return jsonError(error, "Failed to run the final-settlement collection.");
  }
}
