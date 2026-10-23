import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { databaseRefusal, refusalHttpStatus } from "@/lib/system-audit/occurrence-detail";
import { auditActorId, isAuditId, isSystemAuditQueryError, parseStatusChange } from "@/lib/system-audit/page-query";
import { transitionIssueStatus } from "@/lib/system-audit/repository";
import { SYSTEM_AUDIT_STATUS_LABELS } from "@/lib/system-audit/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/admin/system-audit/issues/[id]/status — the Super Admin changes an issue's status.
 *
 * Body: { to, reason?, fixSha?, occurrenceId? }. Only the human statuses (investigating, not fixed,
 * fix implemented, no defect, unknown); FIX IMPLEMENTED needs the full 40-character commit and the
 * database function refuses one that is not a released build; NO DEFECT and UNKNOWN need a reason.
 * The function's own refusal reaches the person word for word. One audit_logs row per change.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the System Error & Data Integrity Audit");

    const { id } = await context.params;
    if (!isAuditId(id)) {
      return NextResponse.json({ error: "invalid_request", message: "That issue id is not valid." }, { status: 400 });
    }
    const actor = auditActorId(access);
    if (!actor) {
      return NextResponse.json(
        { error: "invalid_request", message: "Your account carries no HR ID or login to record this change under." },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_request", message: "The request body is not valid JSON." }, { status: 400 });
    }
    const change = parseStatusChange(body);

    let result: Awaited<ReturnType<typeof transitionIssueStatus>>;
    try {
      result = await transitionIssueStatus({
        issueId: id,
        to: change.to,
        actor,
        reason: change.reason,
        fixSha: change.fixSha,
        occurrenceId: change.occurrenceId,
      });
    } catch (error) {
      // The database function's own sentence, verbatim ("commit … is not a released build").
      const refusal = databaseRefusal(error);
      return NextResponse.json(
        { error: "refused", message: refusal.message || "The status change was refused." },
        { status: refusalHttpStatus(refusal.code) },
      );
    }

    const fromLabel = SYSTEM_AUDIT_STATUS_LABELS[result.from] ?? result.from;
    const toLabel = SYSTEM_AUDIT_STATUS_LABELS[result.to] ?? result.to;
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: id,
      entityType: "system_audit_status",
      newValues: {
        actor,
        fixId: result.fixId,
        fixSha: change.fixSha,
        occurrenceId: change.occurrenceId,
        reason: change.reason,
        status: result.to,
      },
      oldValues: { status: result.from },
      summary: `System audit issue status changed from ${fromLabel} to ${toLabel}${change.reason ? ` — ${change.reason}` : ""}.`,
    });

    return NextResponse.json({ ok: true, from: result.from, to: result.to, fixId: result.fixId });
  } catch (error) {
    if (isSystemAuditQueryError(error)) {
      return NextResponse.json({ error: "invalid_request", message: error.message }, { status: 400 });
    }
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    return NextResponse.json(
      { error: "server_error", message: clientSafeErrorMessage(error, "The status change could not be saved.") },
      { status: 500 },
    );
  }
}
