import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { customerPharmacyMappingApiError } from "@/lib/customer-pharmacy-mapping/api-error";
import { getCustomerPharmacyReadiness } from "@/lib/customer-pharmacy-mapping/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getCustomerPharmacyReadiness(access));
  } catch (error) {
    const { code, message, status } = customerPharmacyMappingApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
