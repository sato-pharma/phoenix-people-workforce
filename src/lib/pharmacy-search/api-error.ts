/**
 * One place that decides which Pharmacy Search failure becomes which HTTP status, so every route
 * answers the same way and no internal message leaks to the browser by accident.
 */

import { PharmacySearchAccessError } from "./access";
import { GoogleLookupUnavailableError } from "./external";
import { PharmacyNotFoundError } from "./profile";
import { NotSaveableError } from "./save";

export function pharmacySearchApiError(error: unknown): {
  code: string;
  message: string;
  status: number;
} {
  if (error instanceof PharmacySearchAccessError) {
    return { code: "forbidden", message: error.message, status: 403 };
  }
  if (error instanceof PharmacyNotFoundError) {
    return { code: "not_found", message: error.message, status: 404 };
  }
  if (error instanceof NotSaveableError) {
    return { code: "not_saveable", message: error.message, status: 422 };
  }
  if (error instanceof GoogleLookupUnavailableError) {
    // 503, not 500: the server is fine, the optional dependency is not configured. The UI shows
    // this verbatim so the reader knows it is a setup gap and not a missing pharmacy.
    return { code: "google_unavailable", message: error.message, status: 503 };
  }
  return {
    code: "server_error",
    message: error instanceof Error ? error.message : "Pharmacy search failed.",
    status: 500,
  };
}
