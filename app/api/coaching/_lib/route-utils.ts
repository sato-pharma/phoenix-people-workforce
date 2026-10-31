import { NextResponse } from "next/server";

import { resolveAccessContext, isForbiddenError } from "@/lib/auth/server";
import {
  canAccess,
  canManageCoachingReports,
  type AccessContext,
  type PermissionAction,
} from "@/lib/auth/permissions";
import { coachingMaxItemScore, coachingMinItemScore, coachingScoreItems } from "@/lib/coaching/constants";
import type {
  CoachingPerformanceZone,
  CoachingReportFilters,
  CoachingReportMutationInput,
  CoachingReportStatus,
  CoachingScoreInput,
} from "@/lib/coaching/types";
import { coachingErrorMessage } from "@/lib/coaching/service";
import { CoachingOldFormRetiredError } from "@/lib/coaching/old-form-retired";

export class CoachingApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export async function requireCoachingAccess(request: Request): Promise<AccessContext> {
  const access = await resolveAccessContext(request);
  if (!access.loginId && !access.hrId) {
    throw new CoachingApiError("unauthenticated", "Not authenticated.", 401);
  }
  return access;
}

export async function requireCoachingPermission(request: Request, action: PermissionAction = "read") {
  const access = await requireCoachingAccess(request);
  if (!await canAccess(access, "coaching", action)) {
    throw new CoachingApiError("forbidden", `Forbidden: ${access.role} cannot ${action} coaching.`, 403);
  }
  return access;
}

export async function requireCoachingManagementPermission(
  request: Request,
  action: Extract<PermissionAction, "create" | "update">,
) {
  const access = await requireCoachingAccess(request);
  if (!canManageCoachingReports(access)) {
    throw new CoachingApiError(
      "forbidden",
      "Only Training Manager or Super Admin can create, update, or submit coaching reports.",
      403,
    );
  }
  if (!await canAccess(access, "coaching", action)) {
    throw new CoachingApiError("forbidden", `Forbidden: ${access.role} cannot ${action} coaching.`, 403);
  }
  return access;
}

export async function readJsonObject(request: Request, options: { allowEmpty?: boolean } = {}) {
  const text = await request.text();
  if (!text.trim()) {
    if (options.allowEmpty) return {};
    throw new CoachingApiError("invalid_json", "Request body is required.", 400);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new CoachingApiError("invalid_json", "Request body must be valid JSON.", 400);
  }

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new CoachingApiError("invalid_json", "Request body must be a JSON object.", 400);
  }

  return payload as Record<string, unknown>;
}

function requiredString(payload: Record<string, unknown>, key: string) {
  const value = payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new CoachingApiError("validation_error", `${key} is required.`, 400);
  }
  return value.trim();
}

function optionalString(payload: Record<string, unknown>, key: string) {
  if (!(key in payload)) return undefined;
  const value = payload[key];
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new CoachingApiError("validation_error", `${key} must be a string.`, 400);
  }
  return value.trim();
}

function optionalScoreInput(payload: Record<string, unknown>) {
  if (!("scores" in payload) || payload.scores === null || payload.scores === undefined) {
    return undefined;
  }

  const scores = payload.scores;
  if (!scores || typeof scores !== "object" || Array.isArray(scores)) {
    throw new CoachingApiError("validation_error", "scores must be an object keyed by coaching score item.", 400);
  }

  const rawScores = scores as Record<string, unknown>;
  const expectedKeys = new Set(coachingScoreItems.map((item) => item.key));
  const rawKeys = Object.keys(rawScores);
  if (rawKeys.length !== coachingScoreItems.length) {
    throw new CoachingApiError("validation_error", "Exactly 20 coaching scores are required.", 400);
  }

  for (const key of rawKeys) {
    if (!expectedKeys.has(key as never)) {
      throw new CoachingApiError("validation_error", `Unknown coaching score item "${key}".`, 400);
    }
  }

  const normalized: CoachingScoreInput = {};
  for (const item of coachingScoreItems) {
    const rawScore = rawScores[item.key];
    const scoreValue = rawScore && typeof rawScore === "object" && !Array.isArray(rawScore)
      ? (rawScore as { score?: unknown }).score
      : rawScore;
    const score = Number(scoreValue);
    if (!Number.isInteger(score) || score < coachingMinItemScore || score > coachingMaxItemScore) {
      throw new CoachingApiError(
        "validation_error",
        `Invalid coaching score for "${item.key}". Score must be an integer from ${coachingMinItemScore} to ${coachingMaxItemScore}.`,
        400,
      );
    }

    if (rawScore && typeof rawScore === "object" && !Array.isArray(rawScore)) {
      const scoreItem = rawScore as {
        areaToBeImproved?: unknown;
        score?: unknown;
        strengthPoint?: unknown;
      };
      for (const noteKey of ["areaToBeImproved", "strengthPoint"] as const) {
        const noteValue = scoreItem[noteKey];
        if (noteValue !== undefined && noteValue !== null && typeof noteValue !== "string") {
          throw new CoachingApiError("validation_error", `${noteKey} must be a string.`, 400);
        }
      }
      normalized[item.key] = {
        areaToBeImproved: typeof scoreItem.areaToBeImproved === "string" ? scoreItem.areaToBeImproved.trim() || null : null,
        score,
        strengthPoint: typeof scoreItem.strengthPoint === "string" ? scoreItem.strengthPoint.trim() || null : null,
      };
    } else {
      normalized[item.key] = score;
    }
  }

  return normalized;
}

