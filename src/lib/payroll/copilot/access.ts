import { hrIdForStorage } from "@/lib/hr-id";
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

/**
 * Who the Payroll Copilot records as having acted.
 *
 * This is the FOURTH copy of one expression in this repository — outstation's `approvedBy`,
 * automated payroll's `actorId`, the resignation upload route, and here. All four have the same
 * shape and the same two traps, so they get the same treatment:
 *
 *   1. `resolveEmployeeIdentityId` returns the LOWERCASE comparison key. Storing it verbatim is
 *      what splits one person into two in any per-actor report, and it is invisible until
 *      somebody writes a plain `.eq` against the column.
 *   2. The fallbacks are NOT hr ids. `system` means no session did this, and a login id names
 *      no employee. Canonicalising the whole expression — the obvious one-line repair — stores
 *      SYSTEM and DEV.PREVIEW, and every screen that reads the column then names a shouty
 *      non-person as the actor.
 *
 * So only the HR-id branch is canonicalised, and the chain is otherwise untouched. Six routes
 * flow through here into payroll_copilot_runs, payroll_copilot_adjustments and
 * payroll_copilot_vacation_settlements.
 */
export function resolveCopilotActor(access: AccessContext): string {
  return hrIdForStorage(access.hrId) ?? resolveEmployeeIdentityId(access) ?? access.loginId ?? "system";
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
