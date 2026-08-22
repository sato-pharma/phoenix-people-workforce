import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { revertValidatedCustomerTransfer } from "@/lib/marketing-requests/validated-customer-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Undo a transfer. Refused once the Direct Order desk has decided the validation — see the
// service for why that refusal exists rather than being a warning.
export async function POST(request: Request, { params }: { params: Promise<{ transferId: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { transferId } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { reason?: string | null };

    const result = await revertValidatedCustomerTransfer(access, {
      reason: body.reason ?? null,
      transferId,
    });

    return NextResponse.json({ ...result, success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not revert that transfer.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
