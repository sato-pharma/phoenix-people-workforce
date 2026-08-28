// Shared helpers for the recruitment API routes (not a route — underscore folder).

import { NextResponse } from "next/server";

import {
  assertPermission,
  type PermissionAction,
  type PermissionResource,
} from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import type { SentForPositionInput } from "@/lib/recruitment/candidates";
import { unauthorizedError, toApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export { assertSameOriginMutation };

export async function requireRecruitmentAccess(
  request: Request,
  resource: PermissionResource,
  action: PermissionAction = "read",
) {
  const access = await resolveAccessContext(request);
  if (!access.loginId && !access.hrId) {
    throw unauthorizedError();
  }
  await assertPermission(access, resource, action);
  return access;
}

export function recruitmentApiError(error: unknown, fallback: string) {
  if (isForbiddenError(error)) {
    return NextResponse.json(
      { error: "forbidden", message: error instanceof Error ? error.message : "Forbidden.", success: false },
      { status: 403 },
    );
  }
  const apiError = toApiError(error, fallback);
  let status = apiError.status;
  let code = apiError.code;
  if (status === 500 && error instanceof Error) {
    const normalized = error.message.toLowerCase();
    if (normalized.includes("not found")) {
      status = 404;
      code = "not_found";
    } else if (normalized.includes("too many")) {
      status = 429;
      code = "rate_limited";
    } else if (
      normalized.includes("already has") ||
      normalized.includes("already exists") ||
      normalized.includes("no longer accepting")
    ) {
      status = 409;
      code = "conflict";
    }
  }
  return NextResponse.json({ error: code, message: apiError.message, success: false }, { status });
}

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {};
  }
  return body as Record<string, unknown>;
}

// Loose body coercers for the route boundary (services re-coerce defensively).
export function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function bool(value: unknown): boolean | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "boolean") return value;
  return null;
}

/**
 * The position a candidate is being sent FOR, as it arrives in a request body.
 *
 * Both notify-manager routes read it identically, so it is read in one place — the single-candidate
 * and multi-candidate paths already share a service and must not start disagreeing at the boundary.
 * Nothing is validated here beyond shape: resolveSentForPosition re-reads the vacancy server-side
 * and discards the posted text, which is where the real check belongs.
 *
 * Returns null when the body carries no position at all — a send without one is legitimate, and was
 * the only kind that existed before 2026-08-28.
 */
export function positionInput(body: Record<string, unknown>): SentForPositionInput | null {
  const vacancyId = num(body.vacancyId);
  const jobTitle = str(body.positionJobTitle);
  const areaName = str(body.positionAreaName);
  const lineName = str(body.positionLineName);
  if (vacancyId === null && !jobTitle && !areaName && !lineName) return null;
  return { areaName, jobTitle, lineName, vacancyId };
}
