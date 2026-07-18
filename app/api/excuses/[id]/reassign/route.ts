import { NextResponse } from "next/server";

import { resolveAccessContext } from "@/lib/auth/server";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import {
  excuseErrorMessage,
  isExcusesSchemaMissing,
  reassignExcuseManager,
} from "@/lib/excuses/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// HR / Super Admin re-routes a stuck excuse (pending_manager) to a new active manager when the
// assigned manager resigned before deciding. Authorization + status guards live in the service
// (reassignExcuseManager, Super-Admin/system-actor only): this only changes WHO the assigned
// manager is; it never decides the excuse in place.
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const { id } = await params;
    const access = await resolveAccessContext(request);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const newManagerHrId = typeof body.newManagerHrId === "string" ? body.newManagerHrId.trim() : "";
    if (!newManagerHrId) {
      return NextResponse.json(
        { error: "invalid_manager", message: "A new manager is required.", success: false },
        { status: 400 },
      );
    }
    const result = await reassignExcuseManager(access, { newManagerHrId, requestId: id });
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    const message = isExcusesSchemaMissing(error)
      ? "Excuse database tables are not deployed yet."
      : excuseErrorMessage(error) || "Unable to reassign excuse approver.";
    const lower = message.toLowerCase();
    const status = lower.startsWith("forbidden") ? 403 : lower.includes("was not found") ? 404 : 400;
    return NextResponse.json({ error: "reassign_failed", message, success: false }, { status });
  }
}
