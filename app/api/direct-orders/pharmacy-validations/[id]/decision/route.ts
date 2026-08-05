import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { decideDirectOrderPharmacyValidation } from "@/lib/direct-orders/pharmacy-validation";
import { toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Super Admin decides a pharmacy validation: match to an existing directory customer,
// approve as new (provisional, on probation), or reject (spec A2).
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const decision = String(body.decision ?? "").trim();
    if (!["approve", "match", "reject"].includes(decision)) {
      return NextResponse.json(
        { error: "invalid_request", message: "decision must be approve, match, or reject.", success: false },
        { status: 400 },
      );
    }
    await decideDirectOrderPharmacyValidation(access, {
      validationId: id,
      decision: decision as "approve" | "match" | "reject",
      notes: body.notes ? String(body.notes) : null,
      matchDistributorCode: body.matchDistributorCode ? String(body.matchDistributorCode) : null,
      matchCustomerCode: body.matchCustomerCode ? String(body.matchCustomerCode) : null,
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    const apiError = toApiError(error, "Could not record the validation decision.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
