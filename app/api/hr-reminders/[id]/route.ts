import { NextResponse, type NextRequest } from "next/server";

import { assertPermission } from "@/lib/auth/permissions";
import { resolveAccessContext } from "@/lib/auth/server";
import { reminderErrorResponse } from "@/lib/hr-reminders/http";
import { deleteReminder, updateReminder } from "@/lib/hr-reminders/service";
import { assertSameOriginMutation } from "@/lib/security/api-csrf";
import { assertApiRateLimit, rateLimitIdentity } from "@/lib/security/api-rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Edit a reminder, or tick it off and back. Only its author may — the service refuses anyone else,
// the HR Manager included: he reads and comments on everything, and a teammate's note stays in her words.
export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_reminders", "update");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 120,
      scope: "hr-reminders:update",
      windowMs: 60_000,
    });

    const { id } = await context.params;
    const body = await request.json().catch(() => null);
    const reminder = await updateReminder(access, id, body);
    return NextResponse.json({ ok: true, reminder });
  } catch (error) {
    return reminderErrorResponse(error, "Failed to update the reminder.");
  }
}

// Soft delete: the reminder leaves every list, and the row with its conversation stays on record.
export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const csrf = assertSameOriginMutation(request);
    if (csrf) return csrf;

    const access = await resolveAccessContext(request);
    await assertPermission(access, "hr_reminders", "delete");
    await assertApiRateLimit({
      identifier: rateLimitIdentity({ actor: access.loginId ?? access.hrId, request }),
      limit: 60,
      scope: "hr-reminders:delete",
      windowMs: 60_000,
    });

    const { id } = await context.params;
    await deleteReminder(access, id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return reminderErrorResponse(error, "Failed to remove the reminder.");
  }
}
