// Shared API error shaping for the standalone Customer Pharmacy Mapping route handlers
// (read route + decision route). Kept here, not duplicated per-route, so both stay in sync.

import { isForbiddenError } from "@/lib/auth/server";
import { toApiError } from "@/lib/http/api-errors";

export function customerPharmacyMappingApiError(error: unknown) {
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
