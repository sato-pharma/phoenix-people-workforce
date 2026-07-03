import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { getCustomerPharmacyReadiness } from "@/lib/customer-pharmacy-mapping/readiness";
import { toApiError } from "@/lib/http/api-errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function customerPharmacyMappingApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return {
      code: "forbidden",
      message: error instanceof Error ? error.message : "Forbidden.",
      status: 403,
    };
  }

  const message = error instanceof Error
    ? error.message
    : typeof error === "object" && error && "message" in error
      ? String((error as { message?: unknown }).message ?? "")
      : String(error ?? "");
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_customer") ||
    normalized.includes("marketing_pharmac") ||
    normalized.includes("marketing_distributor") ||
    normalized.includes("could not find the table") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "customer_pharmacy_mapping_schema_not_ready",
      message: "Customer pharmacy mapping schema is not applied to the connected database yet.",
      status: 503,
    };
  }

  const apiError = toApiError(error, "Customer pharmacy mapping failed.");
  return {
    code: apiError.code === "internal_error" ? "customer_pharmacy_mapping_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    return NextResponse.json(await getCustomerPharmacyReadiness(access));
  } catch (error) {
    const { code, message, status } = customerPharmacyMappingApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
