import { NextResponse } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { assertDeductionsGovernanceDecisionActor } from "@/lib/deductions-governance/calculations";
import { syncAttendanceDeviceDeductionCandidates } from "@/lib/deductions-governance/connectors/attendance-device";
import { syncFieldWorkforceApprovedDecisions } from "@/lib/deductions-governance/connectors/field-workforce-compliance";
import { syncVacationWithoutBalanceDeductionCandidates } from "@/lib/deductions-governance/connectors/vacation";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string, defaultStatus = 500) {
  if (isForbiddenError(error)) {
    return NextResponse.json({ success: false, message: (error as Error).message }, { status: 403 });
  }
  const message = error instanceof Error ? error.message : fallback;
  const lower = message.toLowerCase();
  if (lower.includes("not authenticated")) return NextResponse.json({ success: false, message }, { status: 401 });
  if (lower.includes("forbidden")) return NextResponse.json({ success: false, message }, { status: 403 });
  if (lower.includes("invalid") || lower.includes("required") || lower.includes("missing")) {
    return NextResponse.json({ success: false, message }, { status: 400 });
  }
  return NextResponse.json({ success: false, message }, { status: defaultStatus });
}

export async function POST(request: Request) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "deductions", "read");
    assertDeductionsGovernanceDecisionActor(access);
    const body = await request.json();
    const monthKey = String(body.monthKey ?? "").trim();
    if (!monthKey) {
      return NextResponse.json({ success: false, message: "monthKey is required." }, { status: 400 });
    }
    const createdBy = access.loginId ?? access.hrId ?? "system";
    const [fieldWorkforce, attendanceDevice, vacation] = await Promise.all([
      syncFieldWorkforceApprovedDecisions({ createdBy, monthKey }),
      syncAttendanceDeviceDeductionCandidates({ createdBy, monthKey }),
      syncVacationWithoutBalanceDeductionCandidates({ createdBy, monthKey }),
    ]);
    return NextResponse.json({
      success: true,
      sources: {
        attendanceDevice,
        fieldWorkforce,
        vacation,
      },
      sourceTotal: fieldWorkforce.sourceTotal + attendanceDevice.sourceTotal + vacation.sourceTotal,
      created: fieldWorkforce.created + attendanceDevice.created + vacation.created,
      skippedExisting:
        fieldWorkforce.skippedExisting + attendanceDevice.skippedExisting + vacation.skippedExisting,
      warnings: [
        ...fieldWorkforce.warnings,
        ...attendanceDevice.warnings,
        ...vacation.warnings,
      ],
    });
  } catch (error) {
    return jsonError(error, "Deductions source sync failed.");
  }
}
