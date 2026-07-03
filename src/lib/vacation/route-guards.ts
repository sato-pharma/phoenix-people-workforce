import { NextResponse, type NextRequest } from "next/server";

import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const vacationUploadMaxBytes = 20 * 1024 * 1024;
export const vacationExportMaxRows = 5000;

export function rejectOversizedVacationUploadRequest(request: Request) {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > vacationUploadMaxBytes) {
    return NextResponse.json(
      {
        error: "vacation_attachment_too_large",
        message: "Vacation evidence uploads are limited to 20MB.",
        success: false,
      },
      { status: 413 },
    );
  }
  return null;
}

export function rejectOversizedVacationFile(file: File | null | undefined) {
  if (!file || file.size <= vacationUploadMaxBytes) return null;
  return NextResponse.json(
    {
      error: "vacation_attachment_too_large",
      message: "Vacation evidence uploads are limited to 20MB.",
      success: false,
    },
    { status: 413 },
  );
}

export async function assertVacationRouteRateLimit(input: {
  actor?: string | null;
  limit: number;
  request: NextRequest | Request;
  scope: string;
  token?: string | null;
  windowMs: number;
}) {
  await assertApiRateLimit({
    identifier: rateLimitIdentity({
      actor: input.actor,
      request: input.request,
      token: input.token,
    }),
    limit: input.limit,
    scope: input.scope,
    windowMs: input.windowMs,
  });
}
