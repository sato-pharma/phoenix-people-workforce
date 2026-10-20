// HR Daily & Weekly Reports — one place that turns a thrown error into the response a person reads.
//
// The routes keep their guard calls inline (the access-registry coverage test reads each method
// block for a literal `assertPermission(access, "hr_ops_reports", "<action>")`); only the catch is
// shared, so the routes cannot drift apart on what a refusal sounds like. Mirrors
// src/lib/hr-reminders/http.ts.

import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

import { isHrOpsReportsError } from "./types";

export function hrOpsErrorResponse(error: unknown, fallback: string): NextResponse {
  if (isApiRateLimitError(error)) {
    return NextResponse.json(
      { error: "rate_limited", message: "You are going a little fast. Wait a moment and try again.", retryAfterSeconds: error.retryAfterSeconds },
      { status: 429 },
    );
  }
  if (isHrOpsReportsError(error)) {
    return NextResponse.json({ message: error.message }, { status: error.status });
  }
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message }, { status: 403 });
  }
  return NextResponse.json({ message: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

/** A report id as the URL carries it — a uuid, or a 404 before any read. */
export function reportIdOrNull(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return isUuid(id) ? id : null;
}
