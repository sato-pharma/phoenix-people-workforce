import { NextResponse, type NextRequest } from "next/server";

import { writeAuditLog } from "@/lib/admin/audit";
import { unauthenticatedSessionResponse } from "@/lib/auth/api-session-response";
import { assertSystemAdministratorWorkspaceAccess } from "@/lib/auth/permissions";
import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { clientSafeErrorMessage } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { databaseRefusal, loadOccurrenceDetail, refusalHttpStatus } from "@/lib/system-audit/occurrence-detail";
import { auditActorId, isAuditId, isSystemAuditQueryError, parseTriage } from "@/lib/system-audit/page-query";
import { triageOccurrence } from "@/lib/system-audit/repository";
import { SYSTEM_AUDIT_STATUS_LABELS } from "@/lib/system-audit/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET  /api/admin/system-audit/occurrences/[id] — everything the row drawer shows.
 * POST /api/admin/system-audit/occurrences/[id] — mark THIS occurrence no defect / unknown with a
 *      reason, or clear the mark ({ override: null }). One audit_logs row per change.
 * Super Admin only.
 */
export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const access = await resolveAccessContext(request);
    const expired = unauthenticatedSessionResponse(access);
    if (expired) return expired;
    assertSystemAdministratorWorkspaceAccess(access, "the System Error & Data Integrity Audit");

    const { id } = await context.params;
    if (!isAuditId(id)) {
      return NextResponse.json({ error: "invalid_request", message: "That occurrence id is not valid." }, { status: 400 });
    }
    const detail = await loadOccurrenceDetail(id);
    if (!detail) {
      return NextResponse.json({ error: "not_found", message: "No occurrence has that id." }, { status: 404 });
    }
    return NextResponse.json({ detail }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (isForbiddenError(error)) {
      return NextResponse.json(
        { error: "forbidden", message: clientSafeErrorMessage(error, "Forbidden.") },
        { status: 403 },
      );
    }
    const reason = clientSafeErrorMessage(error, "the ledger did not answer");
    return NextResponse.json({ error: "unavailable", message: `Unavailable — ${reason}` }, { status: 500 });
  }
}

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
      return NextResponse.json({ error: "invalid_request", message: "That occurrence id is not valid." }, { status: 400 });
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
    const triage = parseTriage(body);

    try {
      await triageOccurrence({ occurrenceId: id, override: triage.override, actor, reason: triage.reason });
    } catch (error) {
      // The database function's own sentence, verbatim.
      const refusal = databaseRefusal(error);
      return NextResponse.json(
        { error: "refused", message: refusal.message || "The change to this occurrence was refused." },
        { status: refusalHttpStatus(refusal.code) },
      );
    }

    const label = triage.override ? SYSTEM_AUDIT_STATUS_LABELS[triage.override] : "no override (follows its issue)";
    await writeAuditLog({
      actorLoginId: access.loginId ?? null,
      entityId: id,
      entityType: "system_audit_triage",
      newValues: { actor, override: triage.override, reason: triage.reason },
      summary: `System audit occurrence ${id.slice(0, 8)} marked ${label}${triage.reason ? ` — ${triage.reason}` : ""}.`,
    });

    return NextResponse.json({ ok: true, override: triage.override });
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
      { error: "server_error", message: clientSafeErrorMessage(error, "The change could not be saved.") },
      { status: 500 },
    );
  }
}
