import { NextResponse } from "next/server";

import { resolveEmployeeIdentityId, type AccessContext } from "@/lib/auth/permissions";
import { isForbiddenError } from "@/lib/auth/server";
import { logError } from "@/lib/observability/log";
import { isPayrollConflictError } from "@/lib/payroll/errors";

import { CopilotError } from "./service.ts";

/**
 * Payroll Copilot is restricted to CEO + Super Admin. Enforced on the server for
 * every route (sidebar visibility is UX only, never the security boundary).
 */
const ALLOWED_ROLES = new Set(["CEO", "Super Admin"]);

export function assertCopilotAccess(access: AccessContext): void {
  if (!ALLOWED_ROLES.has(access.role)) {
    // "Forbidden:" prefix is what isForbiddenError keys on → 403.
    throw new Error("Forbidden: Payroll Copilot is restricted to CEO and Super Admin.");
  }
}

export function resolveCopilotActor(access: AccessContext): string {
  return resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
}

export function copilotErrorResponse(error: unknown): NextResponse {
  const message = error instanceof Error ? error.message : "Payroll Copilot request failed.";
  if (isForbiddenError(error)) {
    return NextResponse.json({ error: "forbidden", message }, { status: 403 });
  }
  if (error instanceof CopilotError) {
    return NextResponse.json({ error: "copilot_error", message }, { status: error.status });
  }
  if (isPayrollConflictError(error)) {
    return NextResponse.json({ error: "payroll_conflict", message }, { status: 409 });
  }
  logError("Payroll copilot request failed", {
    labels: { event: "copilot_request_failed" },
    error,
  });
  return NextResponse.json({ error: "copilot_failed", message }, { status: 500 });
}
