import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";
import { listMarketingVendors, setMarketingVendorActive } from "@/lib/marketing-requests/vendor-control";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Every vendor, shown or hidden, with its codes and customers. Gated in the service, Super Admin only. */
export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json({ vendors: await listMarketingVendors(access) });
  } catch (error) {
    const apiError = toApiError(error, "Could not read the vendors.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json({ error: status === 403 ? "forbidden" : apiError.code, message: apiError.message }, { status });
  }
}

/** Allow or hide one vendor. A press writes one row and one required audit entry; it loads no codes. */
export async function PATCH(request: Request) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as { active?: unknown; vendorId?: unknown };
    const vendors = await setMarketingVendorActive(access, {
      active: body.active as boolean,
      vendorId: Number(body.vendorId),
    });
    return NextResponse.json({ success: true, vendors });
  } catch (error) {
    const apiError = toApiError(error, "Could not change the vendor.");
    const status = isForbiddenError(error) ? 403 : apiError.status;
    return NextResponse.json(
      { error: status === 403 ? "forbidden" : apiError.code, message: apiError.message, success: false },
      { status },
    );
  }
}
