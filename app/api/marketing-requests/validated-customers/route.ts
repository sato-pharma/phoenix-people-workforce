import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listValidatedMarketingCustomers } from "@/lib/marketing-requests/validated-customer-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The admin register: every validated marketing customer in the company, with who captured it.
// Access is enforced inside the service (Super Admin / SFE Manager), not here — the route is a
// transport, the service is the boundary.
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await listValidatedMarketingCustomers(access));
  } catch (error) {
    const apiError = toApiError(error, "Could not load the validated customer register.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message },
      { status },
    );
  }
}
