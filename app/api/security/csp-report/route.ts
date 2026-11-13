import { NextResponse } from "next/server";

import { logInfo } from "@/lib/observability/log";
import { clientAddress } from "@/lib/security/client-address";
import {
  CSP_REPORT_MAX_BODY_BYTES,
  CSP_REPORT_RATE_LIMIT,
  CSP_REPORT_RATE_WINDOW_MS,
  countCspViolation,
  parseCspReports,
} from "@/lib/security/csp-report-intake";
import { createSharedAddressLimit } from "@/lib/security/shared-address-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Where a browser reports what the REPORT-ONLY page policy would have blocked (S01, F-PLT-011): a
// `<style>` without the page's nonce, or a picture from a host outside the measured list. Nothing was
// blocked; this measures what enforcing the stricter policy would break. See csp-report-intake.ts.
//
// Like the page-timing beacon, it reads no session and records no identity: a report becomes a
// (directive, blocked origin, page shape) count in process memory, logged as
// `csp_report_only_violation` the first time a shape is seen and at 10, 100, 1,000 …. A body over
// 32 KB is refused, and one address gets CSP_REPORT_RATE_LIMIT reports a minute ACROSS EVERY INSTANCE
// (the shared bucket store, keyed by the hashed address — REC-083); that count is its only database
// touch, and an address already over its limit in this process is refused without one. The answer is
// an empty 204 — the browser does not wait on it.
const shapeCounts = new Map<string, number>();

const CSP_REPORT_MAX_ADDRESSES = 5_000;
const CSP_REPORT_RATE_SCOPE = "csp-report";
const addressLimit = createSharedAddressLimit({
  limit: CSP_REPORT_RATE_LIMIT,
  maxAddresses: CSP_REPORT_MAX_ADDRESSES,
  scope: CSP_REPORT_RATE_SCOPE,
  windowMs: CSP_REPORT_RATE_WINDOW_MS,
});

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length"));
  if (Number.isFinite(length) && length > CSP_REPORT_MAX_BODY_BYTES) {
    return new NextResponse(null, { status: 413 });
  }
  const address = clientAddress(request) || "unknown-ip";
  if (!(await addressLimit.allow(address))) {
    return new NextResponse(null, { status: 429 });
  }
  try {
    const raw = await request.text();
    if (raw.length > CSP_REPORT_MAX_BODY_BYTES) return new NextResponse(null, { status: 413 });
    for (const violation of parseCspReports(JSON.parse(raw))) {
      const count = countCspViolation(shapeCounts, violation);
      if (count === null) continue;
      logInfo("Report-only content security policy would have blocked this (nothing was blocked)", {
        labels: { event: "csp_report_only_violation", ...violation, count },
      });
    }
  } catch {
    // A malformed report is dropped; the browser never needs to know.
  }
  return new NextResponse(null, { status: 204 });
}
