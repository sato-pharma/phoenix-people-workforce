import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage, errorMessageOf, toApiError } from "@/lib/http/api-errors";
import { getPharmacyMasterCandidates } from "@/lib/pharmacy-master/pharmacy-matching-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Read-only candidate-review report (Phase 1). GET only — no mutation, no merge, no auto-create.
function pharmacyMasterApiError(error: unknown) {
  if (isForbiddenError(error)) {
    return { code: "forbidden", message: clientSafeErrorMessage(error, "Forbidden."), status: 403 };
  }
  const message = errorMessageOf(error);
  const normalized = message.toLowerCase();
  if (
    normalized.includes("marketing_pharmac") ||
    normalized.includes("marketing_distributor") ||
    normalized.includes("could not find the table") ||
    normalized.includes("schema cache") ||
    (normalized.includes("relation") && normalized.includes("does not exist"))
  ) {
    return {
      code: "pharmacy_master_schema_not_ready",
      message: "Pharmacy Master schema is not applied to the connected database yet.",
      status: 503,
    };
  }
  const apiError = toApiError(error, "Pharmacy Master failed.");
  return {
    code: apiError.code === "internal_error" ? "pharmacy_master_failed" : apiError.code,
    message: apiError.message,
    status: apiError.status,
  };
}

export async function GET(request: Request) {
  try {
    const access = await resolveAccessContext(request);
    const result = await getPharmacyMasterCandidates(access);
    return NextResponse.json(result);
  } catch (error) {
    const { code, message, status } = pharmacyMasterApiError(error);
    return NextResponse.json({ error: code, message }, { status });
  }
}
