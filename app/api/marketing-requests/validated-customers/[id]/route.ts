import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { getValidatedMarketingCustomerDetail } from "@/lib/marketing-requests/validated-customer-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// One customer, everything on it — the detail page behind a row in the register.
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getValidatedMarketingCustomerDetail(access, id));
  } catch (error) {
    const apiError = toApiError(error, "Could not load that customer.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message },
      { status },
    );
  }
}
