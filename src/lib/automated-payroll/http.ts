import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { ApiRateLimitError } from "@/lib/security/api-rate-limit";

import { describeBankCoverage, type BankCoverage } from "./exports/bank-coverage.ts";

/**
 * Shared route helpers for the Automated Payroll API. Maps the service layer's
 * prefixed Error messages ("Forbidden:", "Not found:", "Conflict:", "Validation:")
 * to HTTP status codes, and builds the xlsx download response.
 */

// Re-exported so routes resolve the session with the canonical guard token.
export { resolveAccessContext } from "@/lib/auth/server";

export function jsonError(error: unknown, fallback = "Automated Payroll request failed."): NextResponse {
  const { status, clientMessage } = classifyRouteError(error, fallback);
  return NextResponse.json({ success: false, error: clientMessage }, { status });
}

function classifyRouteError(error: unknown, fallback: string): { status: number; clientMessage: string } {
  // A person past the payroll download limit (download-log.ts): a readable refusal, never a 500.
  if (error instanceof ApiRateLimitError) {
    const minutes = Math.max(1, Math.ceil(error.retryAfterSeconds / 60));
    return {
      status: 429,
      clientMessage: `Too many payroll files downloaded in the last hour. Please try again in about ${minutes} minute${minutes === 1 ? "" : "s"}.`,
    };
  }
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
  return { status, clientMessage };
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);

/**
 * A REFUSED DOWNLOAD READS AS A PAGE, NOT AS JSON (owner, 2026-10-23 — "readable page").
 *
 * The finance downloads are started by sending the browser to the route (`downloadFromApiRoute`, and
 * plain links on the Finance Command Center), so when one refuses — the month moved since Part 2 was
 * confirmed, a bank account changed, Part 1 not confirmed yet — finance landed on raw
 * `{"success":false,"error":…}` text. A browser asking for a page now gets one, carrying the same
 * message and a way back; anything else (a script, a fetch) still gets the JSON it parses.
 */
export function downloadError(
  request: Request,
  error: unknown,
  fallback = "Automated Payroll request failed.",
): NextResponse {
  const accept = request.headers.get("accept") ?? "";
  if (!accept.includes("text/html")) return jsonError(error, fallback);
  const { status, clientMessage } = classifyRouteError(error, fallback);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Download not produced · Phoenix</title>
<style>
  body { margin: 0; background: #f5f7fa; color: #0b1f33; font: 15px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 640px; margin: 64px auto; padding: 0 16px; }
  section { background: #fff; border: 1px solid #d5dde6; border-top: 3px solid #0a527d; padding: 24px; }
  p.label { margin: 0 0 8px; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: #0a527d; font-weight: 600; }
  h1 { margin: 0 0 12px; font-size: 20px; }
  p.message { margin: 0 0 20px; overflow-wrap: anywhere; }
  a { display: inline-block; padding: 8px 14px; background: #0a527d; color: #fff; text-decoration: none; }
</style>
</head>
<body>
<main>
  <section>
    <p class="label">Automated Payroll</p>
    <h1>No file was produced</h1>
    <p class="message">${escapeHtml(clientMessage)}</p>
    <a href="/admin/automated-payroll/finance">Back to finance downloads</a>
  </section>
</main>
</body>
</html>`;
  return new NextResponse(html, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
  });
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
