import { timingSafeEqual } from "node:crypto";

import { NextResponse } from "next/server";

import { ApiError, toApiError, unauthorizedError, validationError } from "@/lib/http/api-errors";
import { ingestSyntheticJourneyReport, type JourneyResult } from "@/lib/synthetic-journeys/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: Request): boolean {
  const expected = process.env.SYNTHETIC_INGEST_TOKEN?.trim();
  if (!expected) {
    throw new ApiError(500, "synthetic_ingest_token_missing", "SYNTHETIC_INGEST_TOKEN is required.");
  }
  const authorization = request.headers.get("authorization") ?? "";
  const actual = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
  if (!actual) return false;
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function extractJourneyResults(payload: unknown): JourneyResult[] {
  if (Array.isArray(payload)) return payload as JourneyResult[];
  if (payload && typeof payload === "object" && Array.isArray((payload as { journeyResults?: unknown }).journeyResults)) {
    return (payload as { journeyResults: JourneyResult[] }).journeyResults;
  }
  if (payload && typeof payload === "object" && Array.isArray((payload as { results?: unknown }).results)) {
    return (payload as { results: JourneyResult[] }).results;
  }
  throw validationError("Request body must be a JSON array of journey results, or an object with a journeyResults/results array.");
}

export async function POST(request: Request) {
  try {
    if (!isAuthorized(request)) {
      throw unauthorizedError("Synthetic ingest token is invalid.");
    }
    const body: unknown = await request.json();
    const journeyResults = extractJourneyResults(body);
    const bodyObject = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const meta = {
      baseUrl:
        (typeof bodyObject.baseUrl === "string" ? bodyObject.baseUrl : process.env.SYNTHETIC_BASE_URL) ?? "",
      startedAt: typeof bodyObject.startedAt === "string" ? bodyObject.startedAt : undefined,
      finishedAt: typeof bodyObject.finishedAt === "string" ? bodyObject.finishedAt : undefined,
      createdBy: "api-ingest",
    };
    const run = await ingestSyntheticJourneyReport(journeyResults, meta);
    return NextResponse.json({ run }, { status: 201 });
  } catch (error) {
    const apiError = toApiError(error, "Synthetic journey ingestion failed.");
    return NextResponse.json({ error: apiError.code, message: apiError.message }, { status: apiError.status });
  }
}
