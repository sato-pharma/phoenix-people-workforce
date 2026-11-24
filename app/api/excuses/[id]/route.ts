import { NextResponse } from "next/server";

import { assertSignedIn } from "@/lib/auth/require-signed-in";
import { resolveAccessContext } from "@/lib/auth/server";
import {
  deleteExcuseRequestAsAdmin,
  excuseErrorMessage,
  isExcusesSchemaMissing,
  updateExcuseRequestAsAdmin,
} from "@/lib/excuses/service";
import { ApiError } from "@/lib/http/api-errors";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The Super Admin's Admin controls on one excuse request (owner, 2026-11-24): PATCH edits it, DELETE
// removes it. Who may is decided in the service (canManageExcuseRecords — the Super Admin or a
// system actor), which writes the required audit row. Neither tells anybody, and neither is a
// manager's decision: that stays POST /api/excuses/:id/decision.

function failure(error: unknown, fallback: string, code: string) {
  const message = isExcusesSchemaMissing(error)
    ? "Excuse database tables are not deployed yet."
    : excuseErrorMessage(error) || fallback;
  const lower = message.toLowerCase();
  const status =
    error instanceof ApiError
      ? error.status
      : lower.startsWith("forbidden") ? 403 : lower.includes("was not found") ? 404 : 400;
  return NextResponse.json({ error: code, message, success: false }, { status });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const result = await updateExcuseRequestAsAdmin(access, {
      excuseDate: body.excuseDate,
      excuseType: body.excuseType,
      reply: body.reply,
      requestId: id,
      status: body.status,
    });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return failure(error, "Unable to save the excuse request.", "excuse_admin_update_failed");
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    assertSignedIn(access);
    const result = await deleteExcuseRequestAsAdmin(access, id);
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return failure(error, "Unable to delete the excuse request.", "excuse_admin_delete_failed");
  }
}
