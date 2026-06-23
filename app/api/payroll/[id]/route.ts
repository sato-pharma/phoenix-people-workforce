import { NextResponse } from "next/server";

import { deleteSalaryBatch } from "@/lib/payroll/service";
import { assertPermission } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { isPayrollConflictError } from "@/lib/payroll/errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "payroll", "delete");
    const { id } = await params;
    await deleteSalaryBatch(id);

    return NextResponse.json({ success: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Payroll upload delete failed.";
    if (isForbiddenError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 403 });
    }
    if (isPayrollConflictError(error)) {
      return NextResponse.json({ success: false, error: message }, { status: 409 });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