export function createReportInput(payload: Record<string, unknown>) {
  return {
    areaOfDevelopment: optionalString(payload, "areaOfDevelopment"),
    coachingDate: requiredString(payload, "coachingDate"),
    generalRemarks: optionalString(payload, "generalRemarks"),
    medicalRepHrId: requiredString(payload, "medicalRepHrId"),
    scores: optionalScoreInput(payload),
    strengthPoints: optionalString(payload, "strengthPoints"),
  };
}

export function mutationInput(payload: Record<string, unknown>): CoachingReportMutationInput {
  const input: CoachingReportMutationInput = {};
  const coachingDate = optionalString(payload, "coachingDate");
  const areaOfDevelopment = optionalString(payload, "areaOfDevelopment");
  const strengthPoints = optionalString(payload, "strengthPoints");
  const generalRemarks = optionalString(payload, "generalRemarks");
  const scores = optionalScoreInput(payload);

  if (coachingDate !== undefined) input.coachingDate = coachingDate;
  if (areaOfDevelopment !== undefined) input.areaOfDevelopment = areaOfDevelopment;
  if (strengthPoints !== undefined) input.strengthPoints = strengthPoints;
  if (generalRemarks !== undefined) input.generalRemarks = generalRemarks;
  if (scores !== undefined) input.scores = scores;

  return input;
}

export function submitInput(payload: Record<string, unknown>) {
  const input = mutationInput(payload);
  return {
    areaOfDevelopment: input.areaOfDevelopment,
    generalRemarks: input.generalRemarks,
    scores: input.scores,
    strengthPoints: input.strengthPoints,
  };
}

function optionalSearchParam(searchParams: URLSearchParams, key: string) {
  const value = searchParams.get(key)?.trim();
  return value || undefined;
}

function optionalNumericParam(searchParams: URLSearchParams, key: string) {
  const value = optionalSearchParam(searchParams, key);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number)) {
    throw new CoachingApiError("validation_error", `${key} must be an integer.`, 400);
  }
  return number;
}

export function filtersFromRequest(request: Request): CoachingReportFilters {
  const searchParams = new URL(request.url).searchParams;
  return {
    areaId: optionalNumericParam(searchParams, "areaId"),
    coachHrId: optionalSearchParam(searchParams, "coachHrId"),
    dateFrom: optionalSearchParam(searchParams, "dateFrom"),
    dateTo: optionalSearchParam(searchParams, "dateTo"),
    lineId: optionalNumericParam(searchParams, "lineId"),
    limit: optionalNumericParam(searchParams, "limit"),
    medicalRepHrId: optionalSearchParam(searchParams, "medicalRepHrId"),
    month: optionalNumericParam(searchParams, "month"),
    page: optionalNumericParam(searchParams, "page"),
    performanceZone: optionalSearchParam(searchParams, "performanceZone") as CoachingPerformanceZone | undefined,
    quarter: optionalNumericParam(searchParams, "quarter"),
    status: optionalSearchParam(searchParams, "status") as CoachingReportStatus | undefined,
    teamId: optionalNumericParam(searchParams, "teamId"),
    year: optionalNumericParam(searchParams, "year"),
  };
}

export function jsonError(error: unknown, fallbackMessage: string) {
  if (error instanceof CoachingApiError) {
    return NextResponse.json({ error: error.code, message: error.message }, { status: error.status });
  }
  // The old coaching form takes no new reports (owner, 2026-10-31).
  if (error instanceof CoachingOldFormRetiredError) {
    return NextResponse.json({ error: "retired", message: error.message }, { status: 410 });
  }

  const message = coachingErrorMessage(error) || fallbackMessage;
  const lower = message.toLowerCase();

  if (isForbiddenError(error) || lower.startsWith("forbidden:")) {
    return NextResponse.json({ error: "forbidden", message }, { status: 403 });
  }
  if (lower.includes("not authenticated")) {
    return NextResponse.json({ error: "unauthenticated", message }, { status: 401 });
  }
  if (lower.includes("linked employee hr_id")) {
    return NextResponse.json({ error: "forbidden", message }, { status: 403 });
  }
  if (lower.includes("not found")) {
    return NextResponse.json({ error: "not_found", message }, { status: 404 });
  }
  if (lower.includes("already acknowledged") || lower.includes("only draft") || lower.includes("only submitted")) {
    return NextResponse.json({ error: "conflict", message }, { status: 409 });
  }
  if (
    lower.includes("required") ||
    lower.includes("invalid") ||
    lower.includes("missing") ||
    lower.includes("exactly 20") ||
    lower.includes("from 0 to 5")
  ) {
    return NextResponse.json({ error: "validation_error", message }, { status: 400 });
  }

  return NextResponse.json({ error: "server_error", message }, { status: 500 });
}
