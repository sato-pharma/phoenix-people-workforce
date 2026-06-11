import { NextResponse } from "next/server";

import { isForbiddenError, resolveAccessContext } from "@/lib/auth/server";
import { deleteCompanyCalendarEvent, updateCompanyCalendarEvent } from "@/lib/calendar/service";
import type { CompanyCalendarEventInput } from "@/lib/calendar/logic";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message : fallback;
  const forbidden = isForbiddenError(error) || message.toLowerCase().startsWith("forbidden:");
  return NextResponse.json(
    { error: forbidden ? "forbidden" : "calendar_error", message, success: false },
    { status: forbidden ? 403 : 400 },
  );
}

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const body = (await request.json().catch(() => ({}))) as CompanyCalendarEventInput;
    const result = await updateCompanyCalendarEvent(access, id, body);
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return jsonError(error, "Unable to update the event.");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const csrfError = assertSameOriginMutation(request);
    if (csrfError) return csrfError;
    const access = await resolveAccessContext(request);
    const { id } = await context.params;
    const result = await deleteCompanyCalendarEvent(access, id);
    return NextResponse.json({ data: result, success: true });
  } catch (error) {
    return jsonError(error, "Unable to delete the event.");
  }
}
