// Marketing Functions — one place that turns a thrown error into the response a person reads.
//
// The routes keep their guard calls inline (the access-registry coverage test reads each method block
// for a literal `assertPermission(access, "<resource>", "<action>")`); only the catch is shared, so
// the routes cannot drift apart on what a refusal sounds like. Mirrors src/lib/hr-ops-reports/http.ts.

import { NextResponse } from "next/server";

import { isForbiddenError } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { isUuid } from "@/lib/http/uuid";
import { isApiRateLimitError } from "@/lib/security/api-rate-limit";

import { isMarketingFunctionsError } from "./types";

export const XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export function marketingFunctionsErrorResponse(error: unknown, fallback: string): NextResponse {
  if (isApiRateLimitError(error)) {
    return NextResponse.json(
      { error: "rate_limited", message: "You are going a little fast. Wait a moment and try again.", retryAfterSeconds: error.retryAfterSeconds },
      { status: 429 },
    );
  }
  if (isMarketingFunctionsError(error)) {
    return NextResponse.json({ message: error.message }, { status: error.status });
  }
  if (isForbiddenError(error)) {
    return NextResponse.json({ message: (error as Error).message }, { status: 403 });
  }
  return NextResponse.json({ message: clientSafeErrorMessage(error, fallback) }, { status: 500 });
}

export function uuidOrNull(value: unknown): string | null {
  const id = typeof value === "string" ? value.trim() : "";
  return isUuid(id) ? id : null;
}

export function workbookResponse(buffer: ArrayBuffer, fileName: string): NextResponse {
  return new NextResponse(buffer, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${fileName}"`,
      "content-type": XLSX_MEDIA_TYPE,
    },
    status: 200,
  });
}

/** A JSON body, or an empty object when the body is missing or not JSON. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
