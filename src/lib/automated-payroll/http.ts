import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";

import { describeBankCoverage, type BankCoverage } from "./exports/bank-coverage.ts";

/**
 * Shared route helpers for the Automated Payroll API. Maps the service layer's
 * prefixed Error messages ("Forbidden:", "Not found:", "Conflict:", "Validation:")
 * to HTTP status codes, and builds the xlsx download response.
 */

// Re-exported so routes resolve the session with the canonical guard token.
export { resolveAccessContext } from "@/lib/auth/server";

export function jsonError(error: unknown, fallback = "Automated Payroll request failed."): NextResponse {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  let status = 500;
  if (isForbiddenError(error) || lower.startsWith("forbidden:")) status = 403;
  else if (lower.startsWith("not found") || lower.includes("does not exist")) status = 404;
  else if (lower.startsWith("conflict")) status = 409;
  else if (lower.startsWith("validation")) status = 400;
  else if (lower.includes("not authenticated")) status = 401;

  if (status === 500) {
    logError("Automated payroll: unhandled route error", {
      labels: { event: "automated_payroll_route_unhandled_error" },
      error,
    });
  }

  const clientMessage =
    status === 500 ? fallback : message.replace(/^(forbidden|conflict|validation|not found)\s*:?\s*/i, "");
  return NextResponse.json({ success: false, error: clientMessage }, { status });
}

/**
 * The xlsx download, plus — since 2026-09-10 — an explicit answer to "does this file carry
 * everybody it should".
 *
 * A bank file missing people used to download completely cleanly: the only check anywhere was
 * whether the file came out EMPTY, so three non-employees paid through QNB and Instapay were
 * absent from both transfer files for two months with nothing saying so. These headers travel with
 * every download, so a caller, a script, or a browser network tab gets the answer without opening
 * the workbook.
 *
 * The summary is percent-encoded because it names people and the names here are routinely Arabic:
 * a raw non-Latin-1 header value throws rather than degrading.
 */
export function xlsxResponse(
  buffer: Buffer,
  fileName: string,
  bankCoverage?: readonly BankCoverage[],
): NextResponse {
  const headers: Record<string, string> = {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${fileName}"`,
    "Cache-Control": "no-store",
  };
  if (bankCoverage && bankCoverage.length > 0) {
    headers["X-Bank-Coverage-Complete"] = String(bankCoverage.every((entry) => entry.covered));
    headers["X-Bank-Coverage"] = encodeURIComponent(bankCoverage.map(describeBankCoverage).join(" | "));
  }
  return new NextResponse(buffer as unknown as BodyInit, { status: 200, headers });
}
