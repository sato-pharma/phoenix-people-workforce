import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";

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

  if (status === 500) console.error("[automated-payroll:route]", error);

  const clientMessage =
    status === 500 ? fallback : message.replace(/^(forbidden|conflict|validation|not found)\s*:?\s*/i, "");
  return NextResponse.json({ success: false, error: clientMessage }, { status });
}

export function xlsxResponse(buffer: Buffer, fileName: string): NextResponse {
  return new NextResponse(buffer as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Cache-Control": "no-store",
    },
  });
}
