import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { customerPharmacyMappingApiError } from "@/lib/customer-pharmacy-mapping/api-error";
import {
  approveCustomerPharmacyLink,
  rejectCustomerPharmacyLink,
} from "@/lib/customer-pharmacy-mapping/actions";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;

    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = await request.json().catch(() => ({}) as Record<string, unknown>);

    if (body?.decision === "approve") {
      const result = await approveCustomerPharmacyLink(access, {
        linkId: id,
        notes: typeof body.notes === "string" ? body.notes : null,
      });
      return NextResponse.json({ result, success: true });
    }

    if (body?.decision === "reject") {
      const result = await rejectCustomerPharmacyLink(access, {
        linkId: id,
        reason: typeof body.reason === "string" ? body.reason : "",
      });
      return NextResponse.json({ result, success: true });
    }

    return NextResponse.json(
      { error: "invalid_decision", message: "decision must be \"approve\" or \"reject\".", success: false },
      { status: 400 },
    );
  } catch (error) {
    const { code, message, status } = customerPharmacyMappingApiError(error);
    return NextResponse.json({ error: code, message, success: false }, { status });
  }
}
